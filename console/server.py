#!/usr/bin/env python3
"""FuseConsole server: static files (no-cache) + same-origin /api/chat.

The OpenRouter key lives ONLY here, read from console/.env
(OPENROUTER_API_KEY). The browser never sees it: POST /api/chat injects
`Authorization: Bearer <key>` server-side and streams the SSE reply through.
Single model only — the browser chooses the model id, this server forwards it
verbatim and never substitutes another.

Usage: ./server.py [port] [--upstream https://openrouter.ai/api/v1]
       [--env-file .env] [--log-bodies]
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SINGLE_MODEL = "inclusionai/ling-3.1-flash"

# Copied from console/llm-proxy.py:22-26 — never forward these hop-by-hop
# headers in either direction.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

# A localhost --upstream means tests (sse-mock.py): never attach the real
# key to a test endpoint.
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

UPSTREAM = "https://openrouter.ai/api/v1"
API_KEY = ""
MODEL = SINGLE_MODEL
LOG_BODIES = False


def load_env_file(path):
    """Load KEY=VALUE lines (dotenv subset: skips blanks and # comments,
    never overrides real environment variables)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


def parse_args(argv):
    p = argparse.ArgumentParser(description="FuseConsole static + /api/chat server")
    p.add_argument("port", nargs="?", type=int, default=8077)
    p.add_argument("--upstream", default="https://openrouter.ai/api/v1")
    p.add_argument("--env-file", default=".env")
    p.add_argument("--log-bodies", action="store_true")
    return p.parse_args(argv)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FuseConsole/1"

    def log_message(self, fmt, *args):  # quieter: one line per request
        sys.stderr.write("server: %s\n" % (fmt % args))

    def end_headers(self):
        # Static files must never cache (always fresh console); harmless on API too.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _api_not_found(self):
        self._send_json(404, {"error": {"message": "not found: " + self.path.split("?")[0]}})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/model":
            self._send_json(200, {"model": MODEL})
            return
        if path.startswith("/api/"):
            self._api_not_found()
            return
        super().do_GET()

    def do_POST(self):
        # Consume the body first so the keep-alive socket stays parseable
        # even when we answer 404 below.
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if self.path.split("?")[0] != "/api/chat":
            self._api_not_found()
            return
        try:
            body = json.loads(raw)
        except Exception:
            self._send_json(400, {"error": {"message": "invalid JSON body"}})
            return
        if not isinstance(body, dict):
            self._send_json(400, {"error": {"message": "JSON body must be an object"}})
            return

        host = urllib.parse.urlsplit(UPSTREAM).hostname or ""
        key_present = bool(API_KEY) and host not in LOCAL_HOSTS

        if LOG_BODIES:
            # Never the key: only shapes + key presence.
            msgs = body.get("messages") or []
            tools = body.get("tools") or []
            chars = sum(len(m.get("content")) for m in msgs
                        if isinstance(m, dict) and isinstance(m.get("content"), str))
            sys.stderr.write("server: chat %s\n" % json.dumps({
                "model": body.get("model"),
                "message_chars": chars,
                "tool_count": len(tools) if isinstance(tools, list) else 0,
                "key_present": key_present,
            }))

        # Defensive: drop any client-supplied output-cap keys so we NEVER
        # forward them upstream; re-encode only when a strip happened so
        # normal bodies pass through byte-identical.
        if any(k in body for k in ("max_tokens", "max_output_tokens", "max_completion_tokens")):
            for k in ("max_tokens", "max_output_tokens", "max_completion_tokens"):
                body.pop(k, None)
            raw = json.dumps(body).encode()

        # Forward the browser body verbatim — NEVER adding max_tokens.
        out_headers = {"Content-Type": "application/json"}
        if key_present:
            out_headers["Authorization"] = "Bearer " + API_KEY
        req = urllib.request.Request(
            UPSTREAM + "/chat/completions",
            data=raw,
            method="POST",
            headers=out_headers,
        )
        try:
            up = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            up = e  # pass error status + body through untouched
        except Exception as e:
            self._send_json(502, {"error": {"message": "upstream error: %s" % e}})
            return

        self.send_response(up.status if hasattr(up, "status") else up.code)
        for k, v in up.headers.items():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        # stream the body through in chunks (SSE tokens flow immediately)
        try:
            while True:
                chunk = up.read(1024)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client hung up mid-stream


def main(argv):
    args = parse_args(argv)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    load_env_file(args.env_file)
    global UPSTREAM, API_KEY, MODEL, LOG_BODIES
    UPSTREAM = args.upstream.rstrip("/")
    API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
    MODEL = os.environ.get("MODEL", SINGLE_MODEL)
    LOG_BODIES = args.log_bodies
    # Presence only ("set"/"missing") — never key material.
    sys.stderr.write("==> console: http://127.0.0.1:%d/  (upstream %s, key %s)\n"
                     % (args.port, UPSTREAM, "set" if API_KEY else "missing"))
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main(sys.argv[1:])
