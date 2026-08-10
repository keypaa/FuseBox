#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
mkdir -p "${BIN_DIR}"

echo "==> Fetching static bash 5.2.015 (musl)..."
curl -fsSL -o "${BIN_DIR}/bash" \
  https://github.com/robxu9/bash-static/releases/download/5.2.015-1.2.3-2/bash-linux-x86_64
chmod +x "${BIN_DIR}/bash"

echo "==> Fetching static busybox 1.35.0 (musl)..."
curl -fsSL -o "${BIN_DIR}/busybox" \
  https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox
chmod +x "${BIN_DIR}/busybox"

echo "==> Done. Static binaries installed in ${BIN_DIR}"
