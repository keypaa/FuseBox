# FuseBox Sandbox

A faithful reproduction of Anthropic's Claude sandbox environment using Firecracker microVMs.

## Architecture

```
Host                         Firecracker VM
┌──────────────────┐        ┌──────────────────────────┐
│  Envoy Proxy     │ ←──── │  process_api (PID 1)     │
│  (TLS MITM)      │        │  ├── WebSocket :2024     │
│  + SDS Server    │        │  ├── Control   :2025     │
│  + CA Certs      │        │  ├── OOM Guard            │
│                  │        │  ├── Zombie Reaper        │
│  TAP: fc-tap0    │        │  └── bash subprocesses    │
│  192.0.2.1/24    │        │                           │
│                  │        │  /mnt/skills/ (squashfs)  │
│                  │        │  /home/claude/ (rootfs)    │
└──────────────────┘        └──────────────────────────┘
```

## Prerequisites

- Linux x86_64 host with KVM (`/dev/kvm`)
- Host kernel >= 6.1 (6.18 recommended)
- Docker (for rootfs build)
- Go 1.22+, Rust/Cargo, build-essential, flex, bison, libelf-dev, libssl-dev
- `mksquashfs`, `tune2fs`, `envoy`

## Quick Start

```bash
# Build everything and launch
sudo ./start.sh

# Or step by step:
make all
sudo network/setup-tap.sh
firecracker/launch.sh

# Run integration tests
./test.sh
```

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| process_api | `process_api/` | PID 1 Rust supervisor (WebSocket, cgroups, OOM) |
| kernel | `kernel/` | Custom Linux 6.18.5 with microvm config |
| initrd | `initrd/` | Initramfs with process_api + CA certs |
| rootfs | `rootfs/` | Ubuntu 24.04 ext4 image with all tooling |
| skills | `skills/` | Public + example skills as squashfs volumes |
| proxy | `proxy/` | Envoy egress proxy + SDS cert server |
| network | `network/` | TAP device setup for 192.0.2.0/24 |
| firecracker | `firecracker/` | VM launch + snapshot scripts |

## Snapshot (Snapstart)

```bash
# Create a snapshot from a running VM
firecracker/snapshot.sh create

# Restore from snapshot (fast ~8s boot)
firecracker/snapshot.sh restore

# Then inject session-specific mount config:
curl http://192.0.2.2:2025/mount_root -X POST -d @session-config.json
```
