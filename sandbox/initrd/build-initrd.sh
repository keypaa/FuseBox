#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROCESS_API="${SCRIPT_DIR}/../process_api/target/x86_64-unknown-linux-musl/release/process_api"
STATIC_BASH="${SCRIPT_DIR}/../tools/bin/bash"
STATIC_BUSYBOX="${SCRIPT_DIR}/../tools/bin/busybox"
INITRD_DIR="${SCRIPT_DIR}/initrd-staging"

if [ ! -f "${PROCESS_API}" ]; then
    echo "ERROR: process_api binary not found. Run 'cargo build --release --target x86_64-unknown-linux-musl' first."
    exit 1
fi

# Fetch static bash/busybox if not present (they are gitignored).
if [ ! -f "${STATIC_BASH}" ] || [ ! -f "${STATIC_BUSYBOX}" ]; then
    echo "==> Static shell binaries missing; fetching..."
    "${SCRIPT_DIR}/../tools/fetch-static-binaries.sh"
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

echo "==> Installing static bash as /bin/bash..."
mkdir -p "${INITRD_DIR}/bin"
cp "${STATIC_BASH}" "${INITRD_DIR}/bin/bash"
chmod +x "${INITRD_DIR}/bin/bash"

echo "==> Installing static busybox with coreutils applets..."
cp "${STATIC_BUSYBOX}" "${INITRD_DIR}/bin/busybox"
chmod +x "${INITRD_DIR}/bin/busybox"
for applet in ls cat mkdir rm cp mv pwd touch find grep head tail wc printf echo env id uname mount ps kill sleep tar gzip gunzip cpio df du clear true false whoami su sh ash wget; do
    ln -sf busybox "${INITRD_DIR}/bin/${applet}"
done

# Device nodes are provided by devtmpfs at runtime (kernel auto-mounts).
# Explicit mknod is not needed and requires root on the build host.

echo "==> Installing mount config..."
cp "${SCRIPT_DIR}/mount-config.json" "${INITRD_DIR}/mount_config.json"

echo "==> Creating /etc/hosts and /etc/resolv.conf..."
cat << 'EOF' > "${INITRD_DIR}/etc/hosts"
127.0.0.1 localhost
160.79.104.10 api.anthropic.com
EOF
echo "nameserver 8.8.8.8" > "${INITRD_DIR}/etc/resolv.conf"

echo "==> Creating /etc/passwd and /etc/group..."
cat << 'EOF' > "${INITRD_DIR}/etc/passwd"
root:x:0:0:root:/root:/bin/bash
nobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin
EOF
cat << 'EOF' > "${INITRD_DIR}/etc/group"
root:x:0:
nobody:x:65534:
EOF

echo "==> Packaging initrd.img (cpio + gzip)..."
cd "${INITRD_DIR}"
find . | cpio -o -H newc 2>/dev/null | gzip -9 > "${SCRIPT_DIR}/initrd.img"
cd "${SCRIPT_DIR}"

echo "==> Cleaning up staging directory..."
rm -rf "${INITRD_DIR}"

echo "==> Done: ${SCRIPT_DIR}/initrd.img"
ls -lh "${SCRIPT_DIR}/initrd.img"
