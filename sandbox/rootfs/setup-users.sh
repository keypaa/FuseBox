#!/usr/bin/env bash
set -euo pipefail

ROOTFS="$1"

echo "==> Configuring users inside rootfs..."

# Set root password (empty)
sudo chroot "${ROOTFS}" passwd -d root

# Ensure users exist (created in Dockerfile but may be missing from base image groups)
sudo chroot "${ROOTFS}" useradd -m -u 999 -s /bin/bash claude 2>/dev/null || true
sudo chroot "${ROOTFS}" useradd -m -u 1000 -s /bin/bash ubuntu 2>/dev/null || true

# Ensure /home/claude exists with correct ownership
sudo mkdir -p "${ROOTFS}/home/claude"
sudo chroot "${ROOTFS}" chown -R claude:ubuntu /home/claude

# Create required directories
sudo mkdir -p "${ROOTFS}/tmp/rclone-mounts"
sudo mkdir -p "${ROOTFS}/mnt/user-data/outputs"
sudo mkdir -p "${ROOTFS}/mnt/user-data/uploads"
sudo mkdir -p "${ROOTFS}/mnt/user-data/tool_results"
sudo mkdir -p "${ROOTFS}/mnt/transcripts"
sudo mkdir -p "${ROOTFS}/mnt/skills/public"
sudo mkdir -p "${ROOTFS}/mnt/skills/examples"
sudo mkdir -p "${ROOTFS}/mnt/skills/user"
sudo mkdir -p "${ROOTFS}/opt/rclone"
sudo mkdir -p "${ROOTFS}/opt/google/chrome"

# Chown writable runtime directories to claude:ubuntu.
# Note: We do NOT chown the entire rootfs (original spec had
# sudo chown -R claude:ubuntu "${ROOTFS}/") — that would break
# setuid binaries and system files. Only the directories that
# process_api/claude need to write to are chowned here.
sudo chroot "${ROOTFS}" chown -R claude:ubuntu /mnt/user-data
sudo chroot "${ROOTFS}" chown -R claude:ubuntu /mnt/transcripts
sudo chroot "${ROOTFS}" chown claude:ubuntu /tmp/rclone-mounts

# /etc/hosts with api.anthropic.com
cat << 'EOF' | sudo tee "${ROOTFS}/etc/hosts"
127.0.0.1 localhost
160.79.104.10 api.anthropic.com
EOF

# /etc/resolv.conf
echo "nameserver 8.8.8.8" | sudo tee "${ROOTFS}/etc/resolv.conf"

# Environment markers
echo "IS_SANDBOX=yes" | sudo tee -a "${ROOTFS}/etc/environment"

echo "==> User setup complete."
