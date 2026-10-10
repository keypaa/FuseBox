// Screenshot driver: boots a real (headless) Chrome via CDP, opens the
// console, connects it to a live supervisor, waits for the session, and
// captures a PNG of the connected state.
//
//   node test/screenshot.mjs <console-url> <out.png> [waitMs]
//
// Requires: google-chrome-stable on PATH, a supervisor running for the
// console's ?ws= endpoint, and the console served over http (serve.sh).

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const consoleUrl = process.argv[2] ?? "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400";
const outPath = process.argv[3] ?? "/tmp/console-shot.png";
const waitMs = Number(process.argv[4] ?? 4000);
const DEBUG_PORT = 9333;

// NOTE: no pkill here — this script's own command line would match the
// pattern and kill the invoking shell. chrome.kill() below cleans up.
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--window-size=1440,860", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect() {
  for (let i = 0; i < 40; i++) {
    try {
      const version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json());
      return version.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("chrome CDP never came up");
}

const log = (m) => writeSync2(m);
function writeSync2(m) { process.stderr.write(m + "\n"); }

const browserWs = await cdpConnect();
log("CDP up");
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

await send("Page.navigate", { url: consoleUrl }, sessionId);
await sleep(2500);

// boot auto-connects the PTY; wait for #status to read "connected"
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
  return r?.result?.value;
};

let bootStatus = "";
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { bootStatus = await evalJs(`document.getElementById("status").textContent`); }
  catch { bootStatus = ""; }
  if (bootStatus === "connected") break;
}
log(`auto-connect status: ${JSON.stringify(bootStatus)}`);
await sleep(Math.max(0, waitMs - 1000));

// No file panel anymore — read back only status/sessions, guarded so
// missing drawer functions don't throw.
const fileList = await evalJs(`(function(){
  const out = {
    sessions: document.getElementById("sessions").textContent,
    status: document.getElementById("status").textContent,
  };
  if (typeof window.refreshFiles === "function") out.refreshFiles = "still present";
  if (typeof window.ensureDirOption === "function") out.ensureDirOption = "still present";
  if (typeof window.openDrawer === "function") out.openDrawer = "still present";
  return out;
})()`);
log("panel state: " + JSON.stringify(fileList));

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(outPath, Buffer.from(shot.data, "base64"));
log(`saved ${outPath}`);

// report what the page itself thinks
const state = await evalJs(`({
  status: document.getElementById("status").textContent,
  sessions: document.getElementById("sessions").textContent,
  cards: document.querySelectorAll(".file-card").length,
})`);
log("page state: " + JSON.stringify(state));

ws.close();
chrome.kill();
process.exit(0);
