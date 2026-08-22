#!/usr/bin/env bash
# Serve the console locally (the page also works straight from file://,
# this just gives it a stable origin). Usage: ./serve.sh [port]
set -euo pipefail
PORT="${1:-8077}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> FuseBox console: http://localhost:${PORT}/  (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR"
