# Build Instructions

## Prerequisites

```bash
# Arch Linux
sudo pacman -S base-devel musl rust musl-gcc cpio squashfs-tools

# Ubuntu/Debian
sudo apt install build-essential musl-tools rustup squashfs-tools cpio
rustup target add x86_64-unknown-linux-musl
```

## Building Components

### 1. Kernel

```bash
cd sandbox/kernel
sudo ./build-kernel.sh
```

Outputs `sandbox/kernel/vmlinux` (~24MB).

The kernel config (`microvm.config`) targets Firecracker's virtio-mmio devices. Key: `CONFIG_PCI=y` is required even with `pci=off` because ACPI needs it for IOAPIC routing.

### 2. process_api

```bash
cd sandbox/process_api
cargo build --release --target x86_64-unknown-linux-musl
```

Outputs `sandbox/process_api/target/x86_64-unknown-linux-musl/release/process_api`.

### 3. Static Shell Binaries

```bash
cd sandbox/tools
./fetch-static-binaries.sh
```

Downloads static `bash` (5.2.015) and `busybox` (1.35.0) into `sandbox/tools/bin/`. These are gitignored — run once per checkout.

### 4. Initrd

```bash
cd sandbox/initrd
./build-initrd.sh
```

Outputs `sandbox/initrd/initrd.img` (~3MB). Contents:
- `/process_api` — the PID 1 supervisor
- `/bin/bash` — static bash
- `/bin/busybox` + symlinks — coreutils (ls, cat, mkdir, ps, etc.)
- `/etc/ssl/certs/` — CA certificates
- `/etc/passwd`, `/etc/group` — root user identity
- `/etc/hosts`, `/etc/resolv.conf` — DNS config
- `/mount_config.json` — mount configuration

### 5. TAP Device (per reboot)

```bash
sudo ./sandbox/network/setup-tap.sh
```

Creates `fc-tap0` with IP 192.0.2.1/24, MTU 1400, iptables rules.

### 6. Launch VM

```bash
sudo ./sandbox/firecracker/launch.sh
```

Starts Firecracker, configures VM via API, outputs serial to `/tmp/fusebox-serial.log`.

## Rebuild Workflow

After editing `process_api/src/main.rs`:

```bash
cd sandbox/process_api && cargo build --release --target x86_64-unknown-linux-musl
cd sandbox/initrd && ./build-initrd.sh
# Restart VM (Ctrl-C old, relaunch)
```

After editing kernel config:

```bash
cd sandbox/kernel && sudo ./build-kernel.sh
# Restart VM
```

## Integration Tests

```bash
cd sandbox && ./test.sh
```

Tests: kernel binary, initrd contents, rootfs format, squashfs volumes, CA cert, TAP device, VM connectivity.
