#!/usr/bin/env python3
"""Keyless local proxy for OpenAI-compatible LLM endpoints (Ollama Cloud etc.).

Browsers can't call ollama.com directly (no CORS headers), so the console
talks to this proxy instead: it forwards /v1/* to the upstream host verbatim
— including your Bearer key, which lives only in the browser and is attached
per-request — and streams the response body straight through, so SSE token
streaming works unmodified.

Usage: ./llm-proxy.py [port] [upstream]
  default port 8078, default upstream https://ollama.com
"""

import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8078
UPSTREAM = (sys.argv[2] if len(sys.argv) > 2 else "https://ollama.com").rstrip("/")

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter: one line per request
        sys.stderr.write("proxy: %s\n" % (fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _relay(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            UPSTREAM + self.path,
            data=body,
            method=method,
            headers={
                k: v for k, v in self.headers.items()
                if k.lower() not in HOP_BY_HOP
            },
        )
        try:
            up = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            up = e  # pass error status + body through untouched
        except Exception as e:
            payload = f'{{"error":{{"message":"proxy upstream error: {e}"}}}}'.encode()
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(up.status if hasattr(up, "status") else up.code)
        self._cors()
        for k, v in up.headers.items():
            if k.lower() not in HOP_BY_HOP and k.lower() != "access-control-allow-origin":
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

    def do_GET(self):
        self._relay("GET")

    def do_POST(self):
        self._relay("POST")


if __name__ == "__main__":
    sys.stderr.write(f"==> llm-proxy: http://127.0.0.1:{PORT}/ -> {UPSTREAM}\n")
    ThreadingHTTPServer(("127.0.0.1", PORT), Proxy).serve_forever()
