#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-create}"
FC_SOCKET="/tmp/fusebox-fc.sock"
SNAPSHOT_DIR="$(cd "$(dirname "$0")" && pwd)/../snapshots"

mkdir -p "${SNAPSHOT_DIR}"

# Firecracker runs as root (via sudo), so its API socket is root-owned.
# Use sudo for the API calls unless we can already reach the socket as the
# current user (e.g. launch.sh chowned it).
if [ "$(id -u)" -ne 0 ] && ! curl -s --max-time 1 --unix-socket "${FC_SOCKET}" http://localhost/vm >/dev/null 2>&1; then
  SUDO_CURL="sudo curl"
else
  SUDO_CURL="curl"
fi

case "${ACTION}" in
  create)
    echo "==> Pausing VM for snapshot..."
    ${SUDO_CURL} --unix-socket "${FC_SOCKET}" -X PATCH 'http://localhost/vm' \
      -H 'Content-Type: application/json' \
      -d '{"state":"Paused"}'

    echo "==> Creating full snapshot..."
    ${SUDO_CURL} --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/snapshot/create' \
      -H 'Content-Type: application/json' \
      -d "{
        \"snapshot_type\": \"Full\",
        \"snapshot_path\": \"${SNAPSHOT_DIR}/vm.snapshot\",
        \"mem_file_path\": \"${SNAPSHOT_DIR}/vm.memory\"
      }"

    echo "==> Snapshot saved to ${SNAPSHOT_DIR}/"
    echo "==> Resuming VM..."
    ${SUDO_CURL} --unix-socket "${FC_SOCKET}" -X PATCH 'http://localhost/vm' \
      -H 'Content-Type: application/json' \
      -d '{"state":"Resumed"}'
    ;;

  restore)
    FC_RESTORE_SOCKET="/tmp/fusebox-fc-restore.sock"
    FC_BINARY="$(cd "$(dirname "$0")" && pwd)/firecracker"
    rm -f "${FC_RESTORE_SOCKET}"

    # A running Firecracker holds fc-tap0's TUN fd ("Resource busy" on attach).
    # Kill any stale instance so the restored VM can bind the network.
    if pgrep -x firecracker >/dev/null 2>&1; then
      echo "==> Killing stale Firecracker instance(s) to free fc-tap0..."
      pkill -x firecracker || true
      sleep 1
      pkill -9 -x firecracker 2>/dev/null || true
    fi

    echo "==> Starting Firecracker for restore..."
    sudo "${FC_BINARY}" --api-sock "${FC_RESTORE_SOCKET}" &
    RESTORE_PID=$!

    for i in $(seq 1 10); do
      [ -S "${FC_RESTORE_SOCKET}" ] && break
      sleep 0.5
    done

    echo "==> Loading snapshot..."
    ${SUDO_CURL} --unix-socket "${FC_RESTORE_SOCKET}" -X PUT 'http://localhost/snapshot/load' \
      -H 'Content-Type: application/json' \
      -d "{
        \"snapshot_path\": \"${SNAPSHOT_DIR}/vm.snapshot\",
        \"mem_backend\": {
          \"backend_type\": \"File\",
          \"backend_path\": \"${SNAPSHOT_DIR}/vm.memory\"
        },
        \"track_dirty_pages\": true,
        \"resume_vm\": true
      }"

    echo "==> VM restored from snapshot (PID: ${RESTORE_PID})"
    echo "==> POST /mount_root with session-specific config to configure rclone mounts"
    ;;

  *)
    echo "Usage: $0 {create|restore}"
    exit 1
    ;;
esac