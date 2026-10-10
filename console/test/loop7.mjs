import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9344",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html",
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9344/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
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
await send("Page.navigate", { url: "http://127.0.0.1:8077/index.html" }, sessionId);
await sleep(2500);

// try a raw browser WebSocket to the VM
let probe = await send("Runtime.evaluate", {
  expression: `(async()=>{return new Promise(res=>{const s=new WebSocket("ws://192.0.2.2:2024");s.onopen=()=>res("OPEN");s.onerror=()=>res("ERR");s.onclose=()=>res("CLOSE");setTimeout(()=>res("TIMEOUT"),4000);})})()`,
  awaitPromise: true, returnByValue: true,
}, sessionId);
console.log("browser ws probe:", JSON.stringify(probe.result?.value));

await send("Runtime.evaluate", {
  expression: `document.getElementById("connect").click(); "clicked"`,
  returnByValue: true,
}, sessionId);
await sleep(4000);
let st = await send("Runtime.evaluate", {
  expression: `({jsStatus:document.querySelector(".js-status")?.textContent, dot:document.querySelector(".dot")?.className})`,
  returnByValue: true,
}, sessionId);
console.log("after click:", JSON.stringify(st.result?.value));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
