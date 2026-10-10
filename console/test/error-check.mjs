// Task 5 error-path check: a dead model endpoint must render a Claude-shaped
// error card (#chatcol .err-card) with "Go back" / "Try again" buttons —
// not a toast.
//
//   node console/test/error-check.mjs "http://127.0.0.1:8099/" [/tmp/t5-error.png]
//
// Needs the console served over http (any static server, any free port).
// Needs NO supervisor: the seeded endpoint (http://127.0.0.1:9/v1) is dead
// on purpose, so the model-error path fires without any PTY interaction.
// Exits 0 on PASS, 1 on FAIL.

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const consoleUrl = process.argv[2] ?? "http://127.0.0.1:8077/";
const outPath = process.argv[3] ?? "/tmp/t5-error.png";
const DEBUG_PORT = 9336;
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-errcheck-"));

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

function cleanup() {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}

async function fail(why) {
  try {
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    log("saved " + outPath);
  } catch {}
  log("==> ERROR CHECK: FAILED — " + why);
  cleanup();
  process.exit(1);
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

// seed the dead endpoint + blank chat state, then reload so settings apply
await evalJs(`(function(){
  localStorage.setItem("fusebox.api", JSON.stringify({baseUrl: "http://127.0.0.1:9/v1", key: "", model: "dead-end"}));
  localStorage.setItem("fusebox.chat", "[]");
  localStorage.setItem("fusebox.history", "[]");
  return "seeded";
})()`);
await send("Page.navigate", { url: consoleUrl }, sessionId);
await sleep(2200);

// send a user message through the composer
await evalJs(`(function(){
  const t = document.getElementById("chatin");
  t.value = "hello";
  t.dispatchEvent(new Event("input", {bubbles: true}));
  document.getElementById("send").click();
  return "sent";
})()`);
log("message sent; waiting for the error card…");

const probeCard = `(function(){
  const card = document.querySelector("#chatcol .err-card");
  if (!card) return null;
  const text = card.innerText;
  return {
    hasTry: !!card.querySelector('[data-act="retry"]') && text.includes("Try again"),
    hasBack: !!card.querySelector('[data-act="back"]') && text.includes("Go back"),
    title: (card.querySelector(".err-title") || {}).innerText || "",
    meta: (card.querySelector(".err-meta") || {}).innerText || "",
  };
})()`;

let card = null;
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  card = await evalJs(probeCard);
  if (card?.hasTry && card?.hasBack) break;
}
if (!card) await fail("no .err-card rendered within 15s (errors still surface as toasts?)");
if (!(card.hasTry && card.hasBack)) await fail("card missing buttons: " + JSON.stringify(card));
log("card: " + JSON.stringify(card));

// clicking Try again must re-render a fresh card (endpoint still dead)
await evalJs(`(function(){
  document.querySelector('#chatcol .err-card [data-act="retry"]').click();
  return "retried";
})()`);
log("Try again clicked; waiting for the fresh card…");
let card2 = null;
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  card2 = await evalJs(probeCard);
  if (card2?.hasTry && card2?.hasBack) break;
}
if (!(card2?.hasTry && card2?.hasBack)) await fail("Try again did not re-render a card: " + JSON.stringify(card2));
log("retry card: " + JSON.stringify(card2));

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(outPath, Buffer.from(shot.data, "base64"));
log("saved " + outPath);

log("==> ERROR CHECK: PASS");
cleanup();
process.exit(0);
