#!/usr/bin/env python3
"""Fake OpenAI-compatible SSE endpoint for testing the console's streaming
agent loop without a real API key.

Mimics ollama.com/v1 streaming shape: content deltas, fragmented tool_call
deltas (arguments arrive in pieces), then `data: [DONE]`. Round 1 streams a
line of prose + a run_command tool call; later rounds stream a markdown
summary. Counts requests in /tmp/fusebox-sse-hit for test assertions.

Usage: ./sse-mock.py [port]   (default 8079)
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8079

COMMAND = (
    'D=/mnt/user-data/outputs; { mkdir -p "$D" 2>/dev/null && [ -w "$D" ]; } || D=/tmp/fusebox-demo; '
    'mkdir -p "$D"; echo "hello from the FuseBox mock model" > "$D/mock.txt"; '
    "uname -m; cat \"$D/mock.txt\"; echo \"WROTE:$D/mock.txt\""
)


def sse(obj):
    return b"data: " + json.dumps(obj).encode() + b"\n\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("sse-mock: %s\n" % (fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        msgs = body.get("messages", [])
        used_tool = any(m.get("role") == "tool" for m in msgs)
        hits = 0
        try:
            hits = int(open("/tmp/fusebox-sse-hit").read().strip())
        except Exception:
            pass
        hits += 1
        open("/tmp/fusebox-sse-hit", "w").write(str(hits))

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(data):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()

        cid = "chat-fake-1"
        created = int(time.time())

        if not used_tool and hits == 1:
            # round 1: a bit of prose, then a fragmented tool_call
            for word in ["Sure", " —", " running", " the", " demo", " inside", " your", " sandbox…\n\n"]:
                chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {"content": word}}]}))
                time.sleep(0.05)
            # fragments of the arguments JSON: structural quotes stay plain,
            # only quotes inside the command value are JSON-escaped
            frags = ['{"comm', 'and":"', COMMAND[:40].replace('"', '\\"'),
                     COMMAND[40:80].replace('"', '\\"'), COMMAND[80:].replace('"', '\\"'), '"}']
            chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "id": "call_fake_1", "type": "function",
                 "function": {"name": "run_command", "arguments": frags[0] + frags[1]}}]}}]}))
            time.sleep(0.05)
            for f in frags[2:]:
                chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": 0, "function": {"arguments": f}}]}}]}))
                time.sleep(0.05)
            chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}))
        else:
            summary = (
                "The command ran inside your sandbox (streamed over SSE) and wrote `mock.txt`.\n\n"
                "```\n" + (next((m.get("content", "") for m in reversed(msgs) if m.get("role") == "tool"), "")).strip() + "\n```\n"
                "Switch the provider in ⚙ settings to a real endpoint to talk to an actual model."
            )
            for i in range(0, len(summary), 24):
                chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {"content": summary[i:i+24]}}]}))
                time.sleep(0.04)
            chunk(sse({"id": cid, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}))

        chunk(b"data: [DONE]\n\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


if __name__ == "__main__":
    sys.stderr.write(f"==> sse-mock: http://127.0.0.1:{PORT}/v1/chat/completions\n")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
