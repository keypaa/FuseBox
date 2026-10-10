import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9342",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html",
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9342/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
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

// connect the PTY to the VM
await send("Runtime.evaluate", {
  expression: `document.getElementById("connect").click(); "clicked"`,
  returnByValue: true,
}, sessionId);
await sleep(3000);

let state = await send("Runtime.evaluate", {
  expression: `({status:document.getElementById("status").textContent, connected: document.getElementById("status").textContent})`,
  returnByValue: true,
}, sessionId);
console.log("connect:", JSON.stringify(state.result?.value));

// send a user message
await send("Runtime.evaluate", {
  expression: `(function(){const t=document.getElementById("chatin");t.value="Run the mock demo for me.";document.getElementById("send").click();return "sent";})()`,
  returnByValue: true,
}, sessionId);

for (let i = 0; i < 20; i++) {
  await sleep(1000);
  state = await send("Runtime.evaluate", {
    expression: `(function(){const c=document.getElementById("chatcol");return {msgs:[...c.querySelectorAll(".msg")].map(m=>m.className), text:c.innerText.slice(0,400), toolCards:[...c.querySelectorAll(".tool-card")].map(c=>({name:c.querySelector(".tc-name")?.textContent, open:c.classList.contains("open"), rc:c.querySelector(".tc-rc")?.textContent?.slice(0,40)}))};})()`,
    returnByValue: true,
  }, sessionId);
  const v = state.result?.value;
  console.log(`t${i+1}: msgs=${JSON.stringify(v?.msgs)} cards=${JSON.stringify(v?.toolCards?.map(c=>c.name))}`);
  if (v?.text?.includes("Switch the provider")) { console.log("DONE"); break; }
}
const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync("/tmp/fusebox-loop.png", Buffer.from(shot.data, "base64"));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
