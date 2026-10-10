// End-to-end test of the chat agent loop in a real (headless) browser:
// user message → mock model → run_command tool call → PTY execution →
// assistant summary, plus the file it created appearing in the files panel
// and via the Control API.
//
//   node test/chat-e2e.mjs <console-url> <out.png>
//
// Requires a supervisor for the console's ?ws= endpoint and the console
// served over http (./serve.sh).

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const consoleUrl = process.argv[2] ?? "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400";
const outPath = process.argv[3] ?? "/tmp/console-chat.png";
const DEBUG_PORT = 9334;
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-e2e-"));

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

// FAKE_LLM_URL=http://127.0.0.1:8079/v1 → exercise the real streaming path
// (SSE deltas + fragmented tool_calls) against test/sse-mock.py instead of
// the built-in mock provider. Seed settings, then reload so they apply.
if (process.env.FAKE_LLM_URL) {
  await evalJs(`localStorage.setItem("fusebox.api", JSON.stringify({
    baseUrl: ${JSON.stringify(process.env.FAKE_LLM_URL)},
    key: "", model: "fake-stream",
  })); "seeded"`);
  await send("Page.navigate", { url: consoleUrl }, sessionId);
  await sleep(1800);
}

// boot auto-connects the PTY; wait for #status to read "connected"
let autoStatus = "";
for (let i = 0; i < 24; i++) {
  await sleep(500);
  try { autoStatus = await evalJs(`document.getElementById("status").textContent`); }
  catch { autoStatus = ""; }
  if (autoStatus === "connected") break;
}
if (autoStatus !== "connected") {
  log(`==> CHAT E2E: FAILED — boot auto-connect never reported "connected" (status=${JSON.stringify(autoStatus)})`);
  ws.close();
  chrome.kill();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
log("auto-connected: " + JSON.stringify(autoStatus));

const pre = await evalJs(`({
  connected: document.getElementById("status").textContent,
  prompt: !!document.querySelector("#terminal .xterm"),
})`);
log("pre: " + JSON.stringify(pre));

// send a user message through the composer
await evalJs(`(function(){
  const t = document.getElementById("chatin");
  t.value = "Run the mock demo for me.";
  document.getElementById("send").click();
  return "sent";
})()`);
log("message sent; waiting for the agent loop…");

let finalState = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  finalState = await evalJs(`(function(){
    const msgs = [...document.querySelectorAll("#chatcol .msg")].map(m => m.className);
    const text = document.getElementById("chatcol").innerText;
    return {
      messages: msgs,
      hasMockFile: text.includes("mock.txt"),
      hasSummary: text.includes("Switch the provider") || text.includes("actual model"),
      sessions: document.getElementById("sessions").textContent,
      status: document.getElementById("status").textContent,
    };
  })()`);
  if (finalState.hasSummary) break;
}

// the file the tool created must be visible via the Control API —
// production guests expose /mnt/user-data/outputs; dev hosts fall back
// to /tmp/fusebox-demo (same probe the mock command uses)
let apiList = null;
try {
  const base = consoleUrl.includes("192.0.2.2")
    ? "http://192.0.2.2:2025"
    : "http://127.0.0.1:12401";
  const listFor = async (p) =>
    (await fetch(`${base}/files/list?path=${encodeURIComponent(p)}`)).json();
  apiList = await listFor("/mnt/user-data/outputs").catch(() => null);
  if (!Array.isArray(apiList?.entries)) apiList = await listFor("/tmp/fusebox-demo");
} catch (e) { apiList = { error: String(e) }; }

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(outPath, Buffer.from(shot.data, "base64"));

log("final: " + JSON.stringify(finalState));
log("api list: " + JSON.stringify(apiList).slice(0, 200));
log("saved " + outPath);

const ok = finalState?.hasMockFile && finalState?.hasSummary &&
           JSON.stringify(apiList).includes("mock.txt");
let sseOk = true;
if (process.env.FAKE_LLM_URL) {
  let hits = "0";
  try { hits = await import("node:fs").then(fs => fs.readFileSync("/tmp/fusebox-sse-hit", "utf8")); } catch {}
  sseOk = parseInt(hits) >= 2; // round-trip proves SSE tool_call merge worked
  log(`sse rounds: ${hits.trim()} ${sseOk ? "(loop completed over SSE)" : "(SSE loop incomplete)"}`);
}
log(ok && sseOk ? "==> CHAT E2E: ALL PASS" : "==> CHAT E2E: FAILED");
ws.close();
chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
process.exit(ok && sseOk ? 0 : 1);
