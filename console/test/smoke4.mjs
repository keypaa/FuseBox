import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profileDir = mkdtempSync(join(tmpdir(), "fusebox-smoke-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=9340",
  "--window-size=1440,860", "http://127.0.0.1:8077/index.html",
], { stdio: "ignore" });
const wsUrl = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch("http://127.0.0.1:9340/json/version").then(r => r.json()); return v.webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error("cdp up");
})();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
function send(method, params = {}) { return new Promise((res, rej) => { const id = ++msgId; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); }); }
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const P = (method, params = {}) => send(method, { ...params, sessionId });
await P("Page.enable");
await P("Runtime.enable");
await P("Page.navigate", { url: "http://127.0.0.1:8077/index.html" });
await sleep(2500);
const r = await P("Runtime.evaluate", {
  expression: `({title:document.title, hasChat:!!document.getElementById("chatcol"), hasSidebar:!!document.getElementById("history"), hasComposer:!!document.getElementById("chatin"), emptyHidden:document.getElementById("emptystate").hidden, bodyClass:document.body.className, errors:(window.__fuseboxErrors||[]).slice(0,5)})`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.value, null, 2));
const shot = await P("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fusebox-console.png", Buffer.from(shot.data, "base64"));
ws.close(); chrome.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
