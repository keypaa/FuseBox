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
const sessionsEl = document.getElementById("sessions");
const filesdirEl = document.getElementById("filesdir");
const filelistEl = document.getElementById("filelist");

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
    startSessionsPoller();
    refreshFiles();
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
    stopSessionsPoller();
    filelistEl.innerHTML = '<li class="empty">connect to browse</li>';
  };

  ws.onerror = () => {
    setStatus("err", "websocket error — is the VM up?");
  };
}

// ============================ Control API plane =============================
// The console derives the API base from the WS endpoint (2024 → 2025 pairing)
// and uses it for the files panel and session count. Permissive CORS on the
// firmware side makes this work from any origin, including file://.

function apiBase() {
  try {
    const u = new URL(urlInput.value.trim());
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    // Firmware pairing: control API lives next door (WS 2024 → HTTP 2025).
    if (!u.port) return `${proto}//${u.host}`;
    return `${proto}//${u.hostname}:${Number(u.port) + 1}`;
  } catch {
    return "";
  }
}

let sessionsTimer = null;

async function pollSessions() {
  try {
    const res = await fetch(`${apiBase()}/sessions`);
    const data = await res.json();
    const n = (data.sessions ?? []).length;
    sessionsEl.textContent = n === 1 ? "1 session" : `${n} sessions`;
  } catch {
    sessionsEl.textContent = "–";
  }
}

function startSessionsPoller() {
  pollSessions();
  clearInterval(sessionsTimer);
  sessionsTimer = setInterval(pollSessions, 5000);
}

function stopSessionsPoller() {
  clearInterval(sessionsTimer);
  sessionsEl.textContent = "–";
}

async function refreshFiles() {
  if (!connected) return;
  filelistEl.innerHTML = '<li class="empty">loading…</li>';
  try {
    const res = await fetch(
      `${apiBase()}/files/list?path=${encodeURIComponent(filesdirEl.value)}`,
    );
    const data = await res.json();
    if (!Array.isArray(data.entries)) throw new Error(data.error ?? "list failed");
    filelistEl.innerHTML = "";
    if (data.entries.length === 0) {
      filelistEl.innerHTML = '<li class="empty">empty directory</li>';
      return;
    }
    for (const entry of data.entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="fname"></span><span class="fsize"></span>`;
      li.querySelector(".fname").textContent = entry.name;
      li.querySelector(".fsize").textContent = entry.is_dir
        ? "dir"
        : `${(entry.size / 1024).toFixed(1)}K`;
      if (!entry.is_dir) {
        li.classList.add("file");
        li.title = "click to download";
        li.addEventListener("click", () => downloadFile(entry.name));
      }
      filelistEl.appendChild(li);
    }
  } catch (e) {
    filelistEl.innerHTML = `<li class="empty">error: ${String(e.message ?? e)}</li>`;
  }
}

function downloadFile(name) {
  const a = document.createElement("a");
  a.href = `${apiBase()}/files/download?path=${encodeURIComponent(filesdirEl.value + "/" + name)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const target = `${filesdirEl.value}/${file.name}`;
    notice(`uploading ${file.name} (${file.size} bytes)…`, "36");
    try {
      const res = await fetch(
        `${apiBase()}/files/upload?path=${encodeURIComponent(target)}`,
        { method: "POST", body: file },
      );
      const data = await res.json();
      notice(res.ok ? `uploaded → ${data.path}` : `upload failed: ${data.error}`,
             res.ok ? "32" : "31");
    } catch (e) {
      notice(`upload failed: ${e.message ?? e}`, "31");
    }
  }
  refreshFiles();
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
document.getElementById("refresh").addEventListener("click", refreshFiles);
filesdirEl.addEventListener("change", refreshFiles);
document.getElementById("upload").addEventListener("change", (e) => {
  if (e.target.files?.length) uploadFiles(e.target.files);
  e.target.value = "";
});
const dropzone = document.getElementById("dropzone");
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});
document.getElementById("hint").textContent =
  "?ws= overrides the endpoint · Ctrl-C/Ctrl-D/Tab pass through";

setStatus("off", "disconnected");
