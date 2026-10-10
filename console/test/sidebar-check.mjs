// Sidebar check: seeds fusebox.history with duplicate titles and asserts
// the rendered sidebar dedupes them (hey, hey · 2, List sandbox outputs).
//
//   node console/test/sidebar-check.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400"
//
// Exit code 0 = PASS.

import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const consoleUrl = process.argv[2] ?? "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400";
const DEBUG_PORT = 9335;
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-sidebar-"));

const log = (m) => process.stderr.write(m + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--window-size=1440,860", "about:blank",
], { stdio: "ignore" });

async function cdpConnect() {
  for (let i = 0; i < 40; i++) {
    try {
      const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json());
      return v.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("chrome CDP never came up");
}

const browserWs = await cdpConnect();
const ws = new WebSocket(browserWs);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 600));
  return r?.result?.value;
};

await send("Page.navigate", { url: consoleUrl }, sessionId);
await sleep(2200);

// Seed history, then reload so both app.js + chat.js boot from it.
await evalJs(`(function(){
  const now = Date.now();
  const seed = [
    { id: "c1", title: "hey", ts: now - 3000, messages: [] },
    { id: "c2", title: "hey", ts: now - 2000, messages: [] },
    { id: "c3", title: "List sandbox outputs", ts: now - 1000, messages: [] },
  ];
  localStorage.setItem("fusebox.history", JSON.stringify(seed));
  return "seeded";
})()`);
await send("Page.navigate", { url: consoleUrl }, sessionId);
await sleep(2200);

const rows = await evalJs(`[...document.querySelectorAll("#history .history-item .hi-text")].map(el => el.textContent)`);
log("rows: " + JSON.stringify(rows));

const expected = ["hey", "hey · 2", "List sandbox outputs"];
const ok = JSON.stringify(rows) === JSON.stringify(expected);
log(ok ? "==> SIDEBAR CHECK: PASS" : `==> SIDEBAR CHECK: FAILED (expected ${JSON.stringify(expected)})`);
ws.close();
chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
process.exit(ok ? 0 : 1);
