// Protocol smoke test for the FuseBox console.
//
// Drives a WebSocket session exactly the way console/app.js does — verbatim
// keyboard bytes out, JSON stdout chunks + control frames in — and asserts
// the interactions the browser terminal will perform, plus the Control-API
// file plane (list/download/upload) with a shell↔API roundtrip:
//
//   node test/smoke.mjs ws://127.0.0.1:12400
//
// Exit code 0 = all checks pass.

import { writeSync } from "node:fs";

const url = process.argv[2] ?? "ws://127.0.0.1:12400";
// Control API base: second CLI arg, else the WS port + 1 (the standard pairing).
const api =
  process.argv[3] ??
  url.replace(/^ws/, "http").replace(/:(\d+)(\/.*)?$/, (_, p, rest) => `:${Number(p) + 1}${rest ?? ""}`);

// Synchronous logging: stdout is pipe-buffered and process.exit discards
// pending writes, which hid whole test results behind a timeout.
function log(msg) {
  writeSync(2, msg + "\n");
}

let fails = 0;
let acc = "";
let exitCode = undefined;
let closed = false;

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

const pending = [];
function step(name, ok, detail) {
  log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
}

function pump(deadlineMs) {
  const until = Date.now() + deadlineMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() >= until || closed) return resolve();
      setTimeout(tick, Math.min(50, until - Date.now()));
    };
    tick();
  });
}

async function expect(needle, ms) {
  const until = Date.now() + ms;
  while (!acc.includes(needle)) {
    if (Date.now() > until || closed) break;
    await pump(50);
  }
  const ok = acc.includes(needle);
  step(`output contains ${JSON.stringify(needle)}`, ok,
       ok ? "" : "tail: " + JSON.stringify(acc.slice(-160)));
  return ok;
}

ws.onmessage = (ev) => {
  let text;
  if (ev.data instanceof ArrayBuffer) text = new TextDecoder().decode(ev.data);
  else text = ev.data;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    acc += text;
    return;
  }
  if (typeof obj.stream === "string" && typeof obj.text === "string") acc += obj.text;
  else if (obj.event === "exit") {
    exitCode = obj.code;
    acc += "\u0004EXIT\u0004";
  } else if (obj.event === "pong") acc += "\u0004PONG\u0004";
  else if (!obj.error) acc += text;
};
ws.onclose = () => { closed = true; };

ws.onopen = async () => {
  console.log(`==> connected to ${url}`);
  const send = (s) => ws.send(s);

  // 1. prompt
  await expect("@fusebox:", 8000);

  // 2. resize control frame, verified through the pty
  acc = "";
  send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  send("stty size\n");
  await expect("30 100", 5000);

  // 3. command execution
  acc = "";
  send("echo CONSOLE_SMOKE_$((6*7))\n");
  await expect("CONSOLE_SMOKE_42", 5000);

  // 4. Ctrl-C passthrough kills a foreground job
  send("sleep 30\n");
  await pump(1200);
  send("\x03");
  await expect("^C", 5000);
  acc = "";
  send("echo STILL_$((20+2))\n");
  await expect("STILL_22", 5000);

  // 5. ping control frame
  acc = "";
  send(JSON.stringify({ type: "ping" }));
  await expect("\u0004PONG\u0004", 5000);

  // 6. Control-API file plane — shell writes, API reads back.
  // Resolve a writable base first: the guest has /mnt/user-data, a bare dev
  // host does not (fall back to ~). Quote-split markers keep the echoed
  // command from matching the parser.
  acc = "";
  send(`test -w /mnt/user-data/outputs && echo WB""ASE=/mnt/user-data/outputs || { mkdir -p /tmp/fusebox-smoke/outputs /tmp/fusebox-smoke/uploads && echo WB""ASE=/tmp/fusebox-smoke/outputs; }\n`);
  await expect("WBASE=", 8000);
  const baseDir = (acc.split("WBASE=")[1] ?? "").split("\r")[0].split("\n")[0].trim();
  step("writable fileplane base", baseDir.length > 0, baseDir);
  if (!baseDir) {
    log(`==> ${++fails} CHECK(S) FAILED (abort)`);
    process.exit(1);
  }
  const upDir = baseDir.replace(/\/outputs$/, "/uploads");
  acc = "";
  send(`mkdir -p ${baseDir} ${upDir} && echo -n smoke_file_body > ${baseDir}/smoke.txt && echo FILEPLANE_READY_$((7*6))\n`);
  await expect("FILEPLANE_READY_42", 8000);
  const dl = await fetch(`${api}/files/download?path=${encodeURIComponent(baseDir + "/smoke.txt")}`);
  const body = await dl.text();
  step(`API download returns shell-written content`, dl.ok && body === "smoke_file_body",
       `status=${dl.status} body=${JSON.stringify(body)}`);

  // list endpoint sees it
  const ls = await (await fetch(`${api}/files/list?path=${encodeURIComponent(baseDir)}`)).json();
  step(`API list contains smoke.txt`, Array.isArray(ls.entries) && ls.entries.some(e => e.name === "smoke.txt"),
       JSON.stringify(ls).slice(0, 120));

  // 7. API upload → shell verifies
  const up = await fetch(`${api}/files/upload?path=${encodeURIComponent(upDir + "/roundtrip.txt")}`, {
    method: "POST", body: "uploaded_via_api",
  });
  step(`API upload accepted`, up.ok, `status=${up.status}`);
  acc = "";
  send(`cat ${upDir}/roundtrip.txt\n`);
  await expect("uploaded_via_api", 5000);

  // 8. sessions endpoint reports this live session
  const sess = await (await fetch(`${api}/sessions`)).json();
  step(`/sessions lists the live session`,
       Array.isArray(sess.sessions) && sess.sessions.length >= 1,
       JSON.stringify(sess).slice(0, 140));

  // 9. clean exit event
  acc = "";
  send("exit\n");
  await expect("\u0004EXIT\u0004", 5000);
  step(`exit event carries code 0`, exitCode === 0, `got ${exitCode}`);

  log(fails === 0 ? "==> CONSOLE SMOKE: ALL PASS" : `==> ${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
};

ws.onerror = () => {
  console.error(`FATAL: cannot connect to ${url} — is process_api running?`);
  process.exit(2);
};

setTimeout(() => {
  console.error("FATAL: global timeout");
  process.exit(3);
}, 60000);
