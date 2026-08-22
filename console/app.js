/* FuseBox Console — the visual layer.
 *
 * Speaks ONLY the firmware WebSocket protocol documented in
 * docs/websocket.md:
 *   client → server : verbatim keyboard bytes (Text frames), except JSON
 *                     control frames {"type":"resize"|"ping"}
 *   server → client : {"stream":"stdout","text":…} chunks,
 *                     {"event":"exit","code":N}, {"error":…}
 *
 * No build step, no dependencies beyond the two xterm.js CDN scripts.
 */
"use strict";

const urlInput = document.getElementById("url");
const connectBtn = document.getElementById("connect");
const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");
const hintEl = document.getElementById("hint");

// Restore last endpoint (or ?ws= override) before anything else.
const params = new URLSearchParams(location.search);
if (params.get("ws")) urlInput.value = params.get("ws");
else {
  const saved = localStorage.getItem("fusebox.wsurl");
  if (saved) urlInput.value = saved;
}

const term = new window.Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
  theme: {
    background: "#101418",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    selectionBackground: "#3b4252",
  },
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();

let ws = null;
let connected = false;

function setStatus(mode, label) {
  dotEl.className = "dot " + mode;
  statusEl.textContent = label;
  document.title =
    mode === "on" ? "fusebox-console-connected" : "fusebox-console-ready";
}

function notice(text, color) {
  term.write(`\r\n\u001b[${color}m${text}\u001b[0m\r\n`);
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
    return;
  }
  const url = urlInput.value.trim();
  localStorage.setItem("fusebox.wsurl", url);
  setStatus("pending", `connecting to ${url} …`);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connected = true;
    connectBtn.textContent = "Disconnect";
    setStatus("on", `connected — ${term.cols}×${term.rows}`);
    // Align the pty with the browser terminal before the first prompt paints.
    sendResize();
    term.focus();
  };

  ws.onmessage = (ev) => {
    // Binary frames are raw pty bytes; render directly.
    if (ev.data instanceof ArrayBuffer) {
      term.write(new TextDecoder().decode(ev.data));
      return;
    }
    let obj;
    try {
      obj = JSON.parse(ev.data);
    } catch {
      term.write(ev.data); // not an envelope — render verbatim
      return;
    }
    if (typeof obj.stream === "string" && typeof obj.text === "string") {
      term.write(obj.text);
    } else if (obj.event === "exit") {
      notice(`[session exited — code ${obj.code}]`, "33");
      setStatus("off", `session exited (code ${obj.code})`);
    } else if (obj.event === "pong") {
      /* keepalive; ignore */
    } else if (obj.error) {
      notice(`[error] ${obj.error}`, "31");
    } else {
      term.write(ev.data);
    }
  };

  ws.onclose = () => {
    connected = false;
    connectBtn.textContent = "Connect";
    setStatus("off", "disconnected");
  };

  ws.onerror = () => {
    setStatus("err", "websocket error — is the VM up?");
  };
}

// Keyboard → firmware. Everything the user types crosses verbatim;
// Ctrl-C, arrows and tab reach the line discipline untouched.
term.onData((data) => {
  if (connected && ws.readyState === WebSocket.OPEN) ws.send(data);
});

// Browser resize / pane changes propagate as SIGWINCH inside the guest.
term.onResize(() => {
  if (connected) {
    sendResize();
    setStatus("on", `connected — ${term.cols}×${term.rows}`);
  }
});

window.addEventListener("resize", () => fit.fit());

connectBtn.addEventListener("click", connect);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});
document.getElementById("hint").textContent =
  "?ws= overrides the endpoint · Ctrl-C/Ctrl-D/Tab pass through";

setStatus("off", "disconnected");
