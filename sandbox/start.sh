#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

echo "=========================================="
echo "  FuseBox Sandbox - One-Command Start"
echo "=========================================="

# 0. Check and install prerequisites
echo "[0/5] Checking prerequisites..."
APT_PKGS=""
command -v cargo >/dev/null 2>&1 || MISSING="cargo"
command -v go >/dev/null 2>&1 || MISSING="$MISSING go"
command -v mksquashfs >/dev/null 2>&1 || APT_PKGS="$APT_PKGS squashfs-tools"
command -v openssl >/dev/null 2>&1 || APT_PKGS="$APT_PKGS openssl"
command -v flex >/dev/null 2>&1 || APT_PKGS="$APT_PKGS flex"
command -v bison >/dev/null 2>&1 || APT_PKGS="$APT_PKGS bison"
command -v x86_64-linux-musl-gcc >/dev/null 2>&1 || APT_PKGS="$APT_PKGS musl-tools"
if [ -n "${MISSING:-}" ]; then
  echo "ERROR: missing commands that can't be auto-installed:$MISSING"
  echo "  Install them manually (e.g., rustup, go) and re-run."
  exit 1
fi
if [ -n "$APT_PKGS" ]; then
  echo "  Installing missing system packages:$APT_PKGS..."
  sudo apt-get update -qq && sudo apt-get install -y -qq $APT_PKGS
fi

# Ensure musl Rust target is installed
if ! rustup target list --installed 2>/dev/null | grep -q x86_64-unknown-linux-musl; then
  echo "  Installing rustup target x86_64-unknown-linux-musl..."
  rustup target add x86_64-unknown-linux-musl
fi

# 1. Build everything
echo "[1/5] Building all components..."
make all

# 2. Set up TAP networking
echo "[2/5] Setting up TAP networking..."
sudo network/setup-tap.sh

# 3. Start the SDS server (background)
echo "[3/5] Starting SDS cert signing daemon..."
cd proxy/sds-server
CA_CERT_PATH="${SCRIPT_DIR}/certs/ca/egress-gateway-ca-production.pem" \
CA_KEY_PATH="${SCRIPT_DIR}/certs/ca/egress-ca.key" \
SDS_SOCKET_PATH=/var/run/envoy-sds.sock \
  sudo -E ./sds-server &
SDS_PID=$!
cd "${SCRIPT_DIR}"

# 4. Start Envoy proxy (background)
echo "[4/5] Starting Envoy egress proxy..."
sudo envoy -c "${SCRIPT_DIR}/proxy/envoy.yaml" --base-id 0 &
ENVOY_PID=$!
sleep 2

# 5. Launch the Firecracker VM
echo "[5/5] Launching Firecracker microVM..."
firecracker/launch.sh

echo ""
echo "=========================================="
echo "  Sandbox is running!"
echo "=========================================="
echo "  WebSocket API:  ws://192.0.2.2:2024"
echo "  Control API:    http://192.0.2.2:2025"
echo "  SDS PID:        ${SDS_PID}"
echo "  Envoy PID:      ${ENVOY_PID}"
echo ""
echo "  To stop: Ctrl+C or: sudo kill ${SDS_PID} ${ENVOY_PID}; network/teardown-tap.sh"
echo "=========================================="

# Wait for interrupt
trap "echo 'Shutting down...'; sudo kill ${SDS_PID} ${ENVOY_PID} 2>/dev/null; sudo network/teardown-tap.sh; exit 0" INT TERM
wait
