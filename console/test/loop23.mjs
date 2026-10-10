import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9360",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html?cb=" + Date.now(),
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9360/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
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
// instrument agentLoop + sendMessage
await send("Runtime.evaluate", {
  expression: `(function(){const w=window;w.__log=[];w.__origAgent=window.Chat&&window.Chat.agentLoop;const origSend=window.Chat&&window.Chat.sendMessage;return "ok";})()`,
  returnByValue: true,
}, sessionId);
const key = process.env.OPENROUTER_API_KEY;
await send("Runtime.evaluate", {
  expression: `localStorage.setItem("fusebox.api", JSON.stringify({baseUrl:"https://openrouter.ai/api/v1", key:${JSON.stringify(key)}, model:"inclusionai/ling-3.1-flash"})); "seeded"`,
  returnByValue: true,
}, sessionId);
await sleep(300);
// call sendMessage directly and capture result
let r = await send("Runtime.evaluate", {
  expression: `(async()=>{window.__lastResult=null;window.__lastErr=null;try{const t=document.getElementById("chatin");t.value="Say exactly: hello world";const p=window.Chat.sendMessage();window.__lastResult=await p;return "resolved";}catch(e){window.__lastErr=(e?.message||e)+"\\n"+(e?.stack||"").slice(0,300);return "REJECTED:"+window.__lastErr;}})()`,
  awaitPromise: true, returnByValue: true,
}, sessionId);
console.log("direct call:", JSON.stringify(r.result?.value));
await sleep(6000);
let st = await send("Runtime.evaluate", {
  expression: `({lastResult:window.__lastResult, lastErr:window.__lastErr, allText:document.getElementById("chatcol").innerText.slice(0,500), sendTxt:document.getElementById("send").textContent, generating:document.getElementById("send").classList.contains("stop")})`,
  returnByValue: true,
}, sessionId);
console.log("state:", JSON.stringify(st.result?.value, null, 2));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
