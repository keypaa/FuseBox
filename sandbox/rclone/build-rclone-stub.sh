#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGING="${SCRIPT_DIR}/rclone-staging"
IMAGE="${SCRIPT_DIR}/rclone-filestore.squashfs"

echo "==> Building rclone/filestore volume (offline-safe)..."

# This volume stands in for Anthropic's rclone-backed user file store.
# It seeds the canonical layout so guest tooling has stable paths:
#   uploads/       user-uploaded input files (seed content is documentation;
#                  writable copies are layered via network/mount-local.sh)
#   outputs/       agent-produced artifacts land here in the full design
#   tool_results/  structured results from tool executions
# If a real rclone binary is available it is also shipped at
#   opt/rclone/rclone-filestore  (the path Anthropic's image uses).
rm -rf "${STAGING}"
mkdir -p "${STAGING}/filestore"/{uploads,outputs,tool_results}

cat > "${STAGING}/README.md" <<EOF
# FuseBox filestore volume

Read-only squashfs stand-in for Anthropic's rclone-backed user file store.
Built by sandbox/rclone/build-rclone-stub.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).

Layout:
  uploads/       user-uploaded input files (seed content is documentation)
  outputs/       agent-produced artifacts (see also /mnt/user-data/outputs)
  tool_results/  structured outputs from tool executions

The mount target is configured in sandbox/initrd/mount-config.json
(default /mnt/filestore). Writable variants can be layered later with
bind mounts (see sandbox/rclone/mount-local.sh) once persistence lands.
EOF

cat > "${STAGING}/filestore/uploads/README.txt" <<'EOF'
uploads/: user-supplied input files appear here.
This read-only volume only seeds the directory; writable storage is
layered separately (bind mounts or a future rw drive).
EOF

cat > "${STAGING}/filestore/outputs/README.txt" <<'EOF'
outputs/: agent-produced artifacts (documents, exports, results).
See /mnt/user-data/outputs (writable tmpfs) during sessions.
EOF

cat > "${STAGING}/filestore/tool_results/README.txt" <<'EOF'
tool_results/: structured outputs from tool executions.
EOF

if command -v rclone >/dev/null 2>&1; then
    echo "==> Shipping rclone binary as opt/rclone/rclone-filestore..."
    mkdir -p "${STAGING}/opt/rclone"
    cp "$(command -v rclone)" "${STAGING}/opt/rclone/rclone-filestore"
    chmod +x "${STAGING}/opt/rclone/rclone-filestore"
else
    echo "==> rclone binary not installed; shipping docs-only volume."
fi

echo "==> Building squashfs image..."
mksquashfs "${STAGING}" "${IMAGE}" -comp zstd -b 131072 -noappend

rm -rf "${STAGING}"

echo "==> Done: ${IMAGE}"
ls -lh "${IMAGE}"
