# FuseConsole Claude-clone Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `console/` (option B) as a full Claude-clone per `docs/superpowers/specs/2026-09-23-fuseconsole-claude-redesign-design.md`, verified by both chat E2E modes, smoke, and reviewed screenshots.

**Architecture:** Fresh `console/index.html` skeleton (sidebar, slim topbar, centered column, composer card, artifact panel) plus rebuilt `console/style.css`; `chat.js`/`app.js` keep all protocol logic (PTY 2024, Control API 2025, SSE merge, mock brain) with render/wiring functions adapted to the new ids; `console/test/dom-contract.mjs` pins the id contract so the e2e suite never silently breaks.

**Tech Stack:** Vanilla HTML/CSS/JS (no build), vendored xterm.js 5.5.0, Lora self-hosted fonts, stdlib python servers, headless Chrome CDP screenshot drivers, `node --check` + python AST for syntax.

## Global Constraints

- Offline-first: no CDN, no new runtime dependencies; fonts and xterm stay vendored.
- No backend changes: `sandbox/process_api`, `console/llm-proxy.py`, `console/serve.sh`, WS 2024 framing, Control API 2025 routes are untouched.
- The `?ws=` override (`app.js`) keeps working for dev/test harnesses.
- API key stays browser-`localStorage`-only (`fusebox.api`); chats stay `localStorage`-only.
- Every task ends green: contract script, and where noted the mock E2E / SSE E2E / smoke commands below.
- Reference commands (run from `/home/keypaa/Work/tries/FuseBox`):
  - Start stack: `(cd sandbox/process_api && ./target/x86_64-unknown-linux-musl/release/process_api --addr 127.0.0.1:12400 --control-server-addr 127.0.0.1:12401 >/dev/null 2>&1 &) ; (cd console && ./serve.sh 8077 >/dev/null 2>&1 &) ; (cd console/test && ./sse-mock.py 8079 >/tmp/sse-mock.log 2>&1 &)`
  - Mock E2E: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat-mock.png`
  - SSE E2E: `FAKE_LLM_URL=http://127.0.0.1:8079/v1 node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat-stream.png`
  - Smoke: `node console/test/smoke.mjs ws://127.0.0.1:12400`
  - Shot: `node console/test/screenshot.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/shot.png 4000`

---

### Task 1: New index.html skeleton + DOM contract

**Files:**
- Create: `console/test/dom-contract.mjs`
- Modify: `console/index.html` (full rewrite, ~200 lines)

**Interfaces:**
- Consumes: e2e id list (`chatcol`, `chatin`, `send`, `status`, `connect`, `sessions`, `filelist`, `filesdir`, `.tab[data-tab]`, `#terminal .xterm`).
- Produces: new ids consumed later — `sidebar`, `chatlist`, `newchat-side`, `topbar`, `chattitle`, `conn-pill`, `composer-card`, `model-label`, `plus-btn`, `plus-menu`, `toolcard` (class), `turn-sep` (class). Task 3+ binds chat.js to these.

- [ ] **Step 1: Write the DOM contract test (fails on new ids)**

```js
// console/test/dom-contract.mjs — pins the HTML/CSS/JS id contract.
// Run: node console/test/dom-contract.mjs
import { readFileSync } from "node:fs";
const html = readFileSync("console/index.html", "utf8");
const css = readFileSync("console/style.css", "utf8");
const js = readFileSync("console/chat.js", "utf8") + readFileSync("console/app.js", "utf8");
const needIds = ["chatcol","chatin","send","status","connect","sessions","filelist",
  "filesdir","terminal","sidebar","chatlist","composer-card","model-label","plus-btn",
  "conn-pill","chattitle","emptystate","chatscroll","toasts","settings","preview"];
let fail = 0;
for (const id of needIds) {
  if (!html.includes(`id="${id}"`)) { console.error(`MISSING id="${id}" in index.html`); fail++; }
  const used = js.includes(`"${id}"`) || js.includes(`'${id}'`);
  if (["chatcol","chatin","send","status","connect","sessions","filelist","filesdir"].includes(id) && !used) {
    console.error(`id="${id}" not referenced by chat.js/app.js`); fail++;
  }
}
for (const cls of [".tab[data-tab", "#terminal .xterm", "--coral", "--serif"]) {
  if (!(html + css).includes(cls)) { console.error(`MISSING ${cls}`); fail++; }
}
console.log(fail ? `CONTRACT FAIL (${fail})` : "CONTRACT PASS");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, confirm it fails on the new ids**

Run: `node console/test/dom-contract.mjs`
Expected: FAIL listing `sidebar`, `chatlist`, `composer-card`, `model-label`, `plus-btn`, `conn-pill`, `chattitle` (old file has `modelchip`, `dot`, `brand-*`, `drawer-terminal` instead).

- [ ] **Step 3: Rewrite index.html**

New skeleton (keep every e2e id from the contract; `modelchip` → `model-label` with the same settings-open behavior; `dot`+`status` move inside `conn-pill`; `drawer-terminal`/`drawer-files` become header icon buttons with the SAME ids; drawer tabs keep `class="tab" data-tab="terminal|files"`, panes keep `data-pane`; keep `settings`, `preview`, `toasts`, `chatupload`, `dropzone`, `filesdir`, `filelist`, `refresh`, `connect`, `sessions`, `terminal`, `term-overlay`):

```html
<body>
<div class="app">
  <aside id="sidebar">
    <button id="newchat-side">＋ New chat</button>
    <ul id="chatlist"></ul>
    <button id="sidebar-collapse" title="collapse">«</button>
  </aside>
  <div class="main">
    <header id="topbar">
      <span class="nav-icons">…</span>
      <button id="chattitle">New conversation ▾</button>
      <span class="flex-spacer"></span>
      <span id="conn-pill"><span id="dot" class="dot"></span><span id="status">disconnected</span></span>
      <span id="sessions" class="chip">–</span>
      <button id="drawer-terminal" class="ghost">Terminal</button>
      <button id="drawer-files" class="ghost">Files</button>
      <button id="newchat" class="ghost">＋ New chat</button>
      <button id="settingsbtn" class="ghost">⚙</button>
    </header>
    <main id="chatwrap">
      <div id="chatscroll"><div id="chatcol">
        <div id="emptystate" class="hero">
          <div class="hero-mark">✳</div>
          <h1>You're in the sandbox!</h1>
          <p>Ask for anything — the model runs commands and reads/writes files inside the microVM.</p>
          <div class="suggestions">
            <button data-fill="List what's mounted in this sandbox and read the first skill file you find.">Explore the sandbox</button>
            <button data-fill="Write a small bash one-liner that prints today's date, save it to /mnt/user-data/outputs/date.sh and run it.">Save &amp; run a script</button>
            <button data-fill="What's in /proc/cpuinfo here? Summarize the CPU the sandbox sees.">Inspect the machine</button>
          </div>
        </div>
      </div></div>
      <div class="composer-zone">
        <div id="composer-card">
          <textarea id="chatin" rows="1" placeholder="Write a message…"></textarea>
          <div class="composer-row">
            <button id="plus-btn" title="attach">+</button>
            <div id="plus-menu" hidden><button id="attach">Upload file</button></div>
            <span class="seg"><span class="seg-on">Chat</span></span>
            <span class="flex-spacer"></span>
            <button id="model-label" class="chip" title="model settings"></button>
            <button id="send" class="send" title="send (Enter)">↑</button>
          </div>
        </div>
        <div class="composer-note">model output executes inside the FuseBox microVM · Enter sends, Shift+Enter = newline</div>
      </div>
    </main>
  </div>
  <aside id="devdrawer" class="drawer">… tabs/panes kept, artifact-card classes added …</aside>
</div>
… settings modal, preview modal, toasts, chatupload, scripts (app.js then chat.js) …
```

- [ ] **Step 4: Run contract + syntax, confirm green**

Run: `node console/test/dom-contract.mjs && node --check console/chat.js && node --check console/app.js`
Expected: CONTRACT PASS, no syntax errors. (Page will look half-styled until Task 2 — expected.)

- [ ] **Step 5: Commit**

```bash
git add console/index.html console/test/dom-contract.mjs
git commit -m "feat(console): Claude-layout skeleton + DOM contract test"
```

### Task 2: style.css rebuild (tokens, texture, layout, responsive base)

**Files:**
- Modify: `console/style.css` (full rewrite, keep all existing CSS vars, shift `--bg-0` to `#1f1e1d`)

**Interfaces:**
- Consumes: ids/classes from Task 1.
- Produces: `.hero`, `.turn-sep`, `.toolcard(.collapsed)`, `.filecard`, `.activity`, `.chip-row`, `.msg.user/.assistant/.tool`, `.sidebar(.collapsed)`, overlay rules. Tasks 3–5 use these class names verbatim.

- [ ] **Step 1: Extend contract with the new classes, run, confirm fail**

Append to `needClasses = ["hero","turn-sep","toolcard","filecard","composer-card","chatlist","conn-pill"]` checked against `style.css` in `dom-contract.mjs`.

Run: `node console/test/dom-contract.mjs`
Expected: FAIL listing the new classes.

- [ ] **Step 2: Rewrite style.css**

Keep: every `--*` var (change `--bg-0: #1f1e1d`), Lora `@font-face`, xterm overrides, toast/modal/preview/upload/dropzone/pane rules (re-skinned, not removed). Add: body arch-glow (`body::before` radial-gradient at 50% 30%) + silhouette (`body::after` layered linear-gradient, 12vh, opacity .5); `.app` flex row; `#sidebar` 240px collapsible; `.main` column; `#chatcol` `max-width:680px; margin:0 auto; padding:48px 16px 24px`; `.hero` centered serif; `#composer-card` `#262524` border `#3b3835` radius 14px, row layout per §4; `.msg.user .bubble` right pill `#2e2c2b`; `.msg.assistant .bubble` transparent serif cream; `.turn-sep` coral ✳ centered; `.toolcard` dark card + `.collapsed` hides body; `.filecard` row cards; timestamps `.ts`; narrow `@media (max-width:560px)` rules (§8: fluid column, chip snap-scroll, condensed composer, overlay sidebar).

- [ ] **Step 3: Contract green + empty-state screenshot reviewed**

Run: `node console/test/dom-contract.mjs`
Expected: CONTRACT PASS.
Run: `node console/test/screenshot.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/shot-empty.png 4000`
Expected: reviewed with `read` — hero, composer card, texture match §2/§3 (iterate CSS until yes).

- [ ] **Step 4: Commit**

```bash
git add console/style.css console/test/dom-contract.mjs
git commit -m "feat(console): Claude tokens, hero, composer card, responsive base"
```

### Task 3: chat.js conversation rendering (no who-rows, separators, timestamps, file cards)

**Files:**
- Modify: `console/chat.js` (`elFor`, `renderMsg`, `enhanceCode`, live bubble in `agentLoop`, `updateChip`, suggestion wiring)

**Interfaces:**
- Consumes: Task 1 ids, Task 2 classes.
- Produces: message DOM shapes Task 4 extends: `.msg.assistant > .bubble.md`, `.turn-sep`, `.ts`, `.filecard[data-path]`, live bubble `.msg.assistant.streaming > .bubble`.

- [ ] **Step 1: Failing check — mock E2E against new render**

Run: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/pre-render.png`
Expected: FAIL or wrong shapes (assistant shows `.who` avatar rows, tool output as `.msg.tool` pre-block, no separators/timestamps).

- [ ] **Step 2: Minimal render changes**

`elFor`: user → same; assistant → drop `.who` row, plain `.bubble.md`, append `<span class="ts">` with `new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})`; tool → `<div class="activity">` line only (`▸ run_command · exit N`), full output moves to Task 4's card (keep `pre` hidden until then — do NOT delete data path). `renderMsg`: insert `<div class="turn-sep">✳</div>` before assistant nodes when a `.msg` already exists. Live bubble: same shape minus `.who`. `updateChip` writes `model-label` (`mock model` or model name). Suggestions: same `data-fill` wiring (new hero markup). File mentions matching `/mnt/user-data/outputs/\S+` in assistant text get a `.filecard` (icon, name, Open → `previewFile`). Keep `fusebox.chat` schema untouched.

- [ ] **Step 3: Mock E2E green + conversation screenshot reviewed**

Run: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat-mock.png`
Expected: `==> CHAT E2E: ALL PASS`.
Read `/tmp/console-chat-mock.png`: bubbles right, assistant serif, separators, activity lines — iterate until yes.

- [ ] **Step 4: Commit**

```bash
git add console/chat.js
git commit -m "feat(console): Claude conversation rendering, separators, file cards"
```

### Task 4: Ran-a-command collapsible live card

**Files:**
- Modify: `console/chat.js` (`agentLoop` tool block, `runCommand` live hook)

**Interfaces:**
- Consumes: `.toolcard` classes from Task 2, `runCommand(command): Promise<{output, rc}>` (unchanged signature).
- Produces: card element API used by Task 6 screenshots: `.toolcard > .toolcard-head` (click toggles `.collapsed`), `.toolcard-body > .toolcard-cmd + .toolcard-out`.

- [ ] **Step 1: Failing check — SSE E2E shows no command card**

Run: `FAKE_LLM_URL=http://127.0.0.1:8079/v1 node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/pre-card.png`
Expected: loop passes but transcript has no `.toolcard` (only `.activity` lines).

- [ ] **Step 2: Minimal card implementation**

Replace the `toolEl` block in `agentLoop` with:

```js
const toolEl = document.createElement("div");
toolEl.className = "toolcard";
toolEl.innerHTML = `<button class="toolcard-head" type="button"><span>Ran a command</span><span class="chev">⌄</span></button>
  <div class="toolcard-body"><div class="toolcard-lang">bash</div><pre class="toolcard-cmd"></pre>
  <div class="toolcard-out-label">Output</div><pre class="toolcard-out"><span class="thinking"><i></i><i></i><i></i></span></pre></div>`;
toolEl.querySelector(".toolcard-cmd").textContent = command;
const outPre = toolEl.querySelector(".toolcard-out");
toolEl.querySelector(".toolcard-head").addEventListener("click", () => toolEl.classList.toggle("collapsed"));
```

Live append: extend `runCommand`'s `sub` callback — add optional `onChunk` param; agentLoop passes `(t) => { outPre.textContent += t; outPre.scrollTop = outPre.scrollHeight; }`. On `finish`, set `outPre.textContent = output || "(no output)"`, append ` · exit ${rc}` to the head span, add `.collapsed`. Keep the hidden `.msg.tool` persist path from Task 3 (transcript compatibility) — render function stays, element hidden via CSS.

- [ ] **Step 3: SSE E2E green + card screenshots reviewed**

Run: `FAKE_LLM_URL=http://127.0.0.1:8079/v1 node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/console-chat-stream.png`
Expected: ALL PASS with `sse rounds ≥ 2`.
Read the PNG: expanded-then-collapsed cards, command tint, output section — iterate until yes.

- [ ] **Step 4: Commit**

```bash
git add console/chat.js
git commit -m "feat(console): collapsible Ran-a-command live cards"
```

### Task 5: Chat-history sidebar (localStorage store)

**Files:**
- Modify: `console/chat.js` (store + sidebar render + new/switch/delete), `console/index.html` (sidebar already in skeleton — no change expected)

**Interfaces:**
- Consumes: `#chatlist`, `#newchat-side`, `#newchat`, `#chattitle` from Task 1.
- Produces: `fusebox.chats` schema `{active: string, chats: [{id, title, updated, messages[]}]}`; migration import of legacy `fusebox.chat`. Task 7 tests switching.

- [ ] **Step 1: Failing check — sidebar empty, no switching**

CDP eval (via a scratch `node -e` CDP snippet or browser console): `document.querySelectorAll("#chatlist li").length === 0` after sending two chats. Confirm: no persistence across `newchat`.

- [ ] **Step 2: Minimal store**

```js
function loadChats() {
  try {
    const s = JSON.parse(localStorage.getItem("fusebox.chats") ?? "null");
    if (s && Array.isArray(s.chats)) return s;
  } catch {}
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem("fusebox.chat") ?? "[]"); } catch {}
  const c = { active: "c1", chats: [{ id: "c1", title: "New conversation", updated: Date.now(), messages: legacy }] };
  localStorage.setItem("fusebox.chats", JSON.stringify(c));
  return c;
}
```

`messages` getter/setter proxy to the active chat; `persist()` writes the whole store (cap 50 chats, 200 msgs each); title = first user message sliced to 32 chars; render list with active class + ✕ delete (keep ≥1 chat); `#newchat` + `#newchat-side` create + switch; `#chattitle` shows active title; sidebar collapse toggles `body.sidebar-collapsed`. Existing `fusebox.chat` readers (e2e never reads it) keep working via migration.

- [ ] **Step 3: Switching verified + mock E2E still green**

CDP/eval check: new chat → send `hello sidebar` → new chat → list shows 2 entries → click first → transcript contains it → delete second → 1 remains. Then run mock E2E (fresh profile path — migration creates the single chat):

Run: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/chat-side.png`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add console/chat.js
git commit -m "feat(console): chat-history sidebar, localStorage store"
```

### Task 6: app.js rewiring (pill, panel, menus, uploads) + smoke green

**Files:**
- Modify: `console/app.js` (selectors for moved ids, `plus-menu` toggle, sidebar-collapse, `conn-pill` via existing `setStatus`, panel tab classes)

**Interfaces:**
- Consumes: all Task 1 ids; `window.Chat.previewFile`, `window.__mdRender` unchanged.
- Produces: working header/panel/sidebar wiring; `sessions` poll, `?ws=` override, upload/dropzone, preview delegation all intact for Task 7 verification.

- [ ] **Step 1: Failing check — smoke + console errors on boot**

Run: `node console/test/smoke.mjs ws://127.0.0.1:12400`
Expected: failures/errors (`drawer-terminal`/`modelchip`/`dot` selectors moved or renamed; `plus-btn`/`plus-menu` unbound).

- [ ] **Step 2: Minimal rewiring**

Update `$()` bindings to the new skeleton (`conn-pill` children keep `dot`/`status` ids so `setStatus` is untouched; header buttons keep `drawer-terminal`/`drawer-files`/`newchat`/`settingsbtn` ids so handlers are untouched). Add: `plus-btn` toggles `plus-menu`, `attach` unchanged inside menu; `sidebar-collapse` toggles `body.sidebar-collapsed`; `chattitle` click focuses sidebar. Keep: `?ws=` override, `filesdir` persist, `refreshFiles`, `uploadFiles`, `openDrawer/toggleDrawer` (add artifact-card class only), `pollSessions`, `term` theme, `ConsoleAPI` surface byte-identical.

- [ ] **Step 3: Smoke 15/15 + panel screenshot reviewed**

Run: `node console/test/smoke.mjs ws://127.0.0.1:12400`
Expected: `15/15 PASS`.
Run: `node console/test/screenshot.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/shot-panel.png 4000`
Expected: reviewed — artifact-styled terminal/files panel, tabs, toolbar intact.

- [ ] **Step 4: Commit**

```bash
git add console/app.js
git commit -m "feat(console): rewire header, panel, menus to new skeleton"
```

### Task 7: Narrow-width pass + full verification + README + commit

**Files:**
- Modify: `console/style.css` (only `@media` block + chip row), `console/README.md`
- Test: existing suites + new screenshots (no new files)

**Interfaces:**
- Consumes: everything above.
- Produces: shippable `master` — all suites green, screenshots reviewed at both widths.

- [ ] **Step 1: Failing check — 390px screenshot broken**

Run (CDP width override — `screenshot.mjs` uses 1440x860; pass narrow via a one-off `--window-size=390,844` chrome flag edit in a scratch copy, or devtools emulation): capture `/tmp/shot-narrow.png`.
Expected: composer row overflows, file cards clip, sidebar crowds content.

- [ ] **Step 2: Minimal `@media (max-width:560px)` fix**

Chip row: `.filecard-row { display:flex; overflow-x:auto; scroll-snap-type:x proximity; }`. Composer: hide `.seg` and `#model-label` (already in menu/header). Sidebar: `position:fixed; transform:translateX(-100%)` + `body.sidebar-open` overlay when toggled. Topbar: icon-only (hide `#chattitle` text, `#sessions`). Command card keeps width, `.toolcard-out` internal scroll.

- [ ] **Step 3: Full verification**

Run: `node --check console/chat.js && node --check console/app.js && node console/test/dom-contract.mjs`
Expected: PASS.
Run: mock E2E, SSE E2E, smoke (commands from Global Constraints).
Expected: ALL PASS / 15/15.
Shots at 1440 + 390 (empty, conversation with card open + collapsed, panel open, sidebar open) — all six reviewed against the five `~/Pictures/screenshot-2026-09-23_*.png` references.

- [ ] **Step 4: README + final commit**

README: new layout paragraph (sidebar, command cards, narrow behavior), keep proxy/settings docs. Then:

```bash
git add -A && git status --short && git commit -m "feat(console): Claude-clone rebuild (option B)

- fresh index.html skeleton: sidebar, slim topbar, centered column,
  composer card, artifact panel; DOM contract test pins e2e ids
- style.css: warm-black tokens, CSS arch-glow texture, Lora serif,
  responsive narrow pass
- chat.js: plain-serif turns, separators, timestamps, file cards,
  collapsible live Ran-a-command cards, localStorage chat history
- app.js rewired to new skeleton; protocol logic untouched
- verified: mock + SSE e2e ALL PASS, smoke 15/15, shots reviewed"
```

## Self-Review

**1. Spec coverage:** §1 skeleton → Task 1 (+§9 sidebar markup). §2 tokens → Task 2. §3 empty state → Tasks 1–2. §4 composer → Tasks 1–2 + 6 (`plus-menu`, `model-label`). §5 conversation → Task 3. §5b command cards → Task 4. §6 panel → Tasks 1 + 6. §7 verification → Task 7 (all suites + six shots + README + commit). §8 narrow → Task 7 (also base rules in Task 2). §9 sidebar → Task 5 (+Task 7 switching test). No gaps.

**2. Placeholder scan:** no TBD/TODO; every struggling step names exact files, ids, commands, and expected outputs. `node -e` CDP snippets are described as scratch (operator's existing drivers cover them).

**3. Type consistency:** ids introduced in Task 1 (`sidebar`, `chatlist`, `composer-card`, `model-label`, `plus-btn`, `plus-menu`, `conn-pill`, `chattitle`, `newchat-side`) match Tasks 2–6 usage. Classes (`.toolcard`, `.turn-sep`, `.filecard`, `.activity`, `.hero`) match. `runCommand(command)` signature unchanged; `onChunk` is an added optional param, default no-op. `fusebox.chats` schema defined once in Task 5.
