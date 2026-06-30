#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="ghcr.io/keypaa/fusebox-rootfs"
IMAGE_NAME="fusebox-rootfs"
ROOTFS_SIZE_KB=268435456  # 256GB sparse

# Wrap docker calls via sg for group access
docker_sg() { sg docker -c "docker $*"; }

# Try pulling from registry first (faster than building)
echo "==> Attempting to pull rootfs image from ${REGISTRY}..."
PULL_ARGS=""
if docker_sg pull "${REGISTRY}:latest" 2>/dev/null; then
    docker_sg tag "${REGISTRY}:latest" "${IMAGE_NAME}:latest"
    echo "==> Using pulled image."
    PULL_ARGS="--cache-from ${REGISTRY}:latest"
fi

echo "==> Building rootfs Docker image..."
docker_sg build --network host ${PULL_ARGS} -t "${IMAGE_NAME}" "${SCRIPT_DIR}"
docker_sg tag "${IMAGE_NAME}:latest" "${REGISTRY}:latest"

echo "==> Creating rootfs ext4 image..."
# Remove old rootfs if present
rm -f "${SCRIPT_DIR}/rootfs.ext4"
# Create sparse 256GB file
truncate -s "${ROOTFS_SIZE_KB}K" "${SCRIPT_DIR}/rootfs.ext4"

# Format: no journal, zero UUID, eager init
mkfs.ext4 -F -L '' \
  -U 00000000-0000-0000-0000-000000000000 \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  -O ^has_journal \
  "${SCRIPT_DIR}/rootfs.ext4"

echo "==> Copying filesystem from Docker container..."
CONTAINER_ID=$(docker_sg create "${IMAGE_NAME}" /bin/true)
MOUNT_POINT=$(mktemp -d)

sudo mount -o loop "${SCRIPT_DIR}/rootfs.ext4" "${MOUNT_POINT}"
docker_sg export "${CONTAINER_ID}" | sudo tar -C "${MOUNT_POINT}" -xf -
docker_sg rm "${CONTAINER_ID}" > /dev/null

echo "==> Running user setup..."
sudo "${SCRIPT_DIR}/setup-users.sh" "${MOUNT_POINT}"

echo "==> Setting reserved blocks (~18GB usable)..."
sudo umount "${MOUNT_POINT}"
tune2fs -m 50 "${SCRIPT_DIR}/rootfs.ext4" 2>/dev/null || true

rmdir "${MOUNT_POINT}"

echo "==> Done: ${SCRIPT_DIR}/rootfs.ext4"
ls -lh "${SCRIPT_DIR}/rootfs.ext4"
echo "==> Actual disk usage:"
du -sh "${SCRIPT_DIR}/rootfs.ext4"
