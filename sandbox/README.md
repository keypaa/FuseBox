# FuseBox Sandbox

A faithful reproduction of Anthropic's Claude sandbox environment using Firecracker microVMs.

## Architecture

```
Host                              Firecracker VM
┌──────────────────────────┐     ┌──────────────────────────────────┐
│                          │     │  process_api (PID 1)             │
│  TAP: fc-tap0            │ ←── │  ├── WebSocket  ws://0.0.0.0:2024│
│  192.0.2.1/24            │     │  ├── Control API http://0.0.0.0:2025│
│  MTU 1400                │     │  ├── /bin/bash (static, via WS)  │
│                          │     │  └── busybox coreutils (/bin/*)  │
│  iptables DNAT/MASQ      │     │                                  │
│  (80→1080, 443→1443)     │     │  /dev/vda  ← rootfs.ext4        │
│                          │     │  vdb       → rclone.squashfs     │
│                          │     │  vdc       → skills-public.sq    │
│                          │     │  vdd       → skills-examples.sq  │
└──────────────────────────┘     └──────────────────────────────────┘
```

## What's Verified Working

| Component | Status | Notes |
|-----------|--------|-------|
| Kernel boot (6.18.5, CONFIG_PCI=y, ACPI) | ✅ | DSDT loads, IOAPIC routing, `pci=off` at boot |
| Block devices (4 virtio-mmio drives) | ✅ | root + 3 squashfs |
| Guest network 192.0.2.2/24 | ✅ | Static IP via ioctl, ping verified |
| WebSocket shell `ws://192.0.2.2:2024` | ✅ | **PTY-backed interactive bash** — prompt, arrow keys, tab completion, Ctrl-C |
| Control API `http://192.0.2.2:2025` | ✅ | Bound and serving |

The PTY shell is verified end-to-end by the automated probe suite
(`process_api/examples/ws_probe.rs`) against a running process_api; boot it
and run the suite against `ws://192.0.2.2:2024`.

| Skills mounts | ✅ | `vdc → /mnt/skills/public`, `vdd → /mnt/skills/examples`, `vdb → /mnt/filestore` auto-mounted from `/mount_config.json` at boot |
| rclone filestore volume | ✅ (stand-in) | Valid squashfs seeding the canonical layout; real rclone binary not bundled |
| Control API file plane + sessions | ✅ | `/sessions`, `/files/list\|download\|upload` — shell↔API roundtrip covered by `console/test/smoke.mjs` |
| Console (visual layer) | ✅ | `console/` zero-build xterm.js terminal with files panel; see root README |

Envoy MITM wired via start.sh; snapstart not verified.

## Prerequisites

- Linux x86_64 host with KVM (`/dev/kvm`)
- Host kernel >= 6.1 (6.18 recommended)
- Rust + `x86_64-unknown-linux-musl` target
- `musl-gcc` / `x86_64-linux-musl-gcc`
- `cpio`, `gzip`, `mksquashfs`, `tune2fs`
- `websocat` (for testing the shell)
- sudo access (TAP setup, Firecracker launch)

## Build & Run

```bash
# 1. Build the kernel (first time, or after config changes)
cd sandbox/kernel && sudo ./build-kernel.sh

# 2. Build process_api (musl static)
cd sandbox/process_api
cargo build --release --target x86_64-unknown-linux-musl

# 3. Fetch static shell binaries (gitignored, one-time)
cd sandbox/tools && ./fetch-static-binaries.sh

# 4. Build initrd (process_api + bash + busybox + certs)
cd sandbox/initrd && ./build-initrd.sh

# 5. Set up host TAP device (requires sudo, once per reboot)
sudo ./sandbox/network/setup-tap.sh

# 6. Launch VM
sudo ./sandbox/firecracker/launch.sh

# 7. Connect shell (in another terminal)
websocat ws://192.0.2.2:2024
ls /
echo "hello from the VM"
whoami    # → root
```

## Guest Environment

- **PID 1**: `process_api` — Rust supervisor, serves WebSocket + Control API
- **Shell**: `/bin/bash` (static) on a real PTY — PS1 prompt, readline history
  and tab completion, Ctrl-C signal keys, `SIGWINCH` on resize
- **Coreutils**: busybox symlinks in `/bin/` — `ls`, `cat`, `mkdir`, `rm`, `cp`, `ps`, `id`, `whoami`, etc.
- **User**: root (uid 0)
- **Network**: eth0 with static IP 192.0.2.2/24
- **Kernel params**: `console=ttyS0 panic=1 nomodule pci=off`
- **Host gateway**: 192.0.2.1/24 via TAP, iptables DNAT for HTTP(S)

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| process_api | `process_api/` | PID 1 Rust supervisor (WebSocket, Control API) |
| kernel | `kernel/` | Custom Linux 6.18.5 microvm config |
| initrd | `initrd/` | Initramfs with process_api, bash, busybox, CA certs |
| rootfs | `rootfs/` | Ubuntu 24.04 ext4 image (block device) |
| tools | `tools/` | Static guest binaries (bash, busybox) |
| network | `network/` | TAP device setup for 192.0.2.0/24 |
| firecracker | `firecracker/` | VM launch + API scripts |
| proxy | `proxy/` | Envoy egress proxy (not yet wired) |
| skills | `skills/` | Skills as squashfs volumes |

## WebSocket Protocol

Each connection gets an interactive PTY-backed bash. Send raw bytes (keyboard
input: commands, arrows, Tab, Ctrl-C) — a Text frame that parses as a control
object is special:

```json
{"type":"resize","cols":120,"rows":40}
{"type":"ping"}
```

Output arrives chunk-by-chunk as JSON with a `stream` field (`stderr` merges
into `stdout`, like a real terminal):

```json
{"stream":"stdout","text":"ls output\r\n"}
{"event":"exit","code":0}
```

See `docs/websocket.md` for the full protocol and session lifecycle.

## Debugging

Serial console: `tail -f /tmp/fusebox-serial.log` (requires Firecracker to be running).

If the VM fails to boot, check:
- `/tmp/fusebox-serial.log` for kernel panics
- Firecracker API errors in launch.sh output
- `ip link show fc-tap0` — TAP must exist before launch
