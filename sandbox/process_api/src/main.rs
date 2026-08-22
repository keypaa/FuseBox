use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::io::{AsRawFd, FromRawFd};
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
use std::io::Read;
use std::os::unix::process::ExitStatusExt;
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

    /// Kill an interactive shell session after this many seconds of session
    /// lifetime. 0 (the default) disables the timeout — an interactive shell
    /// should not be reaped while idle.
    #[arg(long, default_value = "0")]
    session_timeout_secs: u64,
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
    let ip: u32 = addr.parse::<Ipv4Addr>().map(|a| u32::from(a)).unwrap_or(0);
    let ip_bytes = ip.to_be_bytes();
    let mut sa: libc::sockaddr = unsafe { std::mem::zeroed() };
    sa.sa_family = libc::AF_INET as u16;
    for i in 0..4 { sa.sa_data[2 + i] = ip_bytes[i] as libc::c_char; }
    ifr.ifr_ifru.ifru_addr = sa;
    let ret = unsafe { libc::ioctl(sock, libc::SIOCSIFADDR as libc::Ioctl, &ifr) };
    if ret != 0 { kmsg(&format!("setup_guest_network: SIOCSIFADDR failed: {}", std::io::Error::last_os_error())); }
    let mask: u32 = netmask.parse::<Ipv4Addr>().map(|a| u32::from(a)).unwrap_or(0);
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
    // Launch-context hygiene: if the supervisor was started as a background
    // job from a shell that ignores SIGINT/SIGQUIT/SIGPIPE, those ignored
    // dispositions inherit across exec into every guest shell — and bash
    // cannot reset signals that arrived ignored-on-entry, so Ctrl-C would be
    // dead in ALL sessions (the tty echoes ^C but nobody acts on it).
    // Reset to defaults so children get sane dispositions regardless of how
    // this binary was launched. Harmless for the kernel-started PID 1 case,
    // which already receives clean dispositions.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGQUIT, libc::SIG_DFL);
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    // Mount devtmpfs so /dev/kmsg exists. Do this BEFORE tokio runtime init
    // so we can log panics via kmsg even if tokio fails.
    let _ = std::fs::create_dir_all("/dev");
    let _ = nix::mount::mount(
        Some("devtmpfs"), "/dev", Some("devtmpfs"),
        nix::mount::MsFlags::empty(), None::<&str>,
    );

    // Mount devpts so openpty() can resolve /dev/pts/<n> slave nodes.
    // The fs is compiled into this kernel automatically (UNIX98_PTYS pulls
    // it in), but nothing mounts it during boot — without it, even opening
    // /dev/ptmx fails (ptmx_open -> devpts_acquire requires a devpts sb).
    let _ = std::fs::create_dir_all("/dev/pts");
    match nix::mount::mount(
        Some("devpts"), "/dev/pts", Some("devpts"),
        nix::mount::MsFlags::empty(), Some("gid=5,mode=620,ptmxmode=0666"),
    ) {
        Ok(()) => kmsg("process_api: devpts mounted at /dev/pts (gid=5,mode=620,ptmxmode=0666)"),
        Err(e) => {
            kmsg(&format!(
                "process_api: devpts mount with options failed: {e}; retrying plain"
            ));
            match nix::mount::mount(
                Some("devpts"), "/dev/pts", Some("devpts"),
                nix::mount::MsFlags::empty(), None::<&str>,
            ) {
                Ok(()) => kmsg("process_api: devpts mounted at /dev/pts (default options)"),
                Err(e2) => kmsg(&format!("process_api: devpts mount failed again: {e2}")),
            }
        }
    }

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
            Err(_panic) => {
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

    let args = Args::parse();

    // Configure guest network interface (eth0) with static IP.
    // The host-side TAP is at 192.0.2.1/24; guest gets 192.0.2.2/24.
    //
    // Only when actually acting as the guest init (PID 1 or --firecracker-init):
    // on a developer host this would try to re-IP a real interface.
    if std::process::id() == 1 || args.firecracker_init {
        setup_guest_network("eth0", "192.0.2.2", "255.255.255.0");
    } else {
        kmsg("process_api: not guest init; skipping guest network configuration");
    }

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
        info!("SNAPSTART_READY: sandbox supervisor initialized");
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

/// One requested mount from /mount_config.json.
#[derive(Debug, serde::Deserialize)]
struct MountEntry {
    device: String,
    target: String,
    #[serde(rename = "type")]
    fs_type: String,
    #[serde(default, deserialize_with = "deserialize_flex_options")]
    options: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct MountConfig {
    #[serde(default)]
    ready_file: Option<String>,
    #[serde(default)]
    mounts: Vec<MountEntry>,
}

/// Accept `"ro"` or `["ro", "nosuid"]` for the options field.
fn deserialize_flex_options<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(vec![]),
        serde_json::Value::String(s) => Ok(s
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect()),
        serde_json::Value::Array(a) => Ok(a
            .into_iter()
            .map(|x| x.as_str().unwrap_or_default().to_string())
            .collect()),
        other => Err(serde::de::Error::custom(format!(
            "options must be a string or array of strings, got {other}"
        ))),
    }
}

/// Targets currently present in /proc/mounts (best effort: empty on error).
fn active_mount_targets() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(content) = fs::read_to_string("/proc/mounts") {
        for line in content.lines() {
            if let Some(target) = line.split_whitespace().nth(1) {
                set.insert(target.to_string());
            }
        }
    }
    set
}

/// Linux System mount orchestrator handles file system virtualization.
///
/// Reads /mount_config.json (baked into the initrd) and mounts each entry —
/// typically the squashfs volumes attached as virtio block devices. Idempotent
/// (targets already mounted are skipped, so POST /mount_root is safe) and
/// tolerant: a failing entry logs an error but does not abort boot.
fn execute_system_mounts() -> Result<()> {
    let mut ready_file = "/tmp/rclone-mounts/ready".to_string();
    let config_path = Path::new("/mount_config.json");
    if config_path.exists() {
        let payload = fs::read_to_string(config_path)?;
        match serde_json::from_str::<MountConfig>(&payload) {
            Ok(cfg) => {
                if let Some(rf) = cfg.ready_file {
                    ready_file = rf;
                }
                let mounted = active_mount_targets();
                for entry in &cfg.mounts {
                    if mounted.contains(&entry.target) {
                        info!(
                            "Mount {} -> {} already active, skipping",
                            entry.device, entry.target
                        );
                        continue;
                    }
                    if let Err(e) = fs::create_dir_all(&entry.target) {
                        error!("Cannot create mountpoint {}: {}", entry.target, e);
                        continue;
                    }
                    let mut flags = nix::mount::MsFlags::empty();
                    if entry.options.iter().any(|o| o == "ro") {
                        flags |= nix::mount::MsFlags::MS_RDONLY;
                    }
                    match nix::mount::mount(
                        Some(Path::new(&entry.device)),
                        Path::new(&entry.target),
                        Some(Path::new(&entry.fs_type)),
                        flags,
                        None::<&str>,
                    ) {
                        Ok(()) => info!(
                            "Mounted {} ({}) -> {} {:?}",
                            entry.device, entry.fs_type, entry.target, entry.options
                        ),
                        Err(e) => error!(
                            "Mount {} -> {} failed: {}",
                            entry.device, entry.target, e
                        ),
                    }
                }
            }
            Err(e) => error!("Failed to parse /mount_config.json: {}", e),
        }
    } else {
        info!("No /mount_config.json present; nothing to mount");
    }

    // Drop Sentinel system files notifying host layers of environment completion
    if let Some(parent) = Path::new(&ready_file).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&ready_file, "1")?;
    info!("Sent system readiness token to {}", ready_file);
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

// ============================ PTY interactive shell =========================

/// Open a pseudo-terminal pair at `cols`x`rows`.
///
/// Returns `(master_read, master_write, slave_in, slave_out, slave_err,
/// master_ctl_fd)`. The three slave handles exist because each of the child's
/// stdio streams consumes one owned `File`. `master_ctl_fd` is a plain dup of
/// the master kept solely for ioctls (TIOCSWINSZ) — close it with libc::close.
///
/// Implemented with explicit opens instead of libc::openpty so we can fall
/// back between master paths: modern kernels refuse /dev/ptmx unless a devpts
/// instance is mounted (ptmx_open -> devpts_acquire), and some setups only
/// expose the master as /dev/pts/ptmx inside the devpts root.
///
/// ioctl(2)'s request argument has a target-dependent type (c_int on musl,
/// c_ulong on gnu); route calls through this wrapper.
fn pty_ioctl(fd: libc::c_int, request: u32, arg: *mut libc::c_void) -> libc::c_int {
    #[cfg(target_env = "musl")]
    unsafe { libc::ioctl(fd, request as libc::c_int, arg) }
    #[cfg(not(target_env = "musl"))]
    unsafe { libc::ioctl(fd, request as libc::c_ulong, arg) }
}

#[allow(clippy::type_complexity)]
fn open_pty(
    cols: u16,
    rows: u16,
) -> std::io::Result<(fs::File, fs::File, fs::File, fs::File, fs::File, i32)> {
    const OPEN_FLAGS: libc::c_int = libc::O_RDWR | libc::O_NOCTTY;
    // _IOR('T', 0x30, uint) / _IOW('T', 0x31, int): slave index + lock toggle.
    const TIOCGPTN: u32 = 0x8004_5430;
    const TIOCSPTLCK: u32 = 0x4004_5431;

    let mut master: libc::c_int = -1;
    for path in ["/dev/ptmx", "/dev/pts/ptmx"] {
        let cpath = std::ffi::CString::new(path).unwrap();
        master = unsafe { libc::open(cpath.as_ptr(), OPEN_FLAGS) };
        if master >= 0 {
            break;
        }
    }
    if master < 0 {
        return Err(std::io::Error::last_os_error());
    }

    unsafe {
        // Clear the slave lock and ask the kernel for the slave's pts index.
        let unlocked: libc::c_int = 0;
        let mut idx: libc::c_int = -1;
        if pty_ioctl(master, TIOCSPTLCK, &unlocked as *const _ as *mut _) != 0
            || pty_ioctl(master, TIOCGPTN, &mut idx as *mut _ as *mut libc::c_void) != 0
            || idx < 0
        {
            let e = std::io::Error::last_os_error();
            libc::close(master);
            return Err(e);
        }

        let slave_path = std::ffi::CString::new(format!("/dev/pts/{idx}")).unwrap();
        let slave = libc::open(slave_path.as_ptr(), OPEN_FLAGS);
        if slave < 0 {
            let e = std::io::Error::last_os_error();
            libc::close(master);
            return Err(e);
        }

        let ctl_fd = libc::fcntl(master, libc::F_DUPFD_CLOEXEC, 0);
        if ctl_fd < 0 {
            let e = std::io::Error::last_os_error();
            libc::close(master);
            libc::close(slave);
            return Err(e);
        }

        // Apply the window size before the shell reads its first prompt.
        let win = libc::winsize {
            ws_col: cols,
            ws_row: rows,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let _ = libc::ioctl(slave, libc::TIOCSWINSZ, &win);

        let master_read = fs::File::from_raw_fd(master);
        let master_write = master_read.try_clone()?;
        let slave_file = fs::File::from_raw_fd(slave);
        let slave_out = slave_file.try_clone()?;
        let slave_err = slave_file.try_clone()?;
        Ok((master_read, master_write, slave_file, slave_out, slave_err, ctl_fd))
    }
}

/// Spawn an interactive `/bin/bash` with all three stdio streams attached to
/// pty slave file descriptors.
///
/// The `pre_exec` hook makes the child a session leader (`setsid`) and hands
/// it the pty slave (already its fd 0) as controlling terminal (`TIOCSCTTY`).
/// Without those two calls bash degrades: readline refuses to start, Ctrl-C
/// never becomes SIGINT, and job control prints "cannot set terminal process
/// group" warnings. With them the kernel line discipline delivers signals and
/// echoes input exactly like a real terminal.
fn spawn_interactive_shell(
    stdin_f: fs::File,
    stdout_f: fs::File,
    stderr_f: fs::File,
) -> std::io::Result<tokio::process::Child> {
    use std::process::Stdio;

    let mut cmd = Command::new("/bin/bash");
    cmd.stdin(Stdio::from(stdin_f))
        .stdout(Stdio::from(stdout_f))
        .stderr(Stdio::from(stderr_f));
    cmd.env("TERM", "xterm-256color")
        .env("PATH", "/bin:/usr/bin")
        .env("HOME", "/root")
        .env("USER", "root")
        .env("LOGNAME", "root")
        .env("PS1", "\\u@fusebox:\\w\\$ ")
        .env("HISTFILE", "/dev/null")
        // Don't inherit shell-integration hooks from whoever started the
        // supervisor: they would execute inside every guest session.
        .env_remove("PROMPT_COMMAND")
        .env_remove("BASH_ENV")
        .env_remove("ENV");

    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // fd 0 is the pty slave at this point (stdio already dup2-ed).
            if libc::ioctl(0, libc::TIOCSCTTY, 0 as libc::c_ulong) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// Incrementally decode pty output into strings, carrying incomplete UTF-8
/// multi-byte tails across reads instead of emitting mojibake at chunk
/// boundaries (a CJK char pasted into the shell can split mid-sequence).
fn decode_utf8_incremental(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut cursor = 0usize;
    let mut out = String::new();
    while cursor < carry.len() {
        match std::str::from_utf8(&carry[cursor..]) {
            Ok(s) => {
                out.push_str(s);
                cursor = carry.len();
            }
            Err(e) => {
                let valid_end = cursor + e.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&carry[cursor..valid_end]));
                cursor = valid_end;
                match e.error_len() {
                    Some(bad_len) => {
                        out.push('\u{FFFD}');
                        cursor += bad_len;
                    }
                    // Incomplete trailing sequence: keep for the next read.
                    None => break,
                }
            }
        }
    }
    carry.drain(..cursor);
    out
}

/// Apply a new window size to the pty. The kernel raises SIGWINCH in the
/// foreground process group automatically, so running programs (vim, less...)
/// repaint without extra signalling from us.
fn pty_resize(master_fd: i32, cols: u16, rows: u16) -> bool {
    let win = libc::winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ, &win) == 0 }
}

enum ControlFrame {
    Resize(u16, u16),
    Ping,
}

/// Recognize control frames among incoming Text messages. Everything that is
/// not a recognized control object falls through (`None`) and is treated as
/// verbatim shell input.
fn parse_control_frame(text: &str) -> Option<ControlFrame> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    match obj.get("type")?.as_str()? {
        "resize" => {
            let cols = obj.get("cols")?.as_u64()? as u16;
            let rows = obj.get("rows")?.as_u64()? as u16;
            if cols == 0 || rows == 0 {
                return None;
            }
            Some(ControlFrame::Resize(cols, rows))
        }
        "ping" => Some(ControlFrame::Ping),
        _ => None,
    }
}

/// WebSocket Interactive Multiplexer (Port 2024 Engine)
///
/// Each connection gets its own PTY-backed interactive bash session:
/// - Client Text/Binary frames are written **verbatim** to the pty master
///   (arrow keys, tab, Ctrl-C … reach the line discipline untouched), except
///   for JSON control frames: `{"type":"resize","cols":C,"rows":R}` and
///   `{"type":"ping"}`.
/// - Output chunks are streamed back as properly escaped JSON:
///   `{"stream":"stdout","text":"…"}` (stderr merges into the pty, like a
///   real terminal), followed by `{"event":"exit","code":N}`.
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

    // ---- Allocate pty and spawn the interactive shell --------------------
    let (master_r, master_w, s_in, s_out, s_err, master_ctl_fd) = match open_pty(80, 24) {
        Ok(x) => x,
        Err(e) => {
            // Rich diagnostics: this failed in-guest with ENOENT once already.
            let ptmx_exists = Path::new("/dev/ptmx").exists();
            let dev_entries: Vec<String> = fs::read_dir("/dev")
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|en| en.file_name().into_string().ok())
                        .take(24)
                        .collect()
                })
                .unwrap_or_default();
            kmsg(&format!(
                "process_api PTY DIAG: ptmx_exists={ptmx_exists} dev={dev_entries:?} mounts={:?}",
                fs::read_to_string("/proc/mounts")
                    .map(|m| m
                        .lines()
                        .filter(|l| l.contains("dev") || l.contains("pts"))
                        .map(|l| l.to_string())
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
            ));
            error!("PTY allocation failure: {}", e);
            let _ = ws_writer
                .send(Message::Text(
                    format!("{{\"error\":\"PTY allocation failed: {e}\"}}").into(),
                ))
                .await;
            let _ = ws_writer.close().await;
            return;
        }
    };

    let mut sub_process = match spawn_interactive_shell(s_in, s_out, s_err) {
        Ok(child) => child,
        Err(e) => {
            unsafe { libc::close(master_ctl_fd) };
            let _ = ws_writer
                .send(Message::Text(
                    format!("{{\"error\":\"Process initialization collapse: {e}\"}}").into(),
                ))
                .await;
            let _ = ws_writer.close().await;
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

    info!(
        "Interactive shell session [{}] started on pty (pid {})",
        task_uuid, pid
    );

    // Channels bridging the blocking relay threads and this async loop.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(256);
    let (in_tx, mut in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    // Master -> WebSocket relay. The pty is read on a dedicated blocking
    // thread: reads end with EIO once the shell exits and every slave fd is
    // closed, which is our reliable end-of-session signal from this side.
    let stdout_tx = out_tx.clone();
    std::thread::spawn(move || {
        let mut master = master_r;
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decode_utf8_incremental(&mut carry, &buf[..n]);
                    if text.is_empty() {
                        continue;
                    }
                    let payload =
                        serde_json::json!({"stream": "stdout", "text": text}).to_string();
                    if stdout_tx
                        .blocking_send(Message::Text(payload.into()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    drop(out_tx);

    // WebSocket -> Master relay (dedicated blocking writer thread).
    std::thread::spawn(move || {
        let mut master = master_w;
        while let Some(bytes) = in_rx.blocking_recv() {
            if master.write_all(&bytes).is_err() {
                break;
            }
            let _ = master.flush();
        }
    });

    // Optional session lifetime timeout — disabled by default because killing
    // an idle interactive shell after N seconds makes the sandbox feel broken.
    let timeout_secs = state.lock().await.args.session_timeout_secs;
    let session_timeout = async move {
        if timeout_secs == 0 {
            std::future::pending::<()>().await
        } else {
            tokio::time::sleep(Duration::from_secs(timeout_secs)).await
        }
    };
    tokio::pin!(session_timeout);

    let mut exit_code: Option<i32> = None;
    let mut client_gone = false;

    loop {
        tokio::select! {
            incoming_msg = ws_reader.next() => {
                match incoming_msg {
                    Some(Ok(Message::Text(text))) => {
                        match parse_control_frame(&text) {
                            Some(ControlFrame::Resize(cols, rows)) => {
                                if !pty_resize(master_ctl_fd, cols, rows) {
                                    warn!(
                                        "TIOCSWINSZ failed for session [{}]: {}",
                                        task_uuid,
                                        std::io::Error::last_os_error()
                                    );
                                }
                            }
                            Some(ControlFrame::Ping) => {
                                let _ = ws_writer
                                    .send(Message::Text(r#"{"event":"pong"}"#.into()))
                                    .await;
                            }
                            None => {
                                if in_tx.send(text.into_bytes()).await.is_err() {
                                    client_gone = true;
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        if in_tx.send(bin.to_vec()).await.is_err() {
                            client_gone = true;
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => {
                        client_gone = true;
                        break;
                    }
                }
            }
            Some(msg) = out_rx.recv() => {
                if ws_writer.send(msg).await.is_err() {
                    client_gone = true;
                    break;
                }
            }
            status = sub_process.wait() => {
                match status {
                    Ok(st) => {
                        exit_code = Some(
                            st.code()
                                .unwrap_or_else(|| st.signal().map(|s| -(s as i32)).unwrap_or(-1)),
                        );
                        info!("Shell session [{}] terminated with system code: {}", task_uuid, exit_code.unwrap_or(-1));
                    }
                    Err(e) => error!("Subprocess interface returned error runtime tracking codes: {}", e),
                }
                break;
            }
            _ = &mut session_timeout => {
                info!("Session [{}] timed out, sending SIGHUP", task_uuid);
                if pid > 0 {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(pid as i32),
                        nix::sys::signal::Signal::SIGHUP,
                    );
                }
                break;
            }
        }
    }

    // If the client vanished (or the session timed out) hang up the shell
    // like a dropped modem carrier: SIGHUP to the whole session group, then a
    // hard SIGKILL fallback if it lingers.
    if exit_code.is_none() {
        if pid > 0 && client_gone {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGHUP,
            );
        }
        match tokio::time::timeout(Duration::from_millis(1500), sub_process.wait()).await {
            Ok(Ok(st)) => {
                exit_code = Some(
                    st.code()
                        .unwrap_or_else(|| st.signal().map(|s| -(s as i32)).unwrap_or(-1)),
                );
            }
            _ => {
                if pid > 0 {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(pid as i32),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
                let _ = sub_process.wait().await;
            }
        }
    }

    // Send exit code to WebSocket client, then complete the WebSocket close
    // handshake. Dropping the sink without `close()` aborts the TCP stream —
    // browser-grade clients report 1006 abnormal closure even though the
    // exit frame was delivered.
    let _ = ws_writer
        .send(Message::Text(
            format!("{{\"event\":\"exit\",\"code\":{}}}", exit_code.unwrap_or(-1)).into(),
        ))
        .await;
    let _ = ws_writer.close().await;

    // Unregister execution metrics from tracking tables
    {
        let mut lock = state.lock().await;
        lock.active_tasks.remove(&task_uuid);
    }

    // Clear the active cgroup configuration folder from system trees
    let _ = fs::remove_dir(format!("/sys/fs/cgroup/memory/process_api/{}", task_uuid));

    unsafe { libc::close(master_ctl_fd) };
}

#[cfg(test)]
mod mount_config_tests {
    use super::*;

    #[test]
    fn parses_full_config() {
        let cfg: MountConfig = serde_json::from_str(
            r#"{
            "service_url": "https://api.anthropic.com",
            "ready_file": "/tmp/rclone-mounts/ready",
            "state_dir": "/tmp/rclone-mounts",
            "mounts": [
                {"device": "/dev/vdb", "target": "/mnt/filestore",
                 "type": "squashfs", "options": ["ro"]},
                {"device": "/dev/vdc", "target": "/mnt/skills/public",
                 "type": "squashfs", "options": "ro"},
                {"device": "/dev/vdd", "target": "/mnt/skills/examples",
                 "type": "squashfs"}
            ]
        }"#,
        )
        .unwrap();
        assert_eq!(cfg.mounts.len(), 3);
        assert_eq!(cfg.ready_file.as_deref(), Some("/tmp/rclone-mounts/ready"));
        assert_eq!(cfg.mounts[0].options, vec!["ro"]);
        // string form normalizes to the same vector
        assert_eq!(cfg.mounts[1].options, vec!["ro"]);
        // omitted options default to empty
        assert!(cfg.mounts[2].options.is_empty());
    }

    #[test]
    fn parses_empty_mounts() {
        let cfg: MountConfig = serde_json::from_str("{\"mounts\": []}").unwrap();
        assert!(cfg.mounts.is_empty());
        assert!(cfg.ready_file.is_none());
    }

    #[test]
    fn rejects_bad_options_type() {
        let parsed: Result<MountConfig, _> = serde_json::from_str(
            r#"{"mounts":[{"device":"/d","target":"/t","type":"squashfs","options":42}]}"#,
        );
        assert!(parsed.is_err());
    }
}
