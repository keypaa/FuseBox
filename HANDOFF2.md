# Debug Handoff — July 12

## The Bug
`process_api` (and all cargo-built binaries for musl target) panic with exit code 101 (`0x65`) immediately on startup inside Firecracker VM — **before `main()` executes**. No console output appears.

But `process_api --firecracker-init --addr 0.0.0.0:2024` runs perfectly on the host (OptiPlex directly).

## What's Been Tried

### Fixes applied (all committed)
- `CONFIG_UNIX=y` in kernel config (for tokio socketpair)
- `SocketAddr` type instead of `String` for bind args (skip getaddrinfo)
- `/dev/{zero,random,urandom}` device nodes in initrd
- Debug mode build (same panic at startup)

### Evidence
| Binary | Built how | Runs on host? | Runs in VM? |
|--------|-----------|---------------|-------------|
| `minimal_test.rs` (direct `rustc`) | `rustc -C target-cpu=x86-64 -C link-self-contained=yes --target x86_64-unknown-linux-musl` | untested | **OK** (no panic) |
| `process_api` | `cargo build --release --target x86_64-unknown-linux-musl` | **OK** | **Panics** |
| `steps` (bin in process_api) | `cargo build --release --target x86_64-unknown-linux-musl --bin steps` | untested | **Panics** |
| `steps` (debug) | `cargo build --target x86_64-unknown-linux-musl --bin steps` | untested | **Panics** |

**The dividing line**: `rustc`-compiled binary works, `cargo`-compiled binaries panic. **UPDATE — Root cause found!** `.cargo/config.toml` has:
```
rustflags = ["-C", "link-args=-Wl,-no-pie,-static"]
```
This conflicts with modern Rust's default `static-pie` linking for musl. The linker uses `crt1.o` (non-PIE CRT) for a PIE binary → crash before `main()`. `minimal_test` was compiled with `rustc -C link-self-contained=yes` which correctly uses `rcrt1.o` (PIE CRT).

**Fix:** `rm sandbox/process_api/.cargo/config.toml` and rebuild.

This points to something in Cargo's build process for the musl target — either:
1. **Linker script / CRT startup** — Cargo uses a different CRT (`crt1.o`, `rcrt1.o`) than raw `rustc`
2. **LTO or optimization** — even in debug mode, cargo applies lto or codegen flags
3. **Dependency static init** — `ring`, `tokio`, `nix`, or `tracing-subscriber` have constructor functions (`.init_array`) that crash before `main()` because of a kernel config mismatch (e.g., `CONFIG_POSIX_TIMERS`, `CONFIG_EVENTFD`, `CONFIG_SIGNALFD`)
4. **`force-frame-pointers` or unwinding** — musl's `_Unwind_Resume` is missing in kernel

## Next Steps

### 1. Test bare-minimum cargo binary
```bash
cd /tmp && cargo new test_cargo_min
cd test_cargo_min && cat > src/main.rs << 'END'
fn main() { eprintln!("hello"); loop {} }
END
cargo build --release --target x86_64-unknown-linux-musl
```
If this works, the issue is in process_api's dependency tree. If it panics, Cargo's musl build itself is broken.

### 2. Check CRT files
Compare what `rustc` vs `cargo` link:
```bash
rustc -C target-cpu=x86-64 -C link-self-contained=yes --target x86_64-unknown-linux-musl -Z print-link-args /tmp/test.rs
cargo build --release --target x86_64-unknown-linux-musl -Z build-std 2>&1 | head
```

### 3. Check the cargo profile
```bash
cat /home/keypa/dev/FuseBox/sandbox/process_api/.cargo/config.toml 2>/dev/null
```

### 4. Check target-features
```bash
rustc --print cfg --target x86_64-unknown-linux-musl | grep -E 'target_feature|target_os|target_env'
```

### 5. Quick kernel config check for missing features
tokio needs: `CONFIG_EVENTFD=y`, `CONFIG_SIGNALFD=y`, `CONFIG_TIMERFD=y`, `CONFIG_EPOLL=y`
Check the kernel config for these.

The key insight: the last working state was DIFFERENT. The build that produced the working binary was possibly from a different Rust version or Cargo version. Check `rustup show` and `cargo --version`.

## Commands to reproduce
```bash
cd ~/dev/FuseBox/sandbox/initrd
sudo ../network/setup-tap.sh
# Kill old
sudo pkill -9 firecracker 2>/dev/null; sudo rm -f /tmp/fusebox-fc.sock
# Start Firecracker in first terminal
sudo ../firecracker/firecracker --api-sock /tmp/fusebox-fc.sock
# Curl sequence in second terminal
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/boot-source' -H 'Content-Type: application/json' -d '{"kernel_image_path": "/home/keypa/dev/FuseBox/sandbox/kernel/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 nomodule rdinit=/process_api", "initrd_path": "/home/keypa/dev/FuseBox/sandbox/initrd/initrd.img"}'
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/machine-config' -H 'Content-Type: application/json' -d '{"vcpu_count":1,"mem_size_mib":512,"smt":false,"track_dirty_pages":true}'
sudo curl --unix-socket /tmp/fusebox-fc.sock -X PUT 'http://localhost/actions' -H 'Content-Type: application/json' -d '{"action_type":"InstanceStart"}'
```
