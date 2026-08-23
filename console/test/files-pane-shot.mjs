// Screenshot the Files drawer pane against a live process_api.
//   node test/files-pane-shot.mjs <console-url> <out.png>
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const consoleUrl = process.argv[2] ?? "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400";
const outPath = process.argv[3] ?? "/tmp/console-files.png";
const DEBUG_PORT = 9335;
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-shot-"));

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

const ws = new WebSocket(await cdpConnect());
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
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

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
await sleep(1800);
// seed the restored-directory flow the way a returning user has it:
// storage first, then a reload so boot runs ensureDirOption(savedDir)
await evalJs(`localStorage.setItem("fusebox.filesdir", "/tmp/fusebox-demo"); "seeded"`);
await send("Page.navigate", { url: consoleUrl }, sessionId);
await sleep(1800);
await evalJs(`(function(){
  document.getElementById("connect").click();
  return "connecting";
})()`);
await sleep(2500);
await evalJs(`(function(){
  document.querySelector('.tab[data-tab="files"]').click();
  return "files tab";
})()`);
await sleep(1500);

const state = await evalJs(`({
  entries: document.querySelectorAll("#filelist li").length,
  first: document.querySelector("#filelist li")?.textContent?.trim()?.slice(0, 60),
})`);
process.stderr.write("files pane: " + JSON.stringify(state) + "\n");

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(outPath, Buffer.from(shot.data, "base64"));
process.stderr.write("saved " + outPath + "\n");
ws.close();
chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
