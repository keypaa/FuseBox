# FuseConsole UI Overhaul + Server-Side Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FuseConsole feel like Claude (message layout, inline tool flow, minimal sidebar, simple composer footer, Claude-shaped error cards) and move the OpenRouter key into `console/.env` behind a same-origin `server.py`, locked to the single free model with no `max_tokens` cap.

**Architecture:** Keep the proven agent loop, SSE delta-merge, `runCommand` scrubber, and storage shapes byte-for-byte; change only rendering (CSS + small DOM edits), add `console/server.py` (static with `Cache-Control: no-cache` + `/api/chat` forwarder that injects the key from `.env`), and delete the fallback model chain.

**Tech Stack:** Vanilla JS (no build), Python 3 stdlib HTTP server, Node ≥22 test scripts, headless Chrome CDP tests.

## Global Constraints

- Single model only: `inclusionai/ling-3.1-flash` — NEVER call any other model; if evidence invalidates this id, STOP and ask the user.
- NEVER send `max_tokens`/`max_output_tokens` — the model uses its full default 262K context.
- The browser NEVER sees the API key — no key in localStorage, responses, logs, or UI; key lives only in gitignored `console/.env` as `OPENROUTER_API_KEY`.
- Preserve DOM ids `#chatcol .msg #chatin #send #connect #filesdir #filelist #sessions #status .js-dot .js-status` and `localStorage` shapes `fusebox.api {baseUrl,model,systemPrompt}` / `fusebox.history[] {id,title,ts,messages}` / `fusebox.chat`.
- Static serving keeps `Cache-Control: no-cache` so edits apply without cache-busting.
- Do NOT rewrite the SSE `tool_calls` fragment merge (`chat.js:320-356`), the `runCommand` scrubber (`chat.js:63-81`), or the abort backfill (`chat.js:643-652`).
- Absolute `baseUrl` values (e.g. `FAKE_LLM_URL=http://127.0.0.1:8079/v1`) keep working direct-from-browser so the existing SSE e2e exercises the real streaming path.

---

### Task 0: Green baseline (prove the harness before touching anything)

**Files:**
- Modify: none (read-only verification)

**Interfaces:**
- Consumes: supervisor + console servers per `console/README.md:79-97`
- Produces: baseline PASS/FAIL record for Tasks 1-6 to compare against

- [ ] **Step 1: Start the dev supervisor + console (two shells)**

```bash
(cd sandbox/process_api && ./target/x86_64-unknown-linux-musl/release/process_api --addr 127.0.0.1:12400 --control-server-addr 127.0.0.1:12401 &)
(cd console && ./serve.sh 8077 &)
```

- [ ] **Step 2: Run the wire-protocol smoke test**

Run: `node console/test/smoke.mjs ws://127.0.0.1:12400`
Expected: ends with `==> CONSOLE SMOKE: ALL PASS`, exit 0.

- [ ] **Step 3: Run the mock-model chat e2e**

Run: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/base-chat.png`
Expected: `==> CHAT E2E: ALL PASS`, exit 0.

- [ ] **Step 4: Run the SSE streaming-path e2e**

Run: `(cd console/test && rm -f /tmp/fusebox-sse-hit && ./sse-mock.py 8079 &) && FAKE_LLM_URL=http://127.0.0.1:8079/v1 node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/base-sse.png`
Expected: `==> CHAT E2E: ALL PASS` with `sse rounds: 2 (loop completed over SSE)`, exit 0.

- [ ] **Step 5: Record the baseline (no commit — no files changed)**

If any of Steps 2-4 fail, note WHICH check failed and its tail output; the most likely culprit is drift around `id="status"` (referenced by `console/app.js:5` and both e2e scripts but absent from `console/index.html`). Do NOT fix it here — record it and continue; Task 4 re-adds the footer area where a status element belongs.

---

### Task 1: Message layout — B-polished-minimal, no avatar/name

**Files:**
- Modify: `console/chat.js` (elFor `who` block, streaming placeholder)
- Modify: `console/style.css` (column width, assistant prose, drop `.who` rules)

**Interfaces:**
- Consumes: existing `md()` renderer, `renderMsg()`, `.thinking` dots (unchanged)
- Produces: assistant rows with no `.who` node; `.msg.assistant .bubble` serif styling consumed by Tasks 2 and 5

- [ ] **Step 1: Write the failing structural check**

Run: `rg -n 'class="who"|querySelector\("\.who|"who"' console/chat.js console/app.js`
Expected: FAIL (matches found — `chat.js` builds `.who` in `elFor` and in the streaming placeholder).

- [ ] **Step 2: Remove the `.who` header from assistant rendering**

In `console/chat.js`, replace:

```js
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = `<span class="avatar">✳</span><span class="name">assistant</span>`;
    const b = document.createElement("div");
```

with:

```js
    const b = document.createElement("div");
```

and replace `w.append(who, b);` with `w.append(b);`. In the streaming placeholder inside `agentLoop()`, replace:

```js
      live.innerHTML =
        `<div class="who"><span class="avatar">✳</span><span class="name">assistant</span></div>` +
        `<div class="bubble md"><span class="thinking"><i></i><i></i><i></i></span></div>`;
```

with:

```js
      live.innerHTML =
        `<div class="bubble md"><span class="thinking"><i></i><i></i><i></i></span></div>`;
```

- [ ] **Step 3: Restyle the column and assistant prose in `console/style.css`**

Replace `#chatcol { max-width: 760px;` with `#chatcol { max-width: 800px;`, replace:

```css
.msg.assistant .bubble { max-width: 100%; background: transparent; padding: 2px 4px; }
```

with:

```css
.msg.assistant .bubble { max-width: 100%; background: transparent; padding: 2px 4px; font-family: var(--serif); font-size: 16.5px; line-height: 1.65; }
.msg.assistant .bubble .md code, .msg.assistant .bubble pre, .msg.assistant .bubble code { font-family: var(--mono); }
```

and delete the `.msg .who` / `.msg .who .avatar` rules (now dead CSS). Keep `.thinking` dots and `.cursor` exactly as-is.

- [ ] **Step 4: Verify the structural check now passes and e2e stays green**

Run: `rg -n '"who"|\\.who' console/chat.js`
Expected: PASS (no output). Then re-run Task 0 Steps 3-4 (mock + SSE e2e).
Expected: both `ALL PASS`.

- [ ] **Step 5: Screenshot and eyeball against the Claude reference**

Run: `node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/t1-chat.png`
Expected: exit 0; open `/tmp/t1-chat.png` — user bubble right-aligned, assistant prose with no avatar/name row, dots animation visible only while streaming.

- [ ] **Step 6: Commit**

```bash
git add console/chat.js console/style.css
git commit -m "feat(console): minimal message rows, serif assistant prose, no avatar/name"
```

---

### Task 2: Tool visibility — grouped inline flow, Claude-faithful

**Files:**
- Modify: `console/chat.js` (`toolCard`, agentLoop group header, skip tool-only intent bubble, `relTime` helper use)
- Modify: `console/app.js` (add shared global `relTime(ts)`)
- Modify: `console/style.css` (`.tool-group`, card polish, footer row)

**Interfaces:**
- Consumes: `toolCard()` return `{el,outPre,rcEl}`; `setToolRunning/setToolDone/setToolError` (signatures unchanged)
- Produces: `window.relTime(ts)` global consumed by Tasks 3 and 5; `.tool-group` DOM consumed by styling only

- [ ] **Step 1: Add the shared relative-time helper (failing check first)**

Run: `rg -n 'relTime' console/app.js console/chat.js`
Expected: FAIL (no matches). Then append to `console/app.js` (top-level, above the ConsoleAPI block so both classic scripts share it):

```js
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
window.relTime = relTime;
```

Re-run the `rg` check. Expected: PASS (matches in `app.js`).

- [ ] **Step 2: Group tool cards under a collapsible summary line**

In `console/chat.js` `agentLoop()`, directly before `for (const call of toolCalls) {`, insert:

```js
      const group = document.createElement("div");
      group.className = "tool-group";
      const groupLabel = document.createElement("span");
      groupLabel.className = "tg-label";
      group.appendChild(groupLabel);
      chatcol.appendChild(group);
      const paintGroup = (n) => { groupLabel.textContent = n === 1 ? "Ran a command" : `Ran ${n} commands`; };
      paintGroup(toolCalls.length);
      group.addEventListener("click", () => group.classList.toggle("collapsed"));
      const cards = [];
      let done = 0;
```

Inside the loop, after `chatcol.appendChild(card.el);`, insert:

```js
        cards.push(card.el);
        if (done === 0) card.el.classList.add("open");
```

and after `setToolDone`/`setToolError` (still inside the loop, after `scrollBottom();` at the end of the iteration), insert:

```js
        done++;
        card.footTime.textContent = window.relTime ? window.relTime(Date.now()) : "just now";
```

Then change `renderMsg(reply);` (the one right before the tool loop, for the tool-call round) to render nothing when the reply has no prose:

```js
      if (toolCalls.length && !(typeof reply.content === "string" && reply.content.trim())) {
        // pure tool-call round: the group header below stands in for it
      } else {
        renderMsg(reply);
      }
```

(Note: `messages.push(reply)` and `persist()` stay exactly where they are — only the DOM render is skipped.)

- [ ] **Step 3: Extend `toolCard()` with Output label, copy button, footer**

In `toolCard()`'s template, replace:

```js
      <div class="tc-body">
        <div class="tc-args"><pre>${esc(JSON.stringify(args, null, 2))}</pre></div>
        <div class="tc-out"><pre></pre></div>
        <div class="tc-rc"></div>
      </div>`;
```

with:

```js
      <div class="tc-body">
        <div class="tc-args"><pre>${esc(JSON.stringify(args, null, 2))}</pre></div>
        <div class="tc-out-label">Output</div>
        <div class="tc-out"><pre></pre></div>
        <div class="tc-foot"><span class="tc-rc"></span><span class="tc-act"><button type="button" class="tc-copy">copy</button><span class="tc-time"></span></span></div>
      </div>`;
```

and update the return to expose the new nodes:

```js
    return { el, outPre: el.querySelector(".tc-out pre"), rcEl: el.querySelector(".tc-rc"), footTime: el.querySelector(".tc-time") };
```

Wire the copy button right after building `el`:

```js
    el.querySelector(".tc-copy").addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigator.clipboard?.writeText(el.querySelector(".tc-out pre").textContent ?? "").catch(() => {});
    });
```

`setToolRunning/setToolDone/setToolError` keep writing to `card.rcEl` — no signature change, so existing call sites work untouched.

- [ ] **Step 4: Style the group + card in `console/style.css`**

Append:

```css
.tool-group { margin: 10px 0 2px; color: var(--fg-2); font-size: 13px; cursor: pointer; user-select: none; }
.tool-group .tg-label::after { content: " ⌄"; font-size: 11px; }
.tool-group.collapsed .tg-label::after { content: " ›"; }
.tool-group.collapsed ~ .tool-card { display: none; }
.tool-card .tc-out-label { padding: 8px 12px 0; font-size: 11px; color: var(--fg-2); font-family: var(--sans); }
.tool-card .tc-foot { display: flex; align-items: center; padding: 6px 12px 9px; font-size: 11px; color: var(--fg-2); }
.tool-card .tc-foot .tc-act { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.tool-card .tc-copy { background: transparent; border: 1px solid var(--line-1); color: var(--fg-2); font-size: 11px; padding: 2px 8px; }
.tool-card .tc-copy:hover { color: var(--fg-0); border-color: var(--coral); }
```

(Note: the sibling selector hides cards while collapsed because cards are appended right after the group div in document order.)

- [ ] **Step 5: Run the streaming-fragmentation e2e (merge logic must be untouched)**

Run: `(cd console/test && ./sse-mock.py 8079 &) && FAKE_LLM_URL=http://127.0.0.1:8079/v1 node console/test/chat-e2e.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/t2-sse.png`
Expected: `ALL PASS` + `sse rounds: 2 (loop completed over SSE)`. Then mock e2e, expected `ALL PASS`.

- [ ] **Step 6: Screenshot and commit**

Open `/tmp/t2-sse.png`: expect `Ran a command ⌄`-style group line, expanded bash card with `Output` label, copy + time footer, no `▸ run_command…` intent bubble.

```bash
git add console/chat.js console/app.js console/style.css
git commit -m "feat(console): grouped inline tool flow with copy + relative time"
```

---

### Task 3: Sidebar — minimal flat list, smart titles, search, rename/delete

**Files:**
- Create: `console/test/sidebar-check.mjs`
- Modify: `console/chat.js` (title dedupe helper, `deleteConversation`, `renameConversation` in the return object)
- Modify: `console/app.js` (`renderHistory` rewrite: times, filter, ⋯ menu)
- Modify: `console/index.html` (search input above `#history`)
- Modify: `console/style.css` (search + row + menu styles)

**Interfaces:**
- Consumes: `window.relTime(ts)` from Task 2; `Chat.getHistory/getCurrentId/loadConversation/newChat` (unchanged)
- Produces: `Chat.deleteConversation(id)`, `Chat.renameConversation(id,title)`, `window.__dedupeTitles(list)` consumed by `renderHistory`

- [ ] **Step 1: Write the failing sidebar check**

Create `console/test/sidebar-check.mjs` (CDP script modeled on `chat-e2e.mjs:24-76` for browser boot + `evalJs`): it seeds `localStorage fusebox.history` with three entries titled `hey, hey, List sandbox outputs` (all with `messages: []`), navigates to the console URL from `process.argv[2]`, and asserts the rendered `#history .history-item .hi-text` values equal `["hey", "hey · 2", "List sandbox outputs"]`. Run:

Run: `node console/test/sidebar-check.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400"`
Expected: FAIL (second row renders bare `hey` — no dedupe suffix yet).

- [ ] **Step 2: Add title dedupe + conversation mutators to `console/chat.js`**

Add above the history section:

```js
  function dedupeTitles(list) {
    const seen = new Map();
    return list.map((h) => {
      const base = (h.title || "(new conversation)").slice(0, 50);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { ...h, title: n > 1 ? `${base} · ${n}` : base };
    });
  }
  window.__dedupeTitles = dedupeTitles;
```

and extend the returned object with:

```js
    deleteConversation: (id) => {
      history = history.filter((x) => x.id !== id);
      if (currentId === id) { messages = []; currentId = null; rerenderAll(); }
      saveHistory();
      if (window.renderHistory) window.renderHistory();
    },
    renameConversation: (id, title) => {
      const h = history.find((x) => x.id === id);
      if (h) { h.title = (title || h.title).slice(0, 50); saveHistory(); }
      if (window.renderHistory) window.renderHistory();
    },
```

- [ ] **Step 3: Rewrite `renderHistory` in `console/app.js` + search input in `index.html`**

In `console/index.html`, above `<div id="history" class="history"></div>`, insert:

```html
  <input id="hsearch" class="hsearch" placeholder="Search chats…" autocomplete="off">
```

In `console/app.js`, replace the body of `renderHistory()` (keep its name and call sites) with a version that: reads `window.__dedupeTitles ? window.__dedupeTitles(list) : list`, filters rows by `$("hsearch").value` (case-insensitive substring), renders each row as `<span class="hi-dot"></span><span class="hi-text"></span><span class="hi-time"></span><button class="hi-menu">⋯</button>` where `.hi-time` uses `window.relTime(h.ts)`, and wires `.hi-menu` to a small inline menu with Rename (uses `prompt("Rename conversation", h.title)`) and Delete (calls `window.Chat.deleteConversation(h.id)`). Also add `$("hsearch").addEventListener("input", renderHistory);` next to the other wiring, and expose `window.renderHistory = renderHistory;` for Chat to call.

- [ ] **Step 4: Style rows in `console/style.css`**

Append:

```css
.hsearch { margin: 8px 8px 2px; width: calc(100% - 16px); background: var(--bg-0); color: var(--fg-0); border: 1px solid var(--line-0); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; }
.hsearch:focus { outline: none; border-color: var(--coral); }
.hsearch::placeholder { color: var(--fg-2); }
.history-item .hi-time { margin-left: auto; font-size: 11px; color: var(--fg-2); flex: none; }
.history-item .hi-menu { display: none; background: transparent; border: none; color: var(--fg-2); font-size: 13px; padding: 0 2px; }
.history-item:hover .hi-menu { display: inline; }
.history-item .hi-menu:hover { color: var(--fg-0); }
```

- [ ] **Step 5: Run the sidebar check + full e2e**

Run: `node console/test/sidebar-check.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400"`
Expected: PASS (rows `hey`, `hey · 2`, `List sandbox outputs`). Then mock e2e, expected `ALL PASS` (throwaway profile renders `no conversations yet`).

- [ ] **Step 6: Screenshot and commit**

Run: `node console/test/screenshot.mjs "http://127.0.0.1:8077/?ws=ws://127.0.0.1:12400" /tmp/t3-side.png`
Expected: exit 0; sidebar shows search box + flat rows with inline times.

```bash
git add console/chat.js console/app.js console/index.html console/style.css console/test/sidebar-check.mjs
git commit -m "feat(console): minimal sidebar with smart titles, search, rename/delete"
```

---

### Task 4: Composer footer — Claude-simple, drop the pill

**Files:**
- Modify: `console/index.html` (composer footer replaces `#modelchip` pill; settings modal drops key field; add a `#status` element)
- Modify: `console/chat.js` (`updateChip` → footer text, `modelfoot` opens settings, settings save without key)
- Modify: `console/style.css` (footer styles)

**Interfaces:**
- Consumes: `settings.model` (unchanged); `openSettings` flow (same modal, fewer fields)
- Produces: `#modelfoot` button + `#status` element consumed by e2e/screenshot scripts that already query them

- [ ] **Step 1: Write the failing check**

Run: `rg -n 'modelchip|set-key' console/index.html console/chat.js`
Expected: FAIL (matches found — pill + key field still present).

- [ ] **Step 2: Rework the composer + settings markup in `console/index.html`**

Replace:

```html
      <div class="composer-row">
        <button id="attach" class="icon-btn" title="upload a file into /mnt/user-data/uploads">+</button>
        <span class="spacer"></span>
        <button id="modelchip" class="chip" title="model settings">⚙ model</button>
        <button id="send" class="send" title="send (Enter)">➤</button>
      </div>
    </div>
    <div class="composer-note">model output executes inside the FuseBox microVM · Enter sends, Shift+Enter = newline</div>
```

with:

```html
      <div class="composer-row">
        <button id="attach" class="icon-btn" title="upload a file into /mnt/user-data/uploads">+</button>
        <span class="flex-spacer"></span>
        <button id="send" class="send" title="send (Enter)">➤</button>
      </div>
    </div>
    <div class="composer-foot"><span class="composer-note">Model output executes inside the FuseBox microVM · Enter sends, Shift+Enter = newline</span><button id="modelfoot" class="modelfoot" title="model settings">ling-3.1-flash</button></div>
```

Replace the API-key label block:

```html
    <label>API key
      <input id="set-key" type="password" placeholder="ollama key / sk-…   (stored in this browser only)">
    </label>
```

with:

```html
    <p class="key-note">API key: server (<code>console/.env</code> → <code>OPENROUTER_API_KEY</code>) — never in this browser.</p>
```

(This is forward-compatible with Task 6; until `server.py` lands, the note is informational and direct-key users keep working via absolute `baseUrl` + localStorage key fallback.)

- [ ] **Step 3: Rewire `console/chat.js` to the footer**

Replace `updateChip()` with:

```js
  function updateChip() {
    const short = (settings.model || "").split("/").pop() || "model";
    const foot = $("modelfoot");
    if (foot) foot.textContent = short;
  }
```

Replace the `$("modelchip").addEventListener("click", openSettings);` line with `$("modelfoot").addEventListener("click", openSettings);`. In `openSettings()`, delete the `$("set-key").value = settings.key;` line. In the `set-save` handler, delete the `settings.key = $("set-key").value.trim();` line (keep `settings.key` in the stored object for backward compatibility with absolute-baseUrl direct mode, but never render an input for it).

- [ ] **Step 4: Style the footer in `console/style.css`**

Append:

```css
.composer-foot { width: min(800px, 100%); display: flex; align-items: baseline; gap: 10px; }
.composer-foot .composer-note { flex: 1; text-align: left; font-size: 11.5px; color: var(--fg-2); }
.modelfoot { background: transparent; border: none; color: var(--fg-2); font-size: 12px; padding: 2px 4px; }
.modelfoot:hover { color: var(--fg-0); }
.key-note { font-size: 12.5px; color: var(--fg-2); }
.key-note code { font-family: var(--mono); color: var(--fg-1); }
```

Also widen `.composer` from `min(760px, 100%)` to `min(800px, 100%)` to match the new column.

- [ ] **Step 5: Verify + e2e + screenshot**

Re-run the Step 1 `rg` check. Expected: PASS (no output). Run mock + SSE e2e, expected both `ALL PASS`. Screenshot to `/tmp/t4-composer.png`: footer line with left note + right short model id, no pill.

- [ ] **Step 6: Commit**

```bash
git add console/index.html console/chat.js console/style.css
git commit -m "feat(console): Claude-simple composer footer, drop model pill and key field"
```

---

### Task 5: Error cards — Claude shape with Go back / Try again

**Files:**
- Create: `console/test/error-check.mjs`
- Modify: `console/chat.js` (`sendMessage` catch renders card; `goBack`/`retryTurn` handlers)
- Modify: `console/style.css` (amber card styles)

**Interfaces:**
- Consumes: `window.relTime(ts)` (Task 2); `agentLoop()`, `setBusy()`, `messages`, `persist()` (unchanged)
- Produces: `.err-card` DOM with `[data-act="back"]` / `[data-act="retry"]` buttons

- [ ] **Step 1: Write the failing error-path check**

Create `console/test/error-check.mjs` (CDP boot + `evalJs` like `chat-e2e.mjs:24-76`, but NO supervisor needed): it seeds `localStorage fusebox.api` with `{baseUrl: "http://127.0.0.1:9/v1", key: "", model: "dead-end"}`, navigates to the console URL from `process.argv[2]`, types `hello` into `#chatin`, clicks `#send`, waits up to 15s, and asserts `#chatcol .err-card` exists with both `Try again` and `Go back` buttons. Run:

Run: `node console/test/error-check.mjs "http://127.0.0.1:8077/"`
Expected: FAIL (no `.err-card` — errors still surface as toasts).

- [ ] **Step 2: Render failed turns as error cards in `console/chat.js`**

Add before the sending section:

```js
  function errTitle(e) {
    const m = String(e?.message ?? e);
    if (/401|no API key|unauthorized/i.test(m)) return "API Error: Unauthorized — check the server key";
    if (/402|credits|afford|max_tokens/i.test(m)) return "Model request failed — the provider refused the request";
    if (/failed to fetch|network|connect/i.test(m)) return "API Error: Connection refused — the model endpoint is unreachable";
    return `API Error: ${m.slice(0, 120)}`;
  }

  function renderError(e) {
    emptystate.hidden = true;
    const el = document.createElement("div");
    el.className = "msg err-card";
    const t = Date.now();
    el.innerHTML =
      `<div class="err-title"></div>` +
      `<div class="err-meta"><button type="button" class="err-copy" title="copy error">⧉</button><span class="err-time">${window.relTime ? window.relTime(t) : "just now"}</span></div>` +
      `<div class="err-box"><div class="err-head">⚠ Something went wrong</div>` +
      `<div class="err-sub">Try sending your message again. If it keeps failing, check the error details for the cause.</div>` +
      `<div class="err-detail"></div>` +
      `<div class="err-sub">You can restart the conversation from an earlier message.</div>` +
      `<div class="err-actions"><button type="button" data-act="back">↩ Go back</button><button type="button" data-act="retry">↻ Try again</button></div></div>`;
    el.querySelector(".err-title").textContent = errTitle(e);
    el.querySelector(".err-detail").textContent = String(e?.message ?? e).slice(0, 600);
    el.querySelector(".err-copy").addEventListener("click", () => {
      navigator.clipboard?.writeText(String(e?.message ?? e)).catch(() => {});
    });
    el.querySelector('[data-act="back"]').addEventListener("click", () => {
      const i = messages.findLastIndex((m) => m.role === "user");
      if (i >= 0) { chatin.value = messages[i].content; messages.splice(i, 1); }
      el.remove();
      persist();
      autosize();
      chatin.focus();
    });
    el.querySelector('[data-act="retry"]').addEventListener("click", () => {
      el.remove();
      if (generating) return;
      abortFlag = false;
      setBusy(true);
      agentLoop().catch((err) => renderError(err)).finally(() => { setBusy(false); saveConv(); });
    });
    chatcol.appendChild(el);
    scrollBottom();
  }
```

In `sendMessage()`'s catch, replace `toast(`model error: ${e.message ?? e}`, "err", 6000);` with a model-named card render:

```js
      else { renderError(new Error(`[${settings.model}] ${e.message ?? e}`)); }
```

(keeping the existing `AbortError → notice("[stopped]")` branch and the tool backfill above it untouched). Keep `toast()` for transient events (uploads, stopping) — it stays for those call sites.

- [ ] **Step 3: Style the card in `console/style.css`**

Append:

```css
.msg.err-card { gap: 4px; }
.err-title { font-family: var(--serif); font-size: 16px; color: var(--fg-0); }
.err-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-2); }
.err-copy { background: transparent; border: none; color: var(--fg-2); font-size: 13px; padding: 0 2px; }
.err-copy:hover { color: var(--fg-0); }
.err-box { background: #2a1f0d; border: 1px solid rgba(235,203,139,.4); border-radius: 12px; padding: 14px 16px; max-width: 560px; }
.err-head { color: var(--warn); font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.err-sub { color: #e8dcc2; font-size: 13.5px; line-height: 1.55; margin-bottom: 8px; }
.err-detail { font-family: var(--mono); font-size: 12px; color: #d8cba6; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.err-actions { display: flex; gap: 8px; margin-top: 4px; }
.err-actions button { background: rgba(235,203,139,.12); border: 1px solid rgba(235,203,139,.35); color: #f0e2c0; padding: 6px 14px; font-size: 13px; }
.err-actions button:hover { background: rgba(235,203,139,.22); }
```

- [ ] **Step 4: Run the error check + regression e2e**

Run: `node console/test/error-check.mjs "http://127.0.0.1:8077/"`
Expected: PASS (card with both buttons; clicking `Try again` re-renders a fresh card since the endpoint is still dead). Then mock e2e, expected `ALL PASS` (happy path untouched).

- [ ] **Step 5: Screenshot and commit**

Screenshot the dead-endpoint page to `/tmp/t5-error.png`: plain serif title, copy + `just now` meta, amber card with both buttons.

```bash
git add console/chat.js console/style.css console/test/error-check.mjs
git commit -m "feat(console): Claude-shaped error cards with Go back and Try again"
```

---

### Task 6: `server.py` + `.env` key + single-model lockdown + 402 repro

**Files:**
- Create: `console/server.py`
- Create: `console/.env.example`
- Modify: `.gitignore` (add `console/.env`)
- Modify: `console/serve.sh` (exec `server.py` instead of `http.server`)
- Modify: `console/chat.js` (delete `FALLBACK_MODELS`, single-model `providerComplete`, same-origin `/api/chat` routing, model-named errors)
- Modify: `console/README.md` (model-settings section: server key + single model)

**Interfaces:**
- Consumes: `TOOLS_SCHEMA`, `settings.{baseUrl,model,systemPrompt}` (key no longer read from browser storage for same-origin mode)
- Produces: `GET /api/model → {model}`, `POST /api/chat` SSE stream; `server.py --upstream/--log-bodies/--env-file` flags

- [ ] **Step 1: Write the failing loopback check (no key needed)**

Run: `ls console/server.py console/.env.example`
Expected: FAIL (neither file exists).

- [ ] **Step 2: Create `console/server.py`**

Full file (stdlib only; static + API on one port; `--upstream` makes it testable against `sse-mock.py`):

```python
#!/usr/bin/env python3
"""FuseConsole server: static files (no-cache) + same-origin /api/chat.

The OpenRouter key lives ONLY here, read from console/.env
(OPENROUTER_API_KEY). The browser never sees it: POST /api/chat injects
`Authorization: Bearer <key>` server-side and streams the SSE reply through.
Single model only — the browser chooses the model id, this server forwards it
verbatim and never substitutes another.

Usage: ./server.py [port] [--upstream https://openrouter.ai/api/v1]
       [--env-file .env] [--log-bodies]
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
```

Implement ONE handler class subclassing `SimpleHTTPRequestHandler` for `GET` (serve files from the console dir, always adding `Cache-Control: no-cache`, routing `/api/model` to JSON) plus `do_POST` for `/api/chat` only (read body, parse JSON, inject `Authorization` from the env key unless the body targets a localhost `--upstream` used in tests, forward with `urllib` to `<upstream>/chat/completions` verbatim — NEVER adding `max_tokens` — and stream the reply back chunked exactly like `console/llm-proxy.py:79-90`, copying status + headers minus hop-by-hop ones per `console/llm-proxy.py:22-26`). `--log-bodies` logs only `{model, message_chars, tool_count}` plus `key_present: true/false` — never the key. Unknown paths → 404 JSON. Bind `127.0.0.1`.

- [ ] **Step 3: `.env` wiring + `serve.sh` + gitignore**

Create `console/.env.example`:

```env
# Paste your key here and copy this file to console/.env (never committed).
OPENROUTER_API_KEY=
```

Append `console/.env` to root `.gitignore`. Replace `console/serve.sh` body with:

```bash
#!/usr/bin/env bash
# Serve the console + same-origin /api/chat (key injected server-side from console/.env).
set -euo pipefail
PORT="${1:-8077}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> FuseBox console: http://localhost:${PORT}/  (Ctrl-C to stop)"
exec python3 "$DIR/server.py" "$PORT"
```

- [ ] **Step 4: Lock `console/chat.js` to the single model over same-origin**

Delete the `FALLBACK_MODELS` const and replace `providerComplete()` with a single-model version: resolve the endpoint as — `settings.baseUrl === "mock"` → `mockComplete`; absolute http(s) `baseUrl` → legacy direct POST (keeps `FAKE_LLM_URL` tests working, attaching `settings.key` only in that mode); otherwise (empty/default) → same-origin `fetch("/api/chat", …)` with NO `Authorization` header and NO `max_tokens` in the body (body keeps exactly `{model, messages, tools: TOOLS_SCHEMA, temperature: 0.4, stream}`).

Keep the `401 → open ⚙` hint but reword to server key: `"model endpoint unauthorized — check OPENROUTER_API_KEY in console/.env"`. The `set-save` handler from Task 4 stays keyless. Update `console/README.md` model section: key via `console/.env`, single model, no `max_tokens` (262K default).

- [ ] **Step 5: Loopback test against the fake SSE endpoint (proves injection + streaming, no real key)**

```bash
(cd console/test && ./sse-mock.py 8079 &)
(cd console && python3 server.py 8077 --upstream http://127.0.0.1:8079/v1 --log-bodies &)
sleep 1
curl -sN -X POST http://127.0.0.1:8077/api/chat -H 'Content-Type: application/json' \
  -d '{"model":"loopback-check","messages":[{"role":"user","content":"hi"}]}' | head -c 300
```

Expected: `data: {` SSE lines streaming back (proving forward + stream-through), and the server log shows `key_present: false` with NO key material. Then `curl -s http://127.0.0.1:8077/api/model` returns the configured model JSON, and `curl -sI http://127.0.0.1:8077/index.html | rg -i cache-control` shows `no-cache`.

- [ ] **Step 6: Full regression (mock + SSE e2e) then the 402 repro**

Kill the loopback servers, restart `server.py` normally (`./serve.sh 8077`), re-run Task 0 Steps 2-4 — all must stay `ALL PASS` (absolute-baseUrl paths bypass `/api/chat`, so UI refactors are what is really under test here). 402 repro (needs the user to have copied `.env.example` → `.env` with their key): restart with `--log-bodies`, send one real message, confirm the request goes to the single locked model with no `max_tokens`; check OpenRouter → Settings → Keys for a per-key spending limit if a 402 recurs. If any evidence invalidates the `inclusionai/ling-3.1-flash` id: STOP, do not try another model, report to the user.

- [ ] **Step 7: Commit**

```bash
git add console/server.py console/.env.example .gitignore console/serve.sh console/chat.js console/README.md
git commit -m "feat(console): server-side OpenRouter key, single-model lockdown, no max_tokens cap"
```

---

## Self-Review

**1. Spec coverage:** §1 layout → Task 1. §2 tool flow (+`relTime`, copy, group toggle) → Task 2. §3 minimal sidebar (titles, dedupe, search, rename/delete, times) → Task 3. §4 composer footer (drop pill, footer note + short id, key-note) → Task 4. §5 error cards (title/meta/amber box/Go back/Try again, model-named) → Task 5. §6 backend (server.py, .env, fallback deletion, no max_tokens, repro + stop-and-ask) → Task 6. Screenshots + smoke/mock/SSE gates each task. No gaps.

**2. Placeholder scan:** No TBD/TODO; every code step shows exact snippets; `server.py` gives handler semantics plus the `llm-proxy.py` line ranges for the relay pattern. Fixed one bogus import line inline before saving.

**3. Type consistency:** `toolCard()` return gains `footTime` in Task 2 Step 3 and is consumed the same way in Step 2's loop edit; `renderHistory`/`Chat.deleteConversation/renameConversation`/`window.__dedupeTitles` defined in Task 3 Steps 2-3 and used together; `window.relTime` defined Task 2, consumed Tasks 3/5; `/api/chat` body shape defined Task 6 Steps 2/4 identically. `errTitle`/`renderError` self-contained in Task 5.

## Execution Handoff

Plan complete and saved to `zenno/plans/2026-10-10-console-ui-overhaul-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session with checkpoints

Which approach?
