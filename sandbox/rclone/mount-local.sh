#!/usr/bin/env bash
set -euo pipefail

# Stub replacement for rclone-filestore FUSE mounts
# Uses bind mounts from local directories instead of remote filestore API

STORAGE_BASE="${1:-/var/lib/fusebox}"
mkdir -p "${STORAGE_BASE}"/{outputs,uploads,transcripts,tool_results,skills-user}

echo "==> Mounting local storage directories into VM mount points..."

# These would be called from process_api's execute_system_mounts()
# or manually before launching the VM

mount --bind "${STORAGE_BASE}/outputs"     /mnt/user-data/outputs
mount --bind "${STORAGE_BASE}/uploads"     /mnt/user-data/uploads
mount --bind "${STORAGE_BASE}/transcripts" /mnt/transcripts
mount --bind "${STORAGE_BASE}/tool_results" /mnt/user-data/tool_results
mount --bind "${STORAGE_BASE}/skills-user"  /mnt/skills/user

echo "==> Local mounts active. Files persist at ${STORAGE_BASE}/"
