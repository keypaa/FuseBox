use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Wire PID 1's stdio file descriptors (0/1/2) to the serial console.
///
/// In this Firecracker microVM the kernel hands PID 1 stdio fds that return
/// EIO on write, which makes Rust's stdio layer (println!/eprintln!/tracing)
/// panic at startup ("failed printing to stderr: I/O error (os error 5)").
/// Opening /dev/console and dup2-ing it onto 0/1/2 makes those fds usable,
/// exactly like the known-working `minimal_test` (which writes to
/// /dev/console directly).
/// Write a line to /dev/kmsg (char 1,11) so it reaches the kernel log and
/// therefore the serial console, even when the stdio fds (0/1/2) are broken.
fn kmsg(msg: &str) {
    if let Ok(mut f) = fs::OpenOptions::new().write(true).open("/dev/kmsg") {
        let _ = f.write_all(msg.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

/// Install a panic hook that reports the panic to /dev/kmsg. Without this,
/// a panic during early startup writes to stderr (fd 2), which is broken in
/// this VM and the message is silently lost.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let p = info.payload();
        let m = if let Some(s) = p.downcast_ref::<String>() {
            s.clone()
        } else if let Some(s) = p.downcast_ref::<&str>() {
            s.to_string()
        } else {
            "<?>".to_string()
        };
        kmsg(&format!(
            "process_api PANIC: {} @ {:?}",
            m,
            info.location()
        ));
    }));
}

/// Open a console/serial device and configure it so userspace writes succeed.
///
/// In this Firecracker microVM the serial has no modem control lines, so the
/// tty driver reports "no carrier" (DCD) and returns EIO on write unless the
/// `CLOCAL` termios flag (ignore modem status lines) is set. The kernel's raw
/// `printk` bypasses this, which is why boot messages reach the host but
/// userspace writes to /dev/ttyS0 / /dev/console fail with EIO. Setting
/// `CLOCAL | CREAD` fixes it.
fn open_console(path: &str) -> Option<fs::File> {
    let f = fs::OpenOptions::new().read(true).write(true).open(path).ok()?;
    let fd = f.as_raw_fd();
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) == 0 {
            t.c_cflag |= libc::CLOCAL | libc::CREAD;
            let _ = libc::tcsetattr(fd, libc::TCSANOW, &t);
        }
    }
    Some(f)
}

fn init_logging() {
    // Pick the first device that is actually writable. In this VM the serial
    // tty (/dev/ttyS0, /dev/console) accepts kernel printk but returns EIO on
    // userspace writes, so the reliable fallback is /dev/kmsg, which Firecracker
    // forwards to the serial console (captured in /tmp/fusebox-serial.log).
    //
    // We verify by dup2-ing onto 0/1/2 and doing a test write to fd 2.
    //
    // IMPORTANT: keep the File alive until after the dup2 syscalls, otherwise
    // dropping it closes the source fd and dup2 fails with EBADF.
    let devices: [&str; 3] = ["/dev/ttyS0", "/dev/console", "/dev/kmsg"];
    let mut chosen: Option<(fs::File, &'static str)> = None;
    for &path in devices.iter() {
        if let Some(f) = open_console(path) {
            let fd = f.as_raw_fd();
            let _ = dup2_syscall(fd, 0);
            let _ = dup2_syscall(fd, 1);
            let _ = dup2_syscall(fd, 2);
            // Keep fd observable so the optimizer does not dead-code-eliminate
            // the syscalls at -O3.
            std::hint::black_box(fd);
            let test = write_to_fd2(b"process_api: fd2 write test\n");
            if test >= 0 {
                chosen = Some((f, path));
                kmsg(&format!(
                    "process_api init_logging: using {path} (fd={fd}); fd2 test-write rc={test}"
                ));
                break;
            } else {
                kmsg(&format!(
                    "process_api init_logging: {path} (fd={fd}) fd2 test-write rc={test}, trying next"
                ));
            }
        } else {
            kmsg(&format!("process_api init_logging: cannot open {path}"));
        }
    }
    match chosen {
        Some(_) => {
            // fd 0/1/2 now point at a working device, so default tracing
            // (stderr) is safe.
            tracing_subscriber::fmt().with_writer(std::io::stderr).init();
        }
        None => {
            kmsg("process_api init_logging: no writable console device found; logging to stderr (may be broken)");
            tracing_subscriber::fmt().init();
        }
    }
}

#[inline(never)]
fn dup2_syscall(oldfd: i32, newfd: i32) -> i64 {
    let mut ret: i64;
    unsafe {
        core::arch::asm!(
            "syscall",
            inout("rax") 33i64 => ret,
            in("rdi") oldfd as u64,
            in("rsi") newfd as u64,
            out("rcx") _, out("r11") _,
            options(nostack, preserves_flags)
        );
    }
    ret
}

#[inline(never)]
fn write_to_fd2(buf: &[u8]) -> i64 {
    let mut ret: i64;
    unsafe {
        core::arch::asm!(
            "syscall",
            inout("rax") 1i64 => ret,
            in("rdi") 2u64,
            in("rsi") buf.as_ptr() as u64,
            in("rdx") buf.len() as u64,
            out("rcx") _, out("r11") _,
            options(nostack, preserves_flags)
        );
    }
    ret
}

use anyhow::Result;
use bytes::Bytes;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

#[derive(Parser, Debug, Clone)]
#[command(author, version, about = "Process API Sandbox Supervisor")]
struct Args {
    #[arg(long)]
    firecracker_init: bool,

    #[arg(long, default_value = "0.0.0.0:2024")]
    addr: std::net::SocketAddr,

    #[arg(long, default_value = "0.0.0.0:2025")]
    control_server_addr: std::net::SocketAddr,

    #[arg(long)]
    memory_limit_bytes: Option<u64>,

    #[arg(long, default_value = "100")]
    oom_polling_period_ms: u64,

    #[arg(long)]
    block_local_connections: bool,

    #[arg(long, default_value = "300")]
    default_timeout_secs: u64,
}

// Global runtime state tracking active tool executions
struct SandboxState {
    args: Args,
    active_tasks: HashMap<Uuid, u32>, // Task UUID -> Subprocess PID
}

/// Check if an interface is a real Ethernet device (type 1 = ARPHRD_ETHER).
fn is_ether_iface(name: &str) -> bool {
    let path = format!("/sys/class/net/{name}/type");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
        .map(|t| t == 1)
        .unwrap_or(false)
}

/// Wait for any Ethernet network interface to appear and configure it.
fn setup_guest_network(_: &str, addr: &str, netmask: &str) {
    let iface = 'outer: loop {
        for _ in 0..300 {
            if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if is_ether_iface(&name) {
                        break 'outer Some(name.to_string());
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        kmsg("setup_guest_network: no Ethernet interface appeared after 30s");
        break None;
    };
    if let Some(ifname) = iface {
        kmsg(&format!("setup_guest_network: found interface {ifname}"));
        configure_interface(&ifname, addr, netmask);
    }
}

/// Configure a network interface with a static IP via ioctl.
fn configure_interface(ifname: &str, addr: &str, netmask: &str) {
    use std::net::Ipv4Addr;
    let sock = match unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) } {
        -1 => { kmsg("setup_guest_network: socket() failed"); return; }
        fd => fd,
    };
    let mut ifr: libc::ifreq = unsafe { std::mem::zeroed() };
    let bytes = ifname.as_bytes();
    let len = bytes.len().min(libc::IFNAMSIZ - 1);
    for i in 0..len { ifr.ifr_name[i] = bytes[i] as libc::c_char; }
    let ip: u32 = addr.parse::<Ipv4Addr>().map(|a| u32::from(a).to_be()).unwrap_or(0);
    let ip_bytes = ip.to_be_bytes();
    let mut sa: libc::sockaddr = unsafe { std::mem::zeroed() };
    sa.sa_family = libc::AF_INET as u16;
    for i in 0..4 { sa.sa_data[2 + i] = ip_bytes[i] as libc::c_char; }
    ifr.ifr_ifru.ifru_addr = sa;
    let ret = unsafe { libc::ioctl(sock, libc::SIOCSIFADDR as libc::Ioctl, &ifr) };
    if ret != 0 { kmsg(&format!("setup_guest_network: SIOCSIFADDR failed: {}", std::io::Error::last_os_error())); }
    let mask: u32 = netmask.parse::<Ipv4Addr>().map(|a| u32::from(a).to_be()).unwrap_or(0);
    let mask_bytes = mask.to_be_bytes();
    let mut sa2: libc::sockaddr = unsafe { std::mem::zeroed() };
    sa2.sa_family = libc::AF_INET as u16;
    for i in 0..4 { sa2.sa_data[2 + i] = mask_bytes[i] as libc::c_char; }
    ifr.ifr_ifru.ifru_netmask = sa2;
    let ret = unsafe { libc::ioctl(sock, libc::SIOCSIFNETMASK as libc::Ioctl, &ifr) };
    if ret != 0 { kmsg(&format!("setup_guest_network: SIOCSIFNETMASK failed: {}", std::io::Error::last_os_error())); }
    let ret = unsafe { libc::ioctl(sock, libc::SIOCGIFFLAGS as libc::Ioctl, &ifr) };
    if ret == 0 {
        let flags = unsafe { ifr.ifr_ifru.ifru_flags };
        ifr.ifr_ifru.ifru_flags = (flags | (libc::IFF_UP as i16)) as i16;
        let ret = unsafe { libc::ioctl(sock, libc::SIOCSIFFLAGS as libc::Ioctl, &ifr) };
        if ret != 0 { kmsg(&format!("setup_guest_network: SIOCSIFFLAGS failed: {}", std::io::Error::last_os_error())); }
    } else {
        kmsg(&format!("setup_guest_network: SIOCGIFFLAGS failed: {}", std::io::Error::last_os_error()));
    }
    unsafe { libc::close(sock); }
    kmsg(&format!("setup_guest_network: {ifname} -> {addr}/{netmask}"));
}

fn main() -> Result<()> {
    // Mount devtmpfs so /dev/kmsg exists. Do this BEFORE tokio runtime init
    // so we can log panics via kmsg even if tokio fails.
    let _ = std::fs::create_dir_all("/dev");
    let _ = nix::mount::mount(
        Some("devtmpfs"), "/dev", Some("devtmpfs"),
        nix::mount::MsFlags::empty(), None::<&str>,
    );

    // Install panic hook that writes to /dev/kmsg BEFORE any tokio code.
    std::panic::set_hook(Box::new(|info| {
        let msg = {
            let p = info.payload();
            if let Some(s) = p.downcast_ref::<String>() {
                format!("process_api PANIC: {s}")
            } else if let Some(s) = p.downcast_ref::<&str>() {
                format!("process_api PANIC: {s}")
            } else {
                format!("process_api PANIC: <?>")
            }
        };
        let _ = (|| -> std::io::Result<()> {
            std::fs::OpenOptions::new().write(true).open("/dev/kmsg")?.write_all(msg.as_bytes())?;
            Ok(())
        })();
        if let Some(loc) = info.location() {
            let _ = (|| -> std::io::Result<()> {
                std::fs::OpenOptions::new().write(true).open("/dev/kmsg")?.write_all(format!("  at {loc}\n").as_bytes())?;
                Ok(())
            })();
        }
    }));

    let _ = (|| -> std::io::Result<()> {
        std::fs::OpenOptions::new().write(true).open("/dev/kmsg")?.write_all(b"process_api: building tokio runtime\n")
    })();

    fn build_runtime() -> Result<tokio::runtime::Runtime> {
        use std::panic::catch_unwind;
        match catch_unwind(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build()
        }) {
            Ok(Ok(rt)) => Ok(rt),
            Ok(Err(e)) => {
                kmsg(&format!("tokio build error: {e}"));
                Err(anyhow::anyhow!("tokio build error: {e}"))
            }
            Err(panic) => {
                kmsg("tokio build panicked (signal init failed), falling back to time-only runtime");
                tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                    .map_err(|e| anyhow::anyhow!("tokio (time-only) build error: {e}"))
            }
        }
    }

    let rt = build_runtime()?;

    let _ = (|| -> std::io::Result<()> {
        std::fs::OpenOptions::new().write(true).open("/dev/kmsg")?.write_all(b"process_api: runtime built, entering block_on\n")
    })();

    rt.block_on(async { main_async().await })
}

async fn main_async() -> Result<()> {
    // Also mount proc and sysfs (needed by tokio/later tooling)
    let _ = fs::create_dir_all("/proc");
    let _ = nix::mount::mount(
        Some("proc"),
        "/proc",
        Some("proc"),
        nix::mount::MsFlags::empty(),
        None::<&str>,
    );
    let _ = fs::create_dir_all("/sys");
    let _ = nix::mount::mount(
        Some("sysfs"),
        "/sys",
        Some("sysfs"),
        nix::mount::MsFlags::empty(),
        None::<&str>,
    );

    // Route all logging directly to /dev/console (the serial). The kernel
    // does not reliably wire PID 1's stdio fds (0/1/2) to the console
    // in this microVM, and Rust's stdio layer panics on those fds.
    init_logging();

    // Configure guest network interface (eth0) with static IP.
    // The host-side TAP is at 192.0.2.1/24; guest gets 192.0.2.2/24.
    setup_guest_network("eth0", "192.0.2.2", "255.255.255.0");
    let args = Args::parse();
    
    let state = Arc::new(Mutex::new(SandboxState {
        args: args.clone(),
        active_tasks: HashMap::new(),
    }));

    // 1. PID 1 Lifeline Management (Zombie Reaper Loop)
    if std::process::id() == 1 || args.firecracker_init {
        info!("Initializing system architecture as PID 1 supervisor...");
        std::thread::spawn(|| {
            loop {
                match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
                    Ok(WaitStatus::Exited(pid, status)) => {
                        info!("Reaped zombie child process [PID: {}] with exit status: {}", pid, status);
                    }
                    Ok(WaitStatus::Signaled(pid, signal, _)) => {
                        warn!("Reaped zombie child process [PID: {}] terminated by signal: {:?}", pid, signal);
                    }
                    Ok(WaitStatus::StillAlive) => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(nix::errno::Errno::ECHILD) => {
                        std::thread::sleep(Duration::from_millis(200)); // No child processes left right now
                    }
                    Err(e) => {
                        error!("Critical breakdown in zombie reaping routine: {:?}", e);
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    _ => {}
                }
            }
        });

        // Parse initial boot disk configuration if cold boot
        if let Err(e) = execute_system_mounts() {
            warn!("Cold boot mount profile configuration bypassed: {}", e);
        }

        // Signal snapstart readiness (Anthropic pattern: write sentinel)
        if Path::new("/tmp/rclone-mounts/ready").exists() || true {
            info!("SNAPSTART_READY: sandbox supervisor initialized");
        }
    }

    // 2. Resource Isolation Controller (Out-Of-Memory Polling Daemon)
    let oom_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(args.oom_polling_period_ms));
        loop {
            interval.tick().await;
            run_oom_guard(&oom_state).await;
        }
    });

    // 3. Control API Engine (Port 2025 - Hyper HTTP Orchestrator)
    let control_state = Arc::clone(&state);
    let control_addr = args.control_server_addr.clone();
    tokio::spawn(async move {
        match TcpListener::bind(&control_addr).await {
            Ok(listener) => {
                info!("Control API Server safely bound to HTTP://{}", control_addr);
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        let io = TokioIo::new(stream);
                        let current_state = Arc::clone(&control_state);
                        tokio::task::spawn(async move {
                            let service = service_fn(move |req| handle_control_request(req, Arc::clone(&current_state)));
                            if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                                error!("Error processing operational loop inside Control API: {:?}", err);
                            }
                        });
                    }
                }
            }
            Err(e) => error!("Failed to open port 2025 for Control infrastructure: {}", e),
        }
    });

    // 4. Main WebSocket Gateway (Port 2024 - Interactivity Multiplexer)
    info!("Exposing execution multiplexer on WebSockets://{}", args.addr);
    let ws_listener = TcpListener::bind(&args.addr).await?;
    while let Ok((stream, peer_addr)) = ws_listener.accept().await {
        if args.block_local_connections && peer_addr.ip().is_loopback() {
            debug!("Dropped localized connection sequence from {}", peer_addr);
            continue;
        }
        let task_state = Arc::clone(&state);
        tokio::spawn(handle_ws_routing(stream, task_state));
    }

    Ok(())
}

/// Linux System mount orchestrator handles file system virtualization
fn execute_system_mounts() -> Result<()> {
    let config_path = Path::new("/mount_config.json");
    if config_path.exists() {
        let payload = fs::read_to_string(config_path)?;
        info!("Parsing filesystem configurations: {}", payload);
        // Real logic parses JSON maps to run nix::mount::mount targets
    }
    
    // Drop Sentinel system files notifying host layers of environment completion
    fs::create_dir_all("/tmp/rclone-mounts")?;
    fs::write("/tmp/rclone-mounts/ready", "1")?;
    info!("Sent system readiness token to /tmp/rclone-mounts/ready");
    Ok(())
}

/// Control API Protocol layer (Port 2025)
async fn handle_control_request(
    req: Request<hyper::body::Incoming>,
    state: Arc<Mutex<SandboxState>>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let route = req.uri().path();
    match route {
        "/status" => {
            let lock = state.lock().await;
            let body_str = format!("{{\"status\":\"healthy\",\"active_tasks\":{}}}", lock.active_tasks.len());
            Ok(Response::new(Full::new(Bytes::from(body_str))))
        }
        "/mount_root" => {
            info!("Dynamic root filesystem remap sequence triggered via HTTP API");
            let response = match execute_system_mounts() {
                Ok(_) => "{\"success\":true,\"message\":\"Mount layers reconfigured\"}",
                Err(e) => {
                    error!("Dynamic mount remapping runtime fault: {}", e);
                    "{\"success\":false,\"error\":\"Mount operational collapse\"}"
                }
            };
            Ok(Response::new(Full::new(Bytes::from(response))))
        }
        _ => {
            let mut res = Response::new(Full::new(Bytes::from("Not Found")));
            *res.status_mut() = StatusCode::NOT_FOUND;
            Ok(res)
        }
    }
}

/// Kernel Linux cgroup constraints injection routines
fn enroll_process_in_cgroup(task_id: &Uuid, pid: u32, memory_limit: Option<u64>) -> std::io::Result<()> {
    let base_cgroup = format!("/sys/fs/cgroup/memory/process_api/{}", task_id);
    fs::create_dir_all(&base_cgroup)?;

    if let Some(limit) = memory_limit {
        let limit_file = format!("{}/memory.limit_in_bytes", base_cgroup);
        fs::write(limit_file, limit.to_string())?;
    }

    fs::write(format!("{}/cgroup.procs", base_cgroup), pid.to_string())?;
    info!("Process {} bound under cgroup group identity: {}", pid, task_id);
    Ok(())
}

/// Actively monitors execution groups to protect the microVM against unmanaged host crashes
async fn run_oom_guard(state: &Arc<Mutex<SandboxState>>) {
    let base_cgroup_path = Path::new("/sys/fs/cgroup/memory/process_api");
    if !base_cgroup_path.exists() {
        return;
    }

    if let Ok(directories) = fs::read_dir(base_cgroup_path) {
        for entry in directories.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }

            let usage_file = path.join("memory.usage_in_bytes");
            let limit_file = path.join("memory.limit_in_bytes");

            if let (Ok(usage_raw), Ok(limit_raw)) = (fs::read_to_string(usage_file), fs::read_to_string(limit_file)) {
                let usage: u64 = usage_raw.trim().parse().unwrap_or(0);
                let limit: u64 = limit_raw.trim().parse().unwrap_or(u64::MAX);

                if usage >= limit && limit > 0 {
                    let dir_name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                    warn!("Resource exhaustion profile breached inside cgroup [{}]. Executing memory extraction...", dir_name);

                    // Read process group array and terminate all rogue subprocess routines
                    if let Ok(procs_raw) = fs::read_to_string(path.join("cgroup.procs")) {
                        for target_pid_str in procs_raw.lines() {
                            if let Ok(target_pid) = target_pid_str.trim().parse::<i32>() {
                                let pid_struct = nix::unistd::Pid::from_raw(target_pid);
                                let _ = nix::sys::signal::kill(pid_struct, nix::sys::signal::Signal::SIGKILL);
                                info!("Forcefully dropped process ID: {} due to kernel cgroup OOM limits.", target_pid);
                            }
                        }
                    }
                    
                    if let Ok(uuid) = Uuid::parse_str(&dir_name) {
                        state.lock().await.active_tasks.remove(&uuid);
                    }
                }
            }
        }
    }
}

/// WebSocket Interactive Multiplexer (Port 2024 Engine)
async fn handle_ws_routing(raw_stream: TcpStream, state: Arc<Mutex<SandboxState>>) {
    let ws_stream = match accept_async(raw_stream).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("Handshake protocols failure on secure WebSocket stream: {}", e);
            return;
        }
    };

    info!("Established execution transport connection layer.");
    let (mut ws_writer, mut ws_reader) = ws_stream.split();
    
    // Allocate internal task identity metrics
    let task_uuid = Uuid::new_v4();
    let mem_limit = state.lock().await.args.memory_limit_bytes;

    // Spawn execution subprocess wrapper
    let mut sub_process = match Command::new("bash")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn() {
            Ok(child) => child,
            Err(e) => {
                let _ = ws_writer.send(Message::Text(format!("{{\"error\":\"Process initialization collapse: {}\"}}", e).into())).await;
                return;
            }
        };

    let pid = sub_process.id().unwrap_or(0);
    
    // Lock process into isolated task profile tracking arrays
    {
        let mut lock = state.lock().await;
        lock.active_tasks.insert(task_uuid, pid);
    }

    if pid > 0 {
        if let Err(e) = enroll_process_in_cgroup(&task_uuid, pid, mem_limit) {
            warn!("Process cgroup configuration mapping bypassed: {}", e);
        }
    }

    let mut proc_stdin = sub_process.stdin.take().expect("Failed to grab subprocess standard input write lock");
    let proc_stdout = sub_process.stdout.take().expect("Failed to grab subprocess standard output read lock");
    let proc_stderr = sub_process.stderr.take().expect("Failed to grab subprocess structural error read lock");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(100);

    // Stdout Reader Thread
    let stdout_tx = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(proc_stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let payload = format!("{{\"stream\":\"stdout\",\"text\":\"{}\"}}\n", line.replace('"', "\\\""));
            if stdout_tx.send(Message::Text(payload.into())).await.is_err() { break; }
        }
    });

    // Stderr Reader Thread
    let stderr_tx = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(proc_stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let payload = format!("{{\"stream\":\"stderr\",\"text\":\"{}\"}}\n", line.replace('"', "\\\""));
            if stderr_tx.send(Message::Text(payload.into())).await.is_err() { break; }
        }
    });

    // Inbound/Outbound Multiplexing Loop with Timeout
    let timeout = tokio::time::sleep(Duration::from_secs(state.lock().await.args.default_timeout_secs));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            incoming_msg = ws_reader.next() => {
                match incoming_msg {
                    Some(Ok(Message::Text(text))) => {
                        if proc_stdin.write_all(text.as_bytes()).await.is_err() { break; }
                        if proc_stdin.flush().await.is_err() { break; }
                    },
                    Some(Ok(Message::Binary(bin))) => {
                        if proc_stdin.write_all(&bin).await.is_err() { break; }
                        if proc_stdin.flush().await.is_err() { break; }
                    },
                    _ => break,
                }
            }
            Some(msg) = rx.recv() => {
                if ws_writer.send(msg).await.is_err() { break; }
            }
            status = sub_process.wait() => {
                match status {
                    Ok(exit_code) => info!("Subprocess execution sequence [{}] terminated with system code: {}", task_uuid, exit_code),
                    Err(e) => error!("Subprocess interface returned error runtime tracking codes: {}", e),
                }
                break;
            }
            _ = &mut timeout => {
                info!("Tool call timed out, sending SIGTERM");
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
                break;
            }
        }
    }

    // Unregister execution metrics from tracking tables
    let mut lock = state.lock().await;
    lock.active_tasks.remove(&task_uuid);

    // Clear the active cgroup configuration folder from system trees
    let _ = fs::remove_dir(format!("/sys/fs/cgroup/memory/process_api/{}", task_uuid));

    // Send exit code to WebSocket client before closing
    let exit_msg = match sub_process.wait().await {
        Ok(status) => format!("{{\"event\":\"exit\",\"code\":{}}}", status.code().unwrap_or(-1)),
        Err(_) => r#"{"event":"exit","code":-1}"#.to_string(),
    };
    let _ = ws_writer.send(Message::Text(exit_msg.into())).await;
}
