#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

# If we are running via sudo, set up the environment to use the invoking user's
# rustup toolchain so that cargo works. We keep running as root (so privileged
# steps like TAP setup, SDS, Envoy, Firecracker don't need additional sudo),
# but we set RUSTUP_HOME/CARGO_HOME/PATH to point to the user's rustup.
if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" -eq 0 ]; then
  # Determine the invoking user's home directory
  if [ -n "${SUDO_USER}" ]; then
    USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    if [ -z "$USER_HOME" ]; then
      # Fallback (should not happen on normal systems)
      USER_HOME="/home/$SUDO_USER"
    fi
  else
    USER_HOME="$HOME"
  fi
  export RUSTUP_HOME="${USER_HOME}/.rustup"
  export CARGO_HOME="${USER_HOME}/.cargo"
  export PATH="${USER_HOME}/.cargo/bin:$PATH"
fi

# Keep sudo timestamp alive to avoid multiple password prompts
sudo -v
while true; do sudo -n true; sleep 10; done &
SUDO_LOOP_PID=$!
trap "kill $SUDO_LOOP_PID 2>/dev/null" INT TERM EXIT

echo "=========================================="
echo "  FuseBox Sandbox - One-Command Start"
echo "=========================================="

# 0. Check and install prerequisites
echo "[0/5] Checking prerequisites..."
MISSING=""
PKGS=""
command -v cargo >/dev/null 2>&1 || MISSING="cargo"
command -v go >/dev/null 2>&1 || MISSING="$MISSING go"
command -v mksquashfs >/dev/null 2>&1 || PKGS="$PKGS squashfs-tools"
command -v openssl >/dev/null 2>&1 || PKGS="$PKGS openssl"
command -v flex >/dev/null 2>&1 || PKGS="$PKGS flex"
command -v bison >/dev/null 2>&1 || PKGS="$PKGS bison"
command -v bc >/dev/null 2>&1 || PKGS="$PKGS bc"
# Check for Arch packages (omarchy/arch)
if ! pacman -Qs libelf >/dev/null 2>&1; then
  PKGS="$PKGS libelf"
fi
if ! pacman -Qs gmp >/dev/null 2>&1; then
  PKGS="$PKGS gmp"
fi
if ! pacman -Qs libmpc >/dev/null 2>&1; then
  PKGS="$PKGS libmpc"
fi
if ! pacman -Qs musl >/dev/null 2>&1; then
  PKGS="$PKGS musl"
fi
if ! pacman -Qs util-linux >/dev/null 2>&1; then
  PKGS="$PKGS util-linux"
fi
if [ -n "${MISSING:-}" ]; then
  echo "ERROR: missing commands that can't be auto-installed:$MISSING"
  echo "  Install them manually (e.g., rustup, go) and re-run."
  exit 1
fi
if [ -n "$PKGS" ]; then
  echo "  Installing missing system packages:$PKGS..."
  sudo pacman -Sy --noconfirm $PKGS
fi

# Warn if envoy is missing (needed for egress proxy)
if ! command -v envoy >/dev/null 2>&1; then
  echo "  Note: envoy not installed. Egress proxy will be skipped."
  echo "  Install manually: https://www.envoyproxy.io/docs/envoy/latest/start/install"
fi

# 1. Build everything
echo "[1/5] Building all components..."
# Run as root but with user's rustup toolchain configured above.
make all

# 2. Set up TAP networking
echo "[2/5] Setting up TAP networking..."
sudo network/setup-tap.sh

# 3. Start the SDS server (background)
echo "[3/5] Starting SDS cert signing daemon..."
cd proxy/sds-server
CA_CERT_PATH="${SCRIPT_DIR}/certs/ca/egress-gateway-ca-production.pem"
CA_KEY_PATH="${SCRIPT_DIR}/certs/ca/egress-ca.key"
SDS_SOCKET_PATH=/var/run/envoy-sds.sock
  sudo -E ./sds-server "${CA_CERT_PATH}" "${CA_KEY_PATH}" /var/run/envoy-sds.sock &
SDS_PID=$!
cd "${SCRIPT_DIR}"

# 4. Start Envoy proxy (background)
if command -v envoy >/dev/null 2>&1; then
  echo "[4/5] Starting Envoy egress proxy..."
  sudo envoy -c "${SCRIPT_DIR}/proxy/envoy.yaml" --base-id 0 &
  ENVOY_PID=$!
  sleep 2
else
  echo "[4/5] Skipping Envoy (not installed)..."
  ENVOY_PID=""
fi

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
echo "  To stop: Ctrl+C or: sudo kill ${SDS_PID} ${ENVOY_PID:-}; network/teardown-tap.sh"
echo "=========================================="

# Wait for interrupt
trap "echo 'Shutting down...'; sudo kill ${SDS_PID} ${ENVOY_PID:-} 2>/dev/null; sudo pkill -x firecracker 2>/dev/null; sudo network/teardown-tap.sh; exit 0" INT TERM
wait