#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building skills-public.squashfs..."
mksquashfs "${SCRIPT_DIR}/public" "${SCRIPT_DIR}/skills-public.squashfs" \
  -comp zstd -b 131072 -noappend

echo "==> Building skills-examples.squashfs..."
mksquashfs "${SCRIPT_DIR}/examples" "${SCRIPT_DIR}/skills-examples.squashfs" \
  -comp zstd -b 131072 -noappend

echo "==> Done."
ls -lh "${SCRIPT_DIR}"/*.squashfs
