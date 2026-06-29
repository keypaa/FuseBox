#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FC_SOCKET="/tmp/fusebox-fc.sock"
FC_BINARY="${SCRIPT_DIR}/firecracker"

# Check for Firecracker binary
if [ ! -f "${FC_BINARY}" ]; then
    echo "==> Downloading Firecracker v1.16.0..."
    ARCH=$(uname -m)
    curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.0/firecracker-v1.16.0-${ARCH}.tgz \
        | tar -xz -C "${SCRIPT_DIR}" --strip-components=1 release-v1.16.0-${ARCH}/firecracker-v1.16.0-${ARCH}
    mv "${SCRIPT_DIR}/firecracker-v1.16.0-${ARCH}" "${FC_BINARY}"
    chmod +x "${FC_BINARY}"
fi

# Remove stale socket
rm -f "${FC_SOCKET}"

echo "==> Launching Firecracker microVM..."
sudo "${FC_BINARY}" --api-sock "${FC_SOCKET}" &
FC_PID=$!

# Wait for socket to appear
for i in $(seq 1 10); do
    [ -S "${FC_SOCKET}" ] && break
    sleep 0.5
done

echo "==> Configuring VM via API..."
# Set boot source
curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/boot-source' \
  -H 'Content-Type: application/json' \
  -d @- << 'EOF'
{
  "kernel_image_path": "../kernel/vmlinux",
  "boot_args": "console=ttyS0 reboot=k panic=1 nomodule random.trust_cpu=1 ipv6.disable=1 swiotlb=noforce rdinit=/process_api init_on_free=1 -- --firecracker-init --addr 0.0.0.0:2024 --max-ws-buffer-size 32768 --block-local-connections",
  "initrd_path": "../initrd/initrd.img"
}
EOF

# Set machine config
curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/machine-config' \
  -H 'Content-Type: application/json' \
  -d '{"vcpu_count":1,"mem_size_mib":3998,"smt":false,"track_dirty_pages":true}'

# Attach drives
curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/drives/rootfs' \
  -H 'Content-Type: application/json' \
  -d '{"drive_id":"rootfs","path_on_host":"../rootfs/rootfs.ext4","is_root_device":true,"is_read_only":false}'

curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/drives/rclone' \
  -H 'Content-Type: application/json' \
  -d '{"drive_id":"rclone","path_on_host":"../rclone/rclone-filestore.squashfs","is_root_device":false,"is_read_only":true}'

curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/drives/skills-public' \
  -H 'Content-Type: application/json' \
  -d '{"drive_id":"skills-public","path_on_host":"../skills/skills-public.squashfs","is_root_device":false,"is_read_only":true}'

curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/drives/skills-examples' \
  -H 'Content-Type: application/json' \
  -d '{"drive_id":"skills-examples","path_on_host":"../skills/skills-examples.squashfs","is_root_device":false,"is_read_only":true}'

# Attach network
curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/network-interfaces/eth0' \
  -H 'Content-Type: application/json' \
  -d '{"iface_id":"eth0","guest_mac":"02:fc:00:00:00:01","host_dev_name":"fc-tap0"}'

echo "==> Starting VM..."
curl --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/actions' \
  -H 'Content-Type: application/json' \
  -d '{"action_type":"InstanceStart"}'

echo "==> VM launched (Firecracker PID: ${FC_PID})"
echo "==> Connect to process_api WebSocket: ws://192.0.2.2:2024"
echo "==> Control API: http://192.0.2.2:2025/status"
echo "==> Serial console log: /tmp/fusebox-firecracker.log"
echo ""
echo "==> To connect to the VM's bash shell via WebSocket:"
echo "    websocat ws://192.0.2.2:2024"
