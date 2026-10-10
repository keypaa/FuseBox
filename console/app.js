"use strict";
const $ = (id) => document.getElementById(id);

const statusEl = $("status");
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

/* --------------------------- headless pty output -------------------------- */
/* No visible terminal: PTY bytes flow to outputSubs (runCommand) only. */
let ws = null, connected = false;
const outputSubs = [];

function setStatus(mode, label) {
  if (statusEl) statusEl.textContent = label;
  for (const el of document.querySelectorAll(".js-status")) el.textContent = label;
  const sessionsChip = $("sessions");
  if (sessionsChip) sessionsChip.style.display = mode === "on" ? "" : "none";
  document.title = mode === "on" ? "fuseconsole-connected" : "fuseconsole-ready";
}
function termNotice(text, color) {
  toast(text, color === "31" ? "err" : "info", 4000);
}
function emitOutput(text) {
  for (const cb of outputSubs) { try { cb(text); } catch {} }
}
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
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
    setStatus("on", "connected");
    sendResize();
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
    setStatus("off", "disconnected");
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

/* ------------------------------ upload ---------------------------------- */
const UPLOAD_DIR = "/mnt/user-data/uploads";
function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / (1024 * 1024)).toFixed(1)} M`;
}
function downloadURL(path) { return `${apiBase()}/files/download?path=${encodeURIComponent(path)}`; }
function uploadFile(file) {
  const target = `${UPLOAD_DIR}/${file.name}`;
  const el = toast(`Uploading ${file.name}`, "info", 0);
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
        toast(`${file.name} uploaded to ${UPLOAD_DIR}`, "ok", 3000);
      } else {
        let msg = `status ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch {}
        toast(`${file.name}: ${msg}`, "err", 5000);
      }
      resolve();
    };
    xhr.onerror = () => { el.remove(); toast(`${file.name}: upload failed`, "err", 5000); resolve(); };
    xhr.send(file);
  });
}
async function uploadFiles(list) {
  if (!connected) await ensureConnected().catch(() => {});
  for (const f of list) await uploadFile(f);
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
  downloadURL,
  listFiles: async (path) => { const res = await fetch(`${apiBase()}/files/list?path=${encodeURIComponent(path)}`); return res.json(); },
  fetchFile: async (path) => { const res = await fetch(downloadURL(path)); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return res; },
};
window.ConsoleAPI.setMdRenderer = (fn) => { window.__mdRender = fn; };

/* ------------------------------- wiring --------------------------------- */
$("attach").addEventListener("click", () => $("chatupload").click());
$("chatupload").addEventListener("change", async (e) => {
  if (e.target.files?.length) {
    await uploadFiles(e.target.files);
    window.Chat?.onUploaded?.([...e.target.files].map(f => f.name));
  }
  e.target.value = "";
});

/* ---------------------------- sessions chip ----------------------------- */
const sessionsEl = $("sessions");
async function pollSessions() {
  const sessionsEl = $("sessions");
  if (!sessionsEl) return;
  if (!connected) { return; }
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
  const raw = (window.Chat?.getHistory?.() ?? loadHistory());
  const list = window.__dedupeTitles ? window.__dedupeTitles(raw) : raw;
  const q = ($("hsearch")?.value ?? "").trim().toLowerCase();
  const cur = window.Chat?.getCurrentId?.() ?? null;
  const filtered = q ? list.filter((h) => (h.title || "").toLowerCase().includes(q)) : list;
  if (!filtered || filtered.length === 0) {
    historyEl.innerHTML = (!raw || raw.length === 0)
      ? '<div class="history-empty">no conversations yet</div>'
      : '<div class="history-empty">no matches</div>';
    return;
  }
  for (const h of filtered) {
    const el = document.createElement("div");
    el.className = "history-item" + (h.id === cur ? " active" : "");
    el.innerHTML = `<span class="hi-dot"></span><span class="hi-text"></span><span class="hi-time"></span><button class="hi-menu" title="options">⋯</button>`;
    el.querySelector(".hi-text").textContent = h.title || "(new conversation)";
    el.querySelector(".hi-time").textContent = window.relTime ? window.relTime(h.ts) : "";
    el.addEventListener("click", () => window.Chat?.loadConversation(h.id));
    el.querySelector(".hi-menu").addEventListener("click", (ev) => {
      ev.stopPropagation();
      document.querySelectorAll(".hi-pop").forEach((n) => n.remove());
      const pop = document.createElement("div");
      pop.className = "hi-pop";
      pop.innerHTML = `<button data-act="rename">Rename</button><button data-act="delete">Delete</button>`;
      pop.style.cssText = "position:absolute;z-index:50;background:var(--bg-3);border:1px solid var(--line-1);border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;";
      for (const b of pop.querySelectorAll("button")) {
        b.style.cssText = "background:transparent;border:none;color:var(--fg-0);font-size:12px;text-align:left;padding:5px 10px;border-radius:6px;";
      }
      const r = ev.target.getBoundingClientRect();
      pop.style.top = `${r.bottom + window.scrollY + 4}px`;
      pop.style.left = `${Math.max(8, r.left - 90)}px`;
      document.body.appendChild(pop);
      const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); } };
      setTimeout(() => document.addEventListener("click", close), 0);
      pop.querySelector('[data-act="rename"]').addEventListener("click", () => {
        const next = prompt("Rename conversation", h.title);
        if (next !== null) window.Chat?.renameConversation?.(h.id, next);
        pop.remove();
      });
      pop.querySelector('[data-act="delete"]').addEventListener("click", () => {
        window.Chat?.deleteConversation?.(h.id);
        pop.remove();
      });
    });
    historyEl.appendChild(el);
  }
}
window.renderHistory = renderHistory;
$("newchat").addEventListener("click", () => { if (window.Chat?.newChat) window.Chat.newChat(); });
$("hsearch")?.addEventListener("input", renderHistory);
$("settingsbtn").addEventListener("click", () => window.Chat?.openSettings());

/* -------------------------------- boot ---------------------------------- */
const qsWs = new URLSearchParams(location.search).get("ws");
if (qsWs) localStorage.setItem("fusebox.wsurl", qsWs);
setStatus("off", "disconnected");
renderHistory();
// auto-connect on boot; failures stay silent (no toast/modal) —
// runCommand's ensureConnected retries on send.
connect();