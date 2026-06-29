#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RCLONE_DIR="${SCRIPT_DIR}/rclone-staging"

echo "==> Installing standard rclone..."
which rclone &>/dev/null || {
    curl -L https://rclone.org/install.sh | sudo bash
}

echo "==> Creating rclone staging directory..."
rm -rf "${RCLONE_DIR}"
mkdir -p "${RCLONE_DIR}/opt/rclone"

echo "==> Copying rclone binary..."
cp "$(which rclone)" "${RCLONE_DIR}/opt/rclone/rclone-filestore"
chmod +x "${RCLONE_DIR}/opt/rclone/rclone-filestore"

echo "==> Building rclone squashfs volume..."
mksquashfs "${RCLONE_DIR}/opt" "${SCRIPT_DIR}/rclone-filestore.squashfs" \
    -comp zstd -b 131072 -noappend

rm -rf "${RCLONE_DIR}"

echo "==> Done: ${SCRIPT_DIR}/rclone-filestore.squashfs"
ls -lh "${SCRIPT_DIR}/rclone-filestore.squashfs"

echo ""
echo "NOTE: Standard rclone does not support the filestore/memory backends."
echo "For local testing, mount directories directly via /etc/fstab or the"
echo "process_api mount_config.json with type='local'."
echo ""
echo "For a full rclone-filestore replacement, see sandbox/rclone/local-filestore/"
