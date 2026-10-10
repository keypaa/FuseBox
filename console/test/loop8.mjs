import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-loop-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9345",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html",
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9345/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
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

// seed the OpenRouter key + model into localStorage
const key = process.env.OPENROUTER_API_KEY;
await send("Runtime.evaluate", {
  expression: `localStorage.setItem("fusebox.api", JSON.stringify({baseUrl:"https://openrouter.ai/api/v1", key:${JSON.stringify(key)}, model:"inclusionai/ling-3.1-flash"})); "seeded"`,
  returnByValue: true,
}, sessionId);
await sleep(300);

let st = await send("Runtime.evaluate", {
  expression: `({chip:document.getElementById("modelchip").textContent})`,
  returnByValue: true,
}, sessionId);
console.log("chip:", JSON.stringify(st.result?.value));

await send("Runtime.evaluate", {
  expression: `(function(){const t=document.getElementById("chatin");t.value="Say exactly: hello world";document.getElementById("send").click();return "sent";})()`,
  returnByValue: true,
}, sessionId);

for (let i = 0; i < 25; i++) {
  await sleep(1000);
  st = await send("Runtime.evaluate", {
    expression: `(function(){const c=document.getElementById("chatcol");return {msgs:[...c.querySelectorAll(".msg")].map(m=>m.className), text:c.innerText.slice(0,300), errors:(window.__fuseboxErrors||[]).slice(0,3)};})()`,
    returnByValue: true,
  }, sessionId);
  const v = st.result?.value;
  console.log(`t${i+1}: msgs=${JSON.stringify(v?.msgs)} text=${JSON.stringify(v?.text?.slice(0,120))} errs=${JSON.stringify(v?.errors)}`);
  if (v?.text?.includes("hello world")) { console.log("DONE - model replied"); break; }
  if (v?.text?.includes("model error") || v?.text?.includes("rate-limited")) { console.log("DONE - error path"); break; }
}
const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync("/tmp/fusebox-loop.png", Buffer.from(shot.data, "base64"));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
