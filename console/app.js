"use strict";
const $ = (id) => document.getElementById(id);

const dotEl = $("dot");
const statusEl = $("status");
const connectBtn = $("connect");
const termOverlay = $("term-overlay");
const filesdirEl = $("filesdir");
const filelistEl = $("filelist");
const devDrawer = $("devdrawer");
const historyEl = $("history");

/* ------------------------------- toasts --------------------------------- */
function toast(msg, kind = "info", ms = 3200) {
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

/* ------------------------------ terminal -------------------------------- */
const term = new window.Terminal({
  cursorBlink: true, fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', ui-monospace, Menlo, monospace",
  theme: {
    background: "#12100e", foreground: "#e5e0d5", cursor: "#d97757",
    cursorAccent: "#12100e", selectionBackground: "rgba(217,119,87,.25)",
    black: "#3a3630", red: "#d08770", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e0d5",
    brightBlack: "#6b6459", brightRed: "#e0887a", brightGreen: "#b5ce8f",
    brightYellow: "#f0d39b", brightBlue: "#93bcc7", brightMagenta: "#c8a2bd",
    brightCyan: "#9fd3dc", brightWhite: "#f0eee6",
  },
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("terminal"));

let ws = null, connected = false;
const outputSubs = [];

function setStatus(mode, label) {
  if (dotEl) dotEl.className = "dot " + mode;
  if (statusEl) statusEl.textContent = label;
  for (const el of document.querySelectorAll(".js-dot")) el.className = `dot ${mode}`;
  for (const el of document.querySelectorAll(".js-status")) el.textContent = label;
  if (termOverlay) termOverlay.classList.toggle("hidden", mode === "on");
  document.title = mode === "on" ? "fuseconsole-connected" : "fuseconsole-ready";
}
function termNotice(text, color) {
  term.write(`\r\n\u001b[${color}m${text}\u001b[0m\r\n`);
}
function emitOutput(text) {
  term.write(text);
  for (const cb of outputSubs) { try { cb(text); } catch {} }
}
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
}

/* ------------------------------ connection ------------------------------ */
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = localStorage.getItem("fusebox.wsurl") ?? "ws://192.0.2.2:2024";
  setStatus("pending", `connecting to ${url} …`);
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    connected = true;
    connectBtn.textContent = "Disconnect";
    setStatus("on", "connected");
    sendResize();
    term.focus();
    pollSessions();
    window.Chat?.onConnected?.();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { emitOutput(new TextDecoder().decode(ev.data)); return; }
    let obj;
    try { obj = JSON.parse(ev.data); } catch { emitOutput(ev.data); return; }
    if (typeof obj.stream === "string" && typeof obj.text === "string") {
      emitOutput(obj.text);
    } else if (obj.event === "exit") {
      termNotice(`[session exited — code ${obj.code}]`, "33");
      setStatus("pending", "session ended — reconnecting on next use");
      connected = false;
    } else if (obj.event === "pong") {
    } else if (obj.error) {
      termNotice(`[error] ${obj.error}`, "31");
    } else {
      emitOutput(ev.data);
    }
  };
  ws.onclose = () => {
    connected = false;
    connectBtn.textContent = "Connect";
    setStatus("off", "disconnected");
    filelistEl.innerHTML = '<li class="empty">connect to browse</li>';
  };
  ws.onerror = () => setStatus("err", "websocket error — is the VM up?");
}
function ensureConnected() {
  if (connected && ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const until = Date.now() + 12000;
    const tick = () => {
      if (connected) return resolve();
      if (Date.now() > until) return reject(new Error("could not connect to sandbox"));
      setTimeout(tick, 120);
    };
    tick();
  });
}

/* --------------------------- control api base --------------------------- */
function apiBase() {
  try {
    const u = new URL(localStorage.getItem("fusebox.wsurl") ?? "ws://192.0.2.2:2024");
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    if (!u.port) return `${proto}//${u.host}`;
    return `${proto}//${u.hostname}:${Number(u.port) + 1}`;
  } catch { return ""; }
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
function iconFor(name) { return (FILE_ICONS.find(([re]) => re.test(name)) ?? [null, "📄"])[1]; }
function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / (1024 * 1024)).toFixed(1)} M`;
}
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
    const res = await fetch(`${apiBase()}/files/list?path=${encodeURIComponent(filesdirEl.value)}`);
    const data = await res.json();
    if (!Array.isArray(data.entries)) throw new Error(data.error ?? "list failed");
    filelistEl.innerHTML = "";
    if (data.entries.length === 0) { filelistEl.innerHTML = '<li class="empty">empty directory</li>'; return; }
    for (const entry of data.entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="fico"></span><span class="fname"></span><span class="fsize"></span>`;
      li.querySelector(".fico").textContent = entry.is_dir ? "📁" : iconFor(entry.name);
      li.querySelector(".fname").textContent = entry.name;
      li.querySelector(".fsize").textContent = entry.is_dir ? "" : formatSize(entry.size);
      if (!entry.is_dir) {
        li.classList.add("file");
        li.title = "click to preview / download";
        li.addEventListener("click", () => window.Chat?.previewFile(entry.name));
      }
      filelistEl.appendChild(li);
    }
  } catch (e) {
    filelistEl.innerHTML = `<li class="empty">error: ${String(e.message ?? e)}</li>`;
  }
}
function downloadURL(path) { return `${apiBase()}/files/download?path=${encodeURIComponent(path)}`; }
function uploadFile(file) {
  const target = `${filesdirEl.value}/${file.name}`;
  const el = toast(`⇧ ${file.name}`, "info", 0);
  const bar = document.createElement("div");
  bar.className = "progress"; bar.innerHTML = "<i></i>";
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
        toast(`✓ ${file.name} uploaded → ${filesdirEl.value}`, "ok", 3000);
      } else {
        let msg = `status ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch {}
        toast(`✗ ${file.name}: ${msg}`, "err", 5000);
      }
      refreshFiles(); resolve();
    };
    xhr.onerror = () => { el.remove(); toast(`✗ ${file.name}: upload failed`, "err", 5000); resolve(); };
    xhr.send(file);
  });
}
async function uploadFiles(list) {
  if (!connected) await ensureConnected().catch(() => {});
  for (const f of list) await uploadFile(f);
}

/* ------------------------------- drawers -------------------------------- */
function openDrawer(tab) {
  devDrawer.classList.add("open");
  document.body.classList.add("drawer-open");
  for (const b of devDrawer.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of devDrawer.querySelectorAll(".pane")) p.classList.toggle("active", p.dataset.pane === tab);
  if (tab === "terminal") setTimeout(() => { fit.fit(); term.focus(); }, 270);
  if (tab === "files" && connected) refreshFiles();
}
function closeDrawer() {
  devDrawer.classList.remove("open");
  document.body.classList.remove("drawer-open");
  setTimeout(() => fit.fit(), 260);
}
function toggleDrawer(tab) {
  const isOpen = devDrawer.classList.contains("open");
  const active = devDrawer.querySelector(".tab.active")?.dataset.tab;
  if (isOpen && active === tab) closeDrawer(); else openDrawer(tab);
}

/* --------------------------- relative time ---------------------------- */
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
window.relTime = relTime;

/* ------------------------------ ConsoleAPI ------------------------------ */
window.ConsoleAPI = {
  apiBase, toast, termNotice,
  sendRaw: (s) => { if (ws?.readyState === WebSocket.OPEN) ws.send(s); },
  onOutput: (cb) => { outputSubs.push(cb); return () => { const i = outputSubs.indexOf(cb); if (i >= 0) outputSubs.splice(i, 1); }; },
  isConnected: () => connected, ensureConnected,
  openTerminalDrawer: () => openDrawer("terminal"),
  downloadURL,
  listFiles: async (path) => { const res = await fetch(`${apiBase()}/files/list?path=${encodeURIComponent(path)}`); return res.json(); },
  fetchFile: async (path) => { const res = await fetch(downloadURL(path)); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return res; },
};
window.ConsoleAPI.setMdRenderer = (fn) => { window.__mdRender = fn; };

/* ------------------------------- wiring --------------------------------- */
connectBtn.addEventListener("click", connect);
$("drawer-terminal")?.addEventListener("click", () => toggleDrawer("terminal"));
$("drawer-files")?.addEventListener("click", () => toggleDrawer("files"));
$("drawer-close")?.addEventListener("click", closeDrawer);
for (const b of devDrawer.querySelectorAll(".tab")) b.addEventListener("click", () => openDrawer(b.dataset.tab));
$("refresh").addEventListener("click", refreshFiles);
filesdirEl.addEventListener("change", () => { localStorage.setItem("fusebox.filesdir", filesdirEl.value); refreshFiles(); });
$("dropzone").addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").classList.add("drag"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("drag"));
$("dropzone").addEventListener("drop", (e) => { e.preventDefault(); $("dropzone").classList.remove("drag"); if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });
$("attach").addEventListener("click", () => $("chatupload").click());
$("chatupload").addEventListener("change", async (e) => {
  if (e.target.files?.length) {
    await uploadFiles(e.target.files);
    window.Chat?.onUploaded?.([...e.target.files].map(f => f.name));
  }
  e.target.value = "";
});
window.addEventListener("resize", () => fit.fit());

/* ---------------------------- sessions chip ----------------------------- */
const sessionsEl = $("sessions");
async function pollSessions() {
  const sessionsEl = $("sessions");
  if (!sessionsEl) return;
  if (!connected) { sessionsEl.textContent = "–"; return; }
  try {
    const data = await fetch(`${apiBase()}/sessions`).then((r) => r.json());
    const n = Array.isArray(data.sessions) ? data.sessions.length : null;
    if (n !== null) sessionsEl.textContent = n === 1 ? "1 session" : `${n} sessions`;
  } catch {}
}
setInterval(pollSessions, 5000);

/* ---------------------------- sidebar history --------------------------- */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem("fusebox.history") ?? "[]"); }
  catch { return []; }
}
let history = loadHistory();
function saveHistory() { localStorage.setItem("fusebox.history", JSON.stringify(history)); }

function renderHistory() {
  historyEl.innerHTML = "";
  const list = (window.Chat?.getHistory?.() ?? loadHistory());
  const cur = window.Chat?.getCurrentId?.() ?? null;
  if (!list || list.length === 0) {
    historyEl.innerHTML = '<div class="history-empty">no conversations yet</div>';
    return;
  }
  for (const h of list) {
    const el = document.createElement("div");
    el.className = "history-item" + (h.id === cur ? " active" : "");
    el.innerHTML = `<span class="hi-dot"></span><span class="hi-text"></span>`;
    el.querySelector(".hi-text").textContent = h.title || "(new conversation)";
    el.addEventListener("click", () => window.Chat?.loadConversation(h.id));
    historyEl.appendChild(el);
  }
}
$("newchat").addEventListener("click", () => { if (window.Chat?.newChat) window.Chat.newChat(); });
$("settingsbtn").addEventListener("click", () => window.Chat?.openSettings());

/* -------------------------------- boot ---------------------------------- */
const qsWs = new URLSearchParams(location.search).get("ws");
if (qsWs) localStorage.setItem("fusebox.wsurl", qsWs);
const savedDir = localStorage.getItem("fusebox.filesdir");
if (savedDir) ensureDirOption(savedDir);
setStatus("off", "disconnected");
renderHistory();
if (!localStorage.getItem("fusebox.seen")) {
  localStorage.setItem("fusebox.seen", "1");
  setTimeout(() => openDrawer("terminal"), 400);
}