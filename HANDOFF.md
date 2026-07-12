# Fusebox Debug Handoff — 2026-07-02

## Current State

### What Works
- Kernel boots fine (PCI disabled, devtmpfs, serial console OK)
- Simple Rust binaries work as PID 1 (`loop {}`, `test_step3b`)
- `TcpListener::bind(0.0.0.0:2025)` with `std::net::SocketAddr` (pre-parsed) works via `std::net::TcpListener` — confirmed by `test_step3b`
- C musl socket+bind+listen works as PID 1

### What's Broken
- `process_api` panics (exit code 0x65 = 101) with **zero output visible** on serial console
- The `SocketAddr` fix (String -> `std::net::SocketAddr` for clap args) was applied at `src/main.rs:34,37` but didn't fix the panic
- Step3b `test_step3b` worked **before** the `SocketAddr` fix too — the string bind was never the problem in the std version

### The Debug Lead
The exact panic site is unknown because `tracing_subscriber::fmt::init()` writes to stderr, which isn't reaching the serial console as PID 1. Need to either:
1. Write progress to `/dev/console` explicitly (like `minimal_init.rs` does)
2. Or better: add a `src/bin/debug_init.rs` binary that replicates `main()` step-by-step with `writeln!(con, ...)` calls

### Key Files
| Path | Role |
|------|------|
| `sandbox/process_api/src/main.rs` | Main binary (384 lines, has `#[tokio::main(flavor="current_thread")]`) |
| `sandbox/process_api/src/bin/minimal_init.rs` | C-based step test that works |
| `sandbox/initrd/build-initrd.sh` | Builds initrd from `target/x86_64-unknown-linux-musl/release/process_api` |
| `sandbox/initrd/mount-config.json` | Mount config for initrd |
| `sandbox/kernel/microvm.config` | Kernel config (PCI=n, devtmpfs=y) |

### WSL Paths (source of truth for edits)
`/home/keypa/FuseBox/sandbox/process_api/`

### OptiPlex Paths (runtime)
`/home/keypa/dev/FuseBox/sandbox/process_api/`

### Debug Initrd Build (done on WSL)
The `src/bin/debug_init.rs` was created but not yet compiled. Use:
```bash
cd /home/keypa/dev/FuseBox/sandbox/process_api
cargo build --release --target x86_64-unknown-linux-musl --bin debug_init
cd /home/keypa/dev/FuseBox/sandbox/initrd
rm -rf initrd-staging && mkdir -p initrd-staging/dev
cp /home/keypa/dev/FuseBox/sandbox/process_api/target/x86_64-unknown-linux-musl/release/debug_init initrd-staging/debug_init
cp /home/keypa/dev/FuseBox/sandbox/process_api/target/x86_64-unknown-linux-musl/release/process_api initrd-staging/process_api
sudo mknod initrd-staging/dev/console c 5 1
sudo mknod initrd-staging/dev/null c 1 3
find initrd-staging | cpio -o -H newc | gzip -9 > /tmp/debug-initrd.img
```

### Firecracker Test
```bash
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/boot-source' -H 'Content-Type: application/json' -d '{"kernel_image_path": "/home/keypa/dev/FuseBox/sandbox/kernel/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 nomodule rdinit=/debug_init", "initrd_path": "/tmp/debug-initrd.img"}'
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/machine-config' -H 'Content-Type: application/json' -d '{"vcpu_count":1,"mem_size_mib":2048,"smt":false,"track_dirty_pages":true}'
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/actions' -H 'Content-Type: application/json' -d '{"action_type":"InstanceStart"}'
```

### What to Try
1. Build and run `debug_init` — it writes to `/dev/console` at each step
2. The steps it tests: thread spawn, nix `waitpid()`, tokio runtime build, tokio `TcpListener::bind()`
3. Once the panic step is identified, either fix that step or add a C wrapper that calls Rust
4. Critical insight: the Rust standard library's `std::net::TcpListener` works but tokio's `tokio::net::TcpListener` might not — or the panic is earlier (tracing, tokio runtime init, etc.)

### Blockers/Risks
- Unknown panic location in process_api startup
- `socket+bind+listen` in C works (proven), `std::net::TcpListener` works (proven), but tokio might differ
- If tokio itself panics, may need to restructure process_api to use `std` sockets with mio/polling instead
