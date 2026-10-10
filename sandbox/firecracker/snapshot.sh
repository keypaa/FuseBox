#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-create}"
FC_SOCKET="/tmp/fusebox-fc.sock"
SNAPSHOT_DIR="$(cd "$(dirname "$0")" && pwd)/../snapshots"

mkdir -p "${SNAPSHOT_DIR}"

# Firecracker runs as root (via sudo), so its API socket is root-owned.
# Use sudo for the API calls unless we can already reach the socket as the
# current user (e.g. launch.sh chowned it).
is_root_socket() {
  [ "$(id -u)" -ne 0 ] && ! curl -s --max-time 1 --unix-socket "$1" http://localhost/vm >/dev/null 2>&1
}

case "${ACTION}" in
  create)
    FC_CURL="curl"
    is_root_socket "${FC_SOCKET}" && FC_CURL="sudo curl"

    echo "==> Pausing VM for snapshot..."
    ${FC_CURL} --unix-socket "${FC_SOCKET}" -X PATCH 'http://localhost/vm' \
      -H 'Content-Type: application/json' \
      -d '{"state":"Paused"}'

    echo "==> Creating full snapshot..."
    ${FC_CURL} --unix-socket "${FC_SOCKET}" -X PUT 'http://localhost/snapshot/create' \
      -H 'Content-Type: application/json' \
      -d "{
        \"snapshot_type\": \"Full\",
        \"snapshot_path\": \"${SNAPSHOT_DIR}/vm.snapshot\",
        \"mem_file_path\": \"${SNAPSHOT_DIR}/vm.memory\"
      }"

    echo "==> Snapshot saved to ${SNAPSHOT_DIR}/"
    echo "==> Resuming VM..."
    ${FC_CURL} --unix-socket "${FC_SOCKET}" -X PATCH 'http://localhost/vm' \
      -H 'Content-Type: application/json' \
      -d '{"state":"Resumed"}'
    ;;

  restore)
    FC_RESTORE_SOCKET="/tmp/fusebox-fc-restore.sock"
    FC_BINARY="$(cd "$(dirname "$0")" && pwd)/firecracker"
    rm -f "${FC_RESTORE_SOCKET}"

    # A running Firecracker holds fc-tap0's TUN fd ("Resource busy" on attach).
    # Kill any stale instance so the restored VM can bind the network.
    # Firecracker runs as root, so the kill needs sudo.
    if pgrep -x firecracker >/dev/null 2>&1; then
      echo "==> Killing stale Firecracker instance(s) to free fc-tap0..."
      sudo pkill -x firecracker || true
      sleep 1
      sudo pkill -9 -x firecracker 2>/dev/null || true
    fi

    echo "==> Starting Firecracker for restore..."
    sudo "${FC_BINARY}" --api-sock "${FC_RESTORE_SOCKET}" &
    RESTORE_PID=$!

    for i in $(seq 1 10); do
      [ -S "${FC_RESTORE_SOCKET}" ] && break
      sleep 0.5
    done

    # The restore Firecracker also runs as root, so its socket may be
    # root-owned too — re-check before issuing the API call.
    FC_CURL="curl"
    is_root_socket "${FC_RESTORE_SOCKET}" && FC_CURL="sudo curl"

    echo "==> Loading snapshot..."
    ${FC_CURL} --unix-socket "${FC_RESTORE_SOCKET}" -X PUT 'http://localhost/snapshot/load' \
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