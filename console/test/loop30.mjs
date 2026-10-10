import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9367",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html?cb=" + Date.now(),
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9367/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
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
await send("Runtime.evaluate", {
  expression: `window.__fuseboxErrors=[]; window.addEventListener("error",e=>{window.__fuseboxErrors.push("ERR: "+e.message+"\\n"+(e.stack||"").slice(0,400));}); window.addEventListener("unhandledrejection",e=>{window.__fuseboxErrors.push("UNH: "+(e.reason?.message||e.reason)+"\\n"+(e.reason?.stack||"").slice(0,400));}); "ok"`,
  returnByValue: true,
}, sessionId);
await send("Runtime.evaluate", {
  expression: `localStorage.setItem("fusebox.api", JSON.stringify({baseUrl:"mock", key:"", model:"fusebox-mock"})); "seeded"`,
  returnByValue: true,
}, sessionId);
await sleep(300);
await send("Runtime.evaluate", {
  expression: `(function(){const t=document.getElementById("chatin");t.value="Run the mock demo for me.";document.getElementById("send").click();return "sent";})()`,
  returnByValue: true,
}, sessionId);
await sleep(8000);
const st = await send("Runtime.evaluate", {
  expression: `({errors:window.__fuseboxErrors, allText:document.getElementById("chatcol").innerText.slice(0,500)})`,
  returnByValue: true,
}, sessionId);
console.log(JSON.stringify(st.result?.value, null, 2));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
