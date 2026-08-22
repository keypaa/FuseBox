# FuseBox Console

The **visual layer**: a zero-build web terminal for the sandbox. It speaks
only the firmware WebSocket protocol (`docs/websocket.md`) — no guest agent,
no API additions, no build step.

```
console/index.html   page shell
console/app.js       protocol glue (keyboard bytes ⇄ JSON envelopes)
console/style.css    dark chrome around the terminal
console/vendor/      vendored xterm.js 5.5.0 + fit addon (works offline)
console/serve.sh     local static server: ./serve.sh [port]  (default 8077)
console/test/smoke.mjs  Node ≥22 protocol test mirroring app.js on the wire
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

- The endpoint box takes any `ws://` URL; `?ws=` overrides and the last
  value persists in localStorage.
- Keyboard input crosses verbatim: arrows, tab, Ctrl-C/Ctrl-D, paste.
- Browser resize propagates into the guest as `SIGWINCH`.
- Session exit shows `[session exited — code N]`.

## Verify changes

```bash
# Protocol-level (Node ≥22, global WebSocket), against any live supervisor:
node console/test/smoke.mjs ws://127.0.0.1:12400
# Dev supervisor without a VM:
(cd sandbox/process_api && ./target/x86_64-unknown-linux-musl/release/process_api \
    --addr 127.0.0.1:12400 --control-server-addr 127.0.0.1:12401)
```

The smoke test mirrors app.js on the wire: prompt, resize→stty, execution,
Ctrl-C reap, ping, exit event. Page-init rendering can additionally be
checked headlessly (`google-chrome-stable --headless=new --dump-dom
http://localhost:8077/` → title becomes `fusebox-console-ready`).
