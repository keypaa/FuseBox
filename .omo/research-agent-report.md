# Firecracker microVM Sandbox: Build-from-Scratch Technical Summary

## 1. Firecracker Binary Version & Source

**Use v1.16.0** (released June 4, 2026) — it's the latest release and the **only version that officially supports v6.18 host kernel**.

```
ARCH=x86_64
curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.0/firecracker-v1.16.0-${ARCH}.tgz | tar -xz
mv release-v1.16.0-x86_64/firecracker-v1.16.0-x86_64 firecracker
```

Alternatively, build from source via `tools/devtool build` (requires Docker). The release includes `firecracker`, `jailer`, `snapshot-editor`, and `rebase-snap` binaries. The binary is statically linked against musl.

## 2. Custom Linux Kernel Build (v6.18.x)

### Source

Use the **Amazon Linux microVM kernel** from `github.com/amazonlinux/linux` under tags like `microvm-kernel-6.18.x-X.YYY.amzn2023`. These include Firecracker-specific backports not in mainline. The Firecracker repo's `resources/guest_configs/` directory provides reference `.config` files (for 5.10 and 6.1; adapt for 6.18).

Your existing config references kernel 6.18.5 compiled `Wed Jan 14 17:56:08 UTC 2026`.

### Critical Config Options

**Core Firecracker requirements (x86_64):**
```
CONFIG_KVM_GUEST=y          # KVM paravirtualized clock & guests
CONFIG_ACPI=y               # ACPI boot (required; supersedes MPTable)
CONFIG_PCI=y                # PCI needed for ACPI init (FC doesn't expose PCI devices directly unless --enable-pci)
CONFIG_SERIAL_8250_CONSOLE=y
CONFIG_PRINTK=y
CONFIG_BLK_DEV_INITRD=y    # initrd support
```

**VirtIO devices:**
```
CONFIG_VIRTIO_MMIO=y               # MMIO transport (legacy)
CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES=n  # Deprecated; use ACPI instead
CONFIG_VIRTIO_BLK=y                # Block device
CONFIG_VIRTIO_NET=y                # Network
CONFIG_VIRTIO_VSOCKETS=y           # Vsock
CONFIG_HW_RANDOM_VIRTIO=y         # Entropy (virtio-rng)
CONFIG_VIRTIO_BALLOON=y           # Memory balloon
CONFIG_VIRTIO_PCI=y               # PCI transport (if using --enable-pci)
CONFIG_MSDOS_PARTITION=y          # PartUUID support for root block
```

**Your specific config overrides:**
```
CONFIG_HZ_250=y                   # CONFIG_HZ=250 (not 100 or 1000)
CONFIG_PREEMPT_DYNAMIC=y          # Boot-time preempt mode selection
CONFIG_MODULES=n                  # nomodule — no loadable module support
CONFIG_SQUASHFS=y                 # SquashFS filesystem
CONFIG_SQUASHFS_ZSTD=y            # zstd compression for SquashFS
CONFIG_FUSE_FS=y                  # FUSE filesystem support
CONFIG_IO_URING=y                 # io_uring (FUSE can use io_uring)
CONFIG_RANDOM_TRUST_CPU=y         # Corresponds to random.trust_cpu=1 boot param
```

**PCI/PCIe required for modern boot:**
```
CONFIG_BLK_MQ_PCI=y
CONFIG_PCI_MMCONFIG=y
CONFIG_PCI_MSI=y
CONFIG_PCIEPORTBUS=y
CONFIG_PCI_HOST_COMMON=y
CONFIG_PCI_HOST_GENERIC=y
CONFIG_X86_MPPARSE=n             # Disable MPTable (deprecated)
```

### Key Boot Parameters (from your config)
```
console=ttyS0 reboot=k panic=1 nomodule random.trust_cpu=1 ipv6.disable=1
swiotlb=noforce rdinit=/process_api init_on_free=1 --
--firecracker-init --addr 0.0.0.0:2024 --max-ws-buffer-size 32768 --block-local-connections
```

- `nomodule` disables kernel module loading at runtime
- `random.trust_cpu=1` seeds kernel CSRNG from RDRAND/RDSEED (requires `CONFIG_RANDOM_TRUST_CPU=y`)
- `ipv6.disable=1` completely disables IPv6 stack
- `rdinit=/process_api` sets the init binary inside initrd
- `init_on_free=1` zeros freed pages (security hardening)

### Build Commands
```bash
git clone --depth 1 --branch microvm-kernel-6.18.X-XXX.amzn2023 \
  https://github.com/amazonlinux/linux.git
cd linux
cp /path/to/your/microvm.config .config
make olddefconfig   # Resolve dependencies
make -j$(nproc) vmlinux   # Produces uncompressed vmlinux (what FC needs)
```

## 3. Initramfs (initrd) Creation

The initrd must contain your custom `process_api` binary (compiled from `main.rs`). This binary runs as PID 1 via `rdinit=/process_api`.

### Build steps:

```bash
# Create initrd directory structure
mkdir -p initrd/{bin,dev,proc,sys,etc,tmp,opt,mnt}
mkdir -p initrd/mnt/skills/{public,examples}
mkdir -p initrd/tmp/rclone-mounts

# Copy the compiled process_api binary (statically linked!)
cp /path/to/process_api initrd/process_api
chmod +x initrd/process_api

# Create essential device nodes
mknod initrd/dev/console c 5 1
mknod initrd/dev/null c 1 3
mknod initrd/dev/ttyS0 c 4 64

# Add CA certs (for egress proxy trust)
mkdir -p initrd/etc/ssl/certs
cp egress-gateway-ca-production.pem initrd/etc/ssl/certs/
cp /etc/ssl/certs/ca-certificates.crt initrd/etc/ssl/certs/

# Add /mount_config.json if needed for execute_system_mounts()
# Add /etc/resolv.conf, /etc/hosts

# Create the initrd (cpio + gzip)
cd initrd
find . | cpio -o -H newc 2>/dev/null | gzip -9 > ../initrd.img
cd ..
```

**Critical**: The `process_api` binary **must be statically linked** (target `x86_64-unknown-linux-musl` in Rust) since there's no shared libc in the minimal initrd.

Key: In your config, `rdinit=/process_api` tells the kernel to execute `/process_api` from the initrd as PID 1, which then starts the zombie reaper, OOM guard, control API server (port 2025), and WebSocket gateway (port 2024).

## 4. Rootfs ext4 Image Creation

From your config (`firecracker-vm-config.json:30`):

```bash
# Create 256GB sparse ext4 image
truncate -s 268435456K rootfs.ext4    # 256GB = 268435456 KB

# Format with no journal (faster boot), zero UUID
mkfs.ext4 -L '' \
  -U 00000000-0000-0000-0000-000000000000 \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  -O ^has_journal \
  rootfs.ext4
```

**Key details:**
- `-O ^has_journal` — disables journaling for faster boot (acceptable since Firecracker VMs are ephemeral)
- `-E lazy_itable_init=0,lazy_journal_init=0` — eager initialization (no background thread)
- Zero UUID for reproducibility

### Reserved blocks (91% reserved = ~18GB usable)

After mounting and populating the rootfs:
```bash
# Mount, populate, unmount
mount -o loop rootfs.ext4 /mnt
# ... copy files into /mnt ...
umount /mnt

# Set 91% reserved blocks (enforces ~18GB usable quota)
# 61190791 reserved blocks (from your config)
tune2fs -r 61190791 rootfs.ext4
```

This requires `CAP_SYS_RESOURCE` to set reserved blocks above the normal 5% cap. After setting, the effective usable space drops to ~18GB, acting as a disk quota enforcement mechanism. The rootfs is attached as `/dev/vda` with `is_root_device: true`.

## 5. SquashFS Volume Creation

From your config (`firecracker-vm-config.json:43`), all squashfs volumes use zstd compression with 128KB block size:

```bash
# rclone-filestore volume (~9.9MB, 2 inodes)
mksquashfs /opt/rclone rclone-filestore.squashfs -comp zstd -b 131072 -noappend

# skills-public volume (~663KB, 243 inodes, 7 fragments)
mksquashfs /path/to/skills-public skills-public.squashfs -comp zstd -b 131072 -noappend

# skills-examples volume (~5.5MB, 231 inodes, 38 fragments)
mksquashfs /path/to/skills-examples skills-examples.squashfs -comp zstd -b 131072 -noappend
```

**Key options:**
- `-comp zstd` — zstd compression (fast decompress, good ratio; requires `CONFIG_SQUASHFS_ZSTD=y` in guest kernel)
- `-b 131072` — 128KB block size (larger blocks = better compression ratio)
- `-noappend` — create fresh archive, don't append to existing

### Mounting inside the guest:
```bash
mount -o ro /dev/vdb /opt/rclone             # drive_id: rclone
mount -o ro /dev/vdc /mnt/skills/public      # drive_id: skills-public
mount -o ro /dev/vdd /mnt/skills/examples    # drive_id: skills-examples
```

These are read-only drives (`is_read_only: true`). The squashfs files are independently updatable without rebuilding the rootfs.

## 6. TAP Networking (192.0.2.0/24 Topology)

Your config uses **RFC 5737 TEST-NET-1** (`192.0.2.0/24`), which has special properties: it's non-routable on the public internet and often used to prevent accidental leakage.

### Host-side setup:

```bash
# Create TAP device
ip tuntap add fc-tap0 mode tap

# Assign host gateway IP
ip addr add 192.0.2.1/24 dev fc-tap0

# Set MTU to 1400 (accounts for AWS VPC VXLAN overlay)
ip link set fc-tap0 mtu 1400 up

# Set gateway MAC address (02:fc prefix = locally administered unicast)
ip link set fc-tap0 address 02:fc:00:00:00:05

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# NAT for outbound traffic
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i fc-tap0 -o eth0 -j ACCEPT
```

### Guest-side setup (inside the VM):

```bash
ip addr add 192.0.2.2/24 dev eth0
ip link set eth0 mtu 1400 up
ip route add default via 192.0.2.1
echo 'nameserver 8.8.8.8' > /etc/resolv.conf
```

### Network topology:

| Role | IP | MAC |
|------|-----|-----|
| Host TAP gateway | 192.0.2.1 | 02:fc:00:00:00:05 |
| Guest eth0 | 192.0.2.2 | 02:fc:00:00:00:01 (set by FC via `guest_mac`) |

The Envoy egress proxy listens on `192.0.2.1:80` and `192.0.2.1:443` (transparent proxy + TLS MITM). MMDS is explicitly disabled to prevent metadata leakage from `169.254.169.254`.

**MTU 1400**: Critical because AWS VPC uses VXLAN encapsulation (adds ~50 bytes overhead). Standard 1500 MTU minus overhead = 1400 to avoid fragmentation.

## 7. Snapshot/Snapstart Feature

### Architecture (two-phase boot)

**Phase 1 — Template VM (cold boot):**
1. Start a fresh Firecracker microVM with kernel, initrd, rootfs, drives, network
2. Wait for `process_api` to signal readiness (e.g., write to a file/pipe)
3. Pause the VM and take a **Full** snapshot

**Phase 2 — Resume from snapshot (fast boot ~8.3s):**
1. Start Firecracker with `LoadSnapshot` (pointing to snapshot + memory files)
2. Resume the VM
3. POST `/mount_root` via the Control API (port 2025) to inject session-specific rclone config

### Required configuration

```
"track_dirty_pages": true   # Required for snapshot support (set in machine-config)
```

### API workflow for creating a snapshot:

```bash
API_SOCKET="/tmp/firecracker.socket"

# 1. Pause the VM
curl --unix-socket $API_SOCKET -X PATCH 'http://localhost/vm' \
  -H 'Content-Type: application/json' \
  -d '{"state": "Paused"}'

# 2. Create full snapshot
curl --unix-socket $API_SOCKET -X PUT 'http://localhost/snapshot/create' \
  -H 'Content-Type: application/json' \
  -d '{
    "snapshot_type": "Full",
    "snapshot_path": "/path/to/vm.snapshot",
    "mem_file_path": "/path/to/vm.memory"
  }'
```

### Loading/resuming a snapshot:

```bash
# New Firecracker process
./firecracker --api-sock /tmp/fc-snap.socket

# Load snapshot (before boot)
curl --unix-socket /tmp/fc-snap.socket -X PUT 'http://localhost/snapshot/load' \
  -H 'Content-Type: application/json' \
  -d '{
    "snapshot_path": "/path/to/vm.snapshot",
    "mem_backend": {
      "backend_type": "File",
      "backend_path": "/path/to/vm.memory"
    },
    "track_dirty_pages": true,
    "resume_vm": true
  }'
```

**Key details:**
- Memory is loaded on-demand via `MAP_PRIVATE` mmap — pages are faulted in lazily (copy-on-write)
- The memory file **must remain intact** for the VM's lifetime (not the case for the state file, which is released after load)
- On snapshot resume, Firecracker updates the VMGenID, causing the guest kernel (>= 5.18) to **reseed its CRNG** — critical for cryptographic uniqueness across clones
- Disk files are **not managed by Firecracker** — you must ensure the same backing files are available at the same paths
- Vsock connections are reset across snapshots; listen sockets survive
- Network connectivity is **not guaranteed** after resume — existing TCP connections may break
- Diff snapshots (developer preview) track only dirtied pages when `track_dirty_pages=true`

### Diff snapshots (optional, for layered updates):
Use `snapshot-editor edit-memory rebase` to merge diff layers onto a base for a resumable full snapshot.

## 8. Minimum Host Kernel Version

From the official kernel policy:

| Host Kernel | Min Firecracker Version | Min End of Support |
|-------------|------------------------|--------------------|
| **v5.10** | v1.0.0 | 2024-01-31 (expired) |
| **v6.1** | v1.5.0 | 2025-10-12 |
| **v6.18** | v1.16.0 | 2028-05-28 |

**For your use case (v6.18 guest + snapshot features):**
- **Host kernel**: v6.1 minimum (to use v1.5.0+). **v6.18 recommended** (required for v1.16.0's full feature set including ACPI VMGenID fixes, VMClock, etc.)
- **KVM required**: `/dev/kvm` must be accessible (rw). On AWS, only `.metal` instances expose KVM.
- **cgroups v2 recommended** on the host — cgroups v1 causes high snapshot restore latency

### Snapshot cross-kernel compatibility:
Snapshots taken on v5.10 hosts **can** be restored on v6.1 hosts (same instance family), but **not vice versa**. Cross-instance-family restore is not supported (e.g., m5n→m6i won't work).
