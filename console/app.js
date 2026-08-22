/* FuseBox Console — the visual layer.
 *
 * Speaks ONLY the firmware protocols documented in docs/websocket.md:
 *   WS 2024        : verbatim keyboard bytes out; JSON stdout chunks,
 *                    exit events and control frames in.
 *   HTTP 2025      : /sessions + /files/list|download|upload (Control API).
 *
 * Zero build step; only vendored xterm.js.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const urlInput = $("url");
const connectBtn = $("connect");
const statusEl = $("status");
const dotEl = $("dot");
const hintEl = $("hint");
const sessionsEl = $("sessions");
const filesdirEl = $("filesdir");
const filelistEl = $("filelist");
const filesAside = $("files");
const termOverlay = $("term-overlay");

// Restore last endpoint (or ?ws= override) before anything else.
const params = new URLSearchParams(location.search);
if (params.get("ws")) urlInput.value = params.get("ws");
else {
  const saved = localStorage.getItem("fusebox.wsurl");
  if (saved) urlInput.value = saved;
}
const savedDir = localStorage.getItem("fusebox.filesdir");
if (savedDir) filesdirEl.value = savedDir;
filesdirEl.addEventListener("change", () =>
  localStorage.setItem("fusebox.filesdir", filesdirEl.value));

/* ------------------------------- terminal ------------------------------- */

const term = new window.Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace",
  theme: {
    background: "#0f141a",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    cursorAccent: "#0f141a",
    selectionBackground: "rgba(136,192,208,.28)",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#d08770", brightGreen: "#b5ce8f",
    brightYellow: "#f0d39b", brightBlue: "#93bcc7", brightMagenta: "#c8a2bd",
    brightCyan: "#9fd3dc", brightWhite: "#eceff4",
  },
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("terminal"));
fit.fit();

let ws = null;
let connected = false;

function setStatus(mode, label) {
  dotEl.className = "dot " + mode;
  statusEl.textContent = label;
  termOverlay.classList.toggle("hidden", mode === "on");
  document.title =
    mode === "on" ? "fusebox-console-connected" : "fusebox-console-ready";
}

function notice(text, color) {
  term.write(`\r\n\u001b[${color}m${text}\u001b[0m\r\n`);
}

/* -------------------------------- toasts -------------------------------- */

function toast(msg, kind = "info", ms = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  if (ms > 0) setTimeout(() => dismiss(el), ms);
  return el;
}

function dismiss(el) {
  el.classList.add("fadeout");
  setTimeout(() => el.remove(), 320);
}

/* ------------------------------ control api ----------------------------- */

// Firmware pairing: control API lives next door (WS 2024 → HTTP 2025).
function apiBase() {
  try {
    const u = new URL(urlInput.value.trim());
    const proto = u.protocol === "wss:" ? "https:" : "http:";
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

/* ------------------------------ files panel ----------------------------- */

const FILE_ICONS = [
  [/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i, "🖼️"],
  [/\.(pdf)$/i, "📕"],
  [/\.(docx?|odt|rtf)$/i, "📘"],
  [/\.(xlsx?|csv|ods)$/i, "📊"],
  [/\.(pptx?|odp)$/i, "📽️"],
  [/\.(zip|tar|gz|xz|zst|7z|bz2)$/i, "📦"],
  [/\.(mp3|wav|ogg|flac)$/i, "🎵"],
  [/\.(mp4|mkv|webm|mov)$/i, "🎬"],
  [/\.(js|mjs|ts|py|rs|sh|c|h|cpp|json|ya?ml|toml|html|css|md)$/i, "🧩"],
];
function iconFor(name) {
  return (FILE_ICONS.find(([re]) => re.test(name)) ?? [null, "📄"])[1];
}

// Ensure a directory value has a matching <option> (custom paths restored
// from storage or typed elsewhere aren't among the presets).
function ensureDirOption(v) {
  if (!v) return;
  if (![...filesdirEl.options].some((o) => o.value === v)) {
    const o = document.createElement("option");
    o.value = o.textContent = v;
    filesdirEl.appendChild(o);
  }
  filesdirEl.value = v;
}

async function refreshFiles() {
  if (!connected) return;
  ensureDirOption(filesdirEl.value);
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
      li.innerHTML = `<span class="fico"></span><span class="fname"></span><span class="fsize"></span>`;
      li.querySelector(".fico").textContent = entry.is_dir ? "📁" : iconFor(entry.name);
      li.querySelector(".fname").textContent = entry.name;
      li.querySelector(".fsize").textContent = entry.is_dir
        ? "" : formatSize(entry.size);
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

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / (1024 * 1024)).toFixed(1)} M`;
}

function downloadFile(name) {
  const a = document.createElement("a");
  a.href = `${apiBase()}/files/download?path=${encodeURIComponent(filesdirEl.value + "/" + name)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`downloading ${name}…`, "info", 2500);
}

// Uploads ride XMLHttpRequest so we get real progress events.
function uploadFile(file) {
  const target = `${filesdirEl.value}/${file.name}`;
  const el = toast(`⇧ ${file.name}`, "info", 0);
  const bar = document.createElement("div");
  bar.className = "progress";
  bar.innerHTML = "<i></i>";
  el.appendChild(bar);
  const fill = bar.querySelector("i");

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/files/upload?path=${encodeURIComponent(target)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      el.remove();
      if (xhr.status >= 200 && xhr.status < 300) {
        toast(`✓ ${file.name} uploaded`, "ok", 3000);
        notice(`[uploaded] ${target}`, "36");
      } else {
        let msg = `status ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch {}
        toast(`✗ ${file.name}: ${msg}`, "err", 5000);
      }
      resolve();
    };
    xhr.onerror = () => {
      el.remove();
      toast(`✗ ${file.name}: upload failed`, "err", 5000);
      resolve();
    };
    xhr.send(file);
  });
}

async function uploadFiles(list) {
  for (const f of list) await uploadFile(f);
  refreshFiles();
}

/* -------------------------------- session ------------------------------- */

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
    connectBtn.classList.add("connected");
    setStatus("on", `connected — ${term.cols}×${term.rows}`);
    // Align the pty with the browser terminal before the first prompt paints.
    sendResize();
    term.focus();
    startSessionsPoller();
    refreshFiles();
  };

  ws.onmessage = (ev) => {
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
    connectBtn.classList.remove("connected");
    setStatus("off", "disconnected");
    stopSessionsPoller();
    filelistEl.innerHTML = '<li class="empty">connect to browse</li>';
  };

  ws.onerror = () => {
    setStatus("err", "websocket error — is the VM up?");
  };
}

/* ------------------------------- wiring --------------------------------- */

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

$("refresh").addEventListener("click", refreshFiles);
filesdirEl.addEventListener("change", () => {
  localStorage.setItem("fusebox.filesdir", filesdirEl.value);
  refreshFiles();
});
$("upload").addEventListener("change", (e) => {
  if (e.target.files?.length) uploadFiles(e.target.files);
  e.target.value = "";
});

const dropzone = $("dropzone");
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

$("paneltoggle").addEventListener("click", () => {
  filesAside.classList.toggle("hidden");
  setTimeout(() => fit.fit(), 240);
});

hintEl.textContent =
  "?ws= overrides the endpoint · Ctrl-C/Ctrl-D/Tab pass through";

setStatus("off", "disconnected");
