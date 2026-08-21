# Architecture

## System Overview

FuseBox reproduces Anthropic's Claude sandbox using Firecracker microVMs. The goal is to run code execution inside an isolated VM with a minimal attack surface, communicating over a local network with the host.

```
Host (Linux, KVM)                    Firecracker microVM
┌─────────────────────┐             ┌─────────────────────────────┐
│                     │             │                             │
│  process_api host   │             │  /process_api (PID 1)       │
│  (not yet built)    │             │  ├── WebSocket 0.0.0.0:2024 │
│                     │             │  ├── Control 0.0.0.0:2025    │
│  Envoy proxy        │             │  └── /bin/bash subprocesses  │
│  (TLS MITM, 80→1080,│             │                             │
│   443→1443)         │             │  Block devices:              │
│                     │             │  /dev/vda → rootfs.ext4      │
│  TAP fc-tap0        │ ◄────────► │  /dev/vdb → rclone           │
│  192.0.2.1/24       │   virtio   │  /dev/vdc → skills-public    │
│                     │    net     │  /dev/vdd → skills-examples  │
└─────────────────────┘             └─────────────────────────────┘
```

## Boot Chain

1. **Firecracker** loads `kernel/vmlinux` + `initrd/initrd.img` and block devices
2. **Kernel** boots with `console=ttyS0 panic=1 nomodule random.trust_cpu=1 ipv6.disable=1 net.ifnames=0 swiotlb=noforce rdinit=/process_api init_on_free=1 pci=off`
3. **ACPI** loads AML tables (DSDT etc.) — requires `CONFIG_PCI=y` even with `pci=off` (see Troubleshooting)
4. **virtio-mmio** devices register: vda (root), vdb-vdd (drives), eth0 (network)
5. **process_api** starts as PID 1, mounts devtmpfs/proc, configures eth0, binds WebSocket + Control API

## Networking

### Guest Side
- Interface: eth0 (virtio-mmio)
- IP: 192.0.2.2/24 (static, configured via ioctl in `setup_guest_network`)
- Gateway: 192.0.2.1 (host TAP)

### Host Side
- TAP device: fc-tap0
- IP: 192.0.2.1/24
- MTU: 1400
- MAC: 02:fc:00:00:00:05
- iptables DNAT: host:80 → 192.0.2.1:1080, host:443 → 192.0.2.1:1443
- iptables MASQUERADE on default route interface

### Wire Protocol
Guest → Host traffic is routed through the TAP device. The kernel's virtio-net handles the data path. No custom framing — standard Ethernet over TAP.

## Block Devices

| Device | File | Purpose |
|--------|------|---------|
| /dev/vda | `rootfs/rootfs.ext4` | Root filesystem (Ubuntu 24.04 base) |
| /dev/vdb | `rclone/rclone-filestore.squashfs` | Rclone storage |
| /dev/vdc | `skills/skills-public.squashfs` | Public skills |
| /dev/vdd | `skills/skills-examples.squashfs` | Example skills |

## Kernel Config Highlights

Key options in `sandbox/kernel/microvm.config`:

- `CONFIG_PCI=y` + `CONFIG_PCI_MSI=y` — required for ACPI on x86_64
- `CONFIG_ACPI=y` — IOAPIC interrupt routing
- `CONFIG_VIRTIO_MMIO=y` — block/network devices
- `CONFIG_BLK_DEV_INITRD=y` — initrd support
- `CONFIG_EXT4_FS=y` — rootfs
- `CONFIG_SQUASHFS=y` + `CONFIG_SQUASHFS_XZ=y` — skills volumes
- `CONFIG_VIRTIO_BLK=y` + `CONFIG_VIRTIO_NET=y` — device drivers
- `CONFIG_NETFILTER=y` — iptables (guest)

## process_api (Rust)

PID 1 supervisor written in Rust (musl static binary). Responsibilities:

- Mount devtmpfs, proc, sysfs
- Configure network interface (static IP via ioctl)
- Bind WebSocket server on 0.0.0.0:2024 (interactive shell sessions)
- Bind Control API on 0.0.0.0:2025 (health checks, mount config)
- Spawn `/bin/bash` for each WebSocket connection
- Relay stdin/stdout/stderr as JSON lines
- OOM guard, zombie reaper
