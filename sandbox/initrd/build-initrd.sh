#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROCESS_API="${SCRIPT_DIR}/../process_api/target/x86_64-unknown-linux-musl/release/process_api"
INITRD_DIR="${SCRIPT_DIR}/initrd-staging"

if [ ! -f "${PROCESS_API}" ]; then
    echo "ERROR: process_api binary not found. Run 'cargo build --release --target x86_64-unknown-linux-musl' first."
    exit 1
fi

echo "==> Creating initrd staging directory..."
rm -rf "${INITRD_DIR}"
mkdir -p "${INITRD_DIR}"/{bin,dev,proc,sys,etc,etc/ssl/certs,tmp,opt/mnt,mnt/skills/{public,examples,user}}
mkdir -p "${INITRD_DIR}/tmp/rclone-mounts"
mkdir -p "${INITRD_DIR}/mnt/user-data"/{outputs,uploads,tool_results}
mkdir -p "${INITRD_DIR}/mnt/transcripts"

echo "==> Installing process_api as /process_api (PID 1)..."
cp "${PROCESS_API}" "${INITRD_DIR}/process_api"
chmod +x "${INITRD_DIR}/process_api"

echo "==> Installing CA certificates..."
cp "${SCRIPT_DIR}"/*.pem "${INITRD_DIR}/etc/ssl/certs/"
# Also create a unified bundle
cat "${SCRIPT_DIR}"/*.pem > "${INITRD_DIR}/etc/ssl/certs/ca-certificates.crt"

echo "==> Creating essential device nodes..."
sudo mknod "${INITRD_DIR}/dev/console" c 5 1
sudo mknod "${INITRD_DIR}/dev/null" c 1 3
sudo mknod "${INITRD_DIR}/dev/ttyS0" c 4 64
sudo mknod "${INITRD_DIR}/dev/fuse" c 10 229

echo "==> Installing mount config..."
cp "${SCRIPT_DIR}/mount-config.json" "${INITRD_DIR}/mount_config.json"

echo "==> Creating /etc/hosts and /etc/resolv.conf..."
cat << 'EOF' > "${INITRD_DIR}/etc/hosts"
127.0.0.1 localhost
160.79.104.10 api.anthropic.com
EOF
echo "nameserver 8.8.8.8" > "${INITRD_DIR}/etc/resolv.conf"

echo "==> Packaging initrd.img (cpio + gzip)..."
cd "${INITRD_DIR}"
find . | cpio -o -H newc 2>/dev/null | gzip -9 > "${SCRIPT_DIR}/initrd.img"
cd "${SCRIPT_DIR}"

echo "==> Cleaning up staging directory..."
rm -rf "${INITRD_DIR}"

echo "==> Done: ${SCRIPT_DIR}/initrd.img"
ls -lh "${SCRIPT_DIR}/initrd.img"
