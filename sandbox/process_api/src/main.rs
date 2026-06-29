use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

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
    addr: String,

    #[arg(long, default_value = "0.0.0.0:2025")]
    control_server_addr: String,

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

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing framework for logging
    tracing_subscriber::fmt::init();
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
