# FuseConsole

The console for FuseBox: a **chat-first assistant whose hands are the
sandbox**. The model talks over any OpenAI-compatible `/chat/completions`
endpoint (token-streamed over SSE) and acts through the live PTY session of
the microVM; the terminal and file browser live in a right-hand drawer.
Zero build, vendored deps, works offline.

```
console/index.html        page shell (chat column + drawers + modals)
console/app.js            protocol glue: WS 2024 PTY relay, HTTP 2025 file plane,
                          ConsoleAPI bridge shared with chat.js
console/chat.js           chat layer: settings, mini-markdown renderer,
                          SSE-streaming agent loop with the run_command tool,
                          built-in mock provider
console/style.css         warm-dark Claude-leaning theme (design tokens)
console/fonts/            self-hosted fonts (no CDN)
console/vendor/           vendored xterm.js 5.5.0 + fit addon
console/llm-proxy.py      keyless local CORS+SSE proxy for providers that
                           block browsers (Ollama Cloud): ./llm-proxy.py [port]
                           [upstream]   (default 8078 → https://ollama.com)
console/server.py         static files (no-cache) + same-origin /api/chat;
                           injects OPENROUTER_API_KEY from console/.env
                           server-side, streams SSE through
console/.env.example      template for console/.env (never committed)
console/serve.sh          serve via server.py: ./serve.sh [port]  (default 8077)
console/test/smoke.mjs    Node ≥22 wire-protocol regression (no browser)
console/test/chat-e2e.mjs headless-Chrome end-to-end: chat → tool call → PTY →
                          summary + Control-API file check + screenshot;
                          FAKE_LLM_URL=<base> switches it to the SSE mock
console/test/sse-mock.py  fake streaming OpenAI endpoint (deltas + fragmented
                          tool_calls) — tests the streaming path keyless
console/test/screenshot.mjs      CDP screenshot driver (any page state)
console/test/files-pane-shot.mjs CDP screenshot of the files drawer
```

## Use it

```bash
# 1. Boot the sandbox (or run process_api directly on loopback for dev):
sudo ./network/setup-tap.sh && sudo ./firecracker/launch.sh

# 2a. Open the page straight from disk:
xdg-open console/index.html          # default endpoint ws://192.0.2.2:2024

# 2b. …or serve it:
./console/serve.sh                   # → http://localhost:8077/
```

- `?ws=ws://host:port` overrides the endpoint (dev harnesses); the value
  persists in localStorage.
- **Model**: ⚙ in the header opens settings — provider base URL (empty =
  same-origin `/api/chat` relay, `mock` needs no key, absolute `http(s)` URL
  posts direct from the browser), model name (single locked model
  `inclusionai/ling-3.1-flash`), system prompt. The API key lives only in
  `console/.env` (`OPENROUTER_API_KEY`, read by `server.py`) — never in this
  browser. The chip next to the composer shows the active model.
- The assistant's `run_command` tool executes inside the connected PTY;
  output streams into the transcript and the terminal drawer simultaneously.
- Files created under `/mnt/user-data/outputs` appear in the Files drawer;
  click a file to preview it, or drop files anywhere on the drawer to upload.

## Real models (OpenRouter via the same-origin relay)

The browser never sees the key. Put it in `console/.env` and serve with
`server.py` (which injects `Authorization: Bearer <key>` server-side and
streams the SSE reply through):

```bash
cp console/.env.example console/.env   # then paste your key after OPENROUTER_API_KEY=
./console/serve.sh                     # → http://localhost:8077/
```

Leave the base URL empty in ⚙ settings so chat goes through `/api/chat`.
Single locked model: `inclusionai/ling-3.1-flash`. Requests never send
`max_tokens` (the provider's 262K default applies). If a 402 recurs, check
OpenRouter → Settings → Keys for a per-key spending limit.

Browsers cannot call `ollama.com` directly (no CORS headers), so to use
Ollama Cloud instead run the keyless local proxy and point the console at
it with an absolute base URL (direct-from-browser mode):

```bash
./console/llm-proxy.py                # → http://127.0.0.1:8078 → ollama.com
```

Then in ⚙ settings: base URL `http://127.0.0.1:8078/v1`, your Ollama key.
The key is attached per-request by the browser only in this direct mode.
Responses stream token-by-token;
the stop button aborts mid-stream. Any other OpenAI-compatible endpoint
works too (OpenAI, OpenRouter, local Ollama via `http://127.0.0.1:11434/v1`).

## Dev-host note

On a bare dev host there is no `/mnt/user-data`; the mock demo (and smoke
test) probe writability and fall back to `/tmp`. Inside the real microVM the
canonical paths exist and are used as-is.

## Verify changes

```bash
# Dev supervisor without a VM:
(cd sandbox/process_api && ./target/x86_64-unknown-linux-musl/release/process_api \
    --addr 127.0.0.1:12400 --control-server-addr 127.0.0.1:12401 &)
(cd console && ./serve.sh 8077 &)

# Wire protocol (Node ≥22): prompt, resize→stty, exec, Ctrl-C, ping, exit,
# file-plane roundtrip, /sessions:
node console/test/smoke.mjs ws://127.0.0.1:12400

# Full chat loop in headless Chrome (mock model → run_command → PTY →
# summary; asserts the produced file via the Control API; saves a PNG):
node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat.png

# Same assertions over the real streaming path (SSE deltas + fragmented
# tool_calls) against the fake endpoint:
(cd console/test && ./sse-mock.py 8079 &)
FAKE_LLM_URL=http://127.0.0.1:8079/v1 \
  node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat-stream.png
```

All must exit 0. The e2e uses a throwaway Chrome profile each run, so it
never depends on leftover localStorage state.
