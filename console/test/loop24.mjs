import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9361",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html?cb=" + Date.now(),
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9361/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error("cdp up");
})();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
function send(method, params = {}, sessionId) { return new Promise((res, rej) => { const id = ++msgId; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: "http://127.0.0.1:8077/index.html?cb=" + Date.now() }, sessionId);
await sleep(3000);
// check what renderHistory is
let info = await send("Runtime.evaluate", {
  expression: `({rhType:typeof renderHistory, rhStr:(typeof renderHistory==="function"?renderHistory.toString().slice(0,200):"n/a"), hasChat:typeof window.Chat, chatKeys:window.Chat?Object.keys(window.Chat):null})`,
  returnByValue: true,
}, sessionId);
console.log("info:", JSON.stringify(info.result?.value));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
