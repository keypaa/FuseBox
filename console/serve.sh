#!/usr/bin/env bash
# Serve the console + same-origin /api/chat (key injected server-side from console/.env).
set -euo pipefail
PORT="${1:-8077}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> FuseBox console: http://localhost:${PORT}/  (Ctrl-C to stop)"
exec python3 "$DIR/server.py" "$PORT" "${@:2}"
