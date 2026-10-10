# FuseConsole UI overhaul + server-side key — design

Date: 2026-10-10 · Scope C (surgical overhaul) · Status: approved in brainstorm, pending spec review

## Goal
Keep the proven agent loop byte-for-byte; make the console feel like Claude:
right-aligned user bubbles, plain assistant prose, inline tool flow, minimal
sidebar, simple composer footer, Claude-shaped error cards — plus move the
OpenRouter key off the browser into `console/.env` and root-cause the 402
against the single locked model.

## Non-goals
- No light mode, no voice/mic, no multi-model picker, no sidebar date groups
  (deferred until it hurts), no markdown-renderer rewrite, no streaming-parser
  rewrite, no `runCommand` scrubber rewrite.

## §1 Message layout (approved: B-polished-minimal)
- Column widens 760px → 800px, row gap 26px → 20px, same warm-dark tokens.
- User rows: right-aligned compact bubbles (`--bg-3`, 14.5px sans,
  radius 14px with tight bottom-right corner). No avatar, no name, no time.
- Assistant rows: full-width plain prose, **no avatar/name header** (delete
  `.who` block from `elFor` + streaming placeholder). Body in Lora serif
  16.5px/1.65 like the Claude reference; code/mono elements unchanged.
- Thinking state keeps the 3-dot animation, refined: slightly larger dots,
  `toolcall-note` replaced by grouped tool summary (see §2). Streaming cursor
  stays.
- Timestamps live only in tool footers / error meta rows, never on messages.

## §2 Tool visibility (approved: A-inline-flow, Claude-faithful)
- Each assistant turn renders prose + inline tool flow as one unit.
- Collapsed group line (muted `--fg-2`, 13px): `Ran 2 commands ›`;
  expanded: `Ran a command ⌄`. Click toggles. First tool of a turn starts
  expanded; subsequent ones collapsed.
- Expanded card: header `bash` label (language per tool: bash for
  run_command, path for read/write/list/delete), command in green-tinted mono,
  `Output` label, result in light-gray mono on `#0d0b09`, max-height 360px
  scroll. Keep existing exit-code + elapsed badge, restyled quiet
  (`exit 0 · 0.4s`, `--ok`/`--danger`).
- Footer ghost row per turn: copy output, retry, plus relative time
  (`just now`, `5 days ago`). No `▸ run_command…` intent-spam bubbles.
- Implementation reuses `toolCard()` DOM; only CSS + summary-line grouping
  change. Parser/merge logic untouched.

## §3 Sidebar (approved: B-minimal flat)
- Flat list (no Today/Yesterday groups). Smart titles: first real user message
  trimmed to 50 chars; consecutive identical titles (`hey ×10`) get
  ` · 2`, ` · 3` suffixes instead of duplicating.
- Inline relative time right-aligned per row (`14:02`, `5d ago`), muted 11px.
- Top: `✎ New chat` + `⌘K` search filter (filters titles as you type).
- Hover reveals `⋯` with rename / delete. Delete confirms inline, clears
  `fusebox.chat` slice for that convo.
- Bottom keeps `⚙ Settings` + sessions chip (`3 sessions`). Storage shape
  `fusebox.history[] {id,title,ts,messages}` unchanged.

## §4 Composer + model footer (approved: Claude-simple)
- Composer: `+` (upload) left, `Write a message…` textarea, `➤` send right.
  Drop the mic/waveform icons and the `⚙ model` pill chip entirely.
- Footer line below composer, muted 11.5px, two ends: left =
  `Model output executes inside the FuseBox microVM · Enter sends, Shift+Enter = newline`;
  right = short model id `ling-3.1-flash` (click opens ⚙). No dot, no
  "server key" text, no pill.
- Send/stop button behavior unchanged (➤ / ■, Enter vs Shift+Enter, abort).

## §5 Error cards (approved: Claude shape, simplified)
- Failed turns render as an error row, never a 70vw JSON toast:
  1. Title line, plain 16px serif: mapped summary, e.g.
     `API Error: Connection refused — a firewall or proxy may be blocking it`.
  2. Meta row: copy icon + relative time (`just now`), muted.
  3. Amber card (`#2a1f0d` bg, `#ebcb8b` border/text on warm-dark):
     `⚠ Something went wrong` / `Try sending your message again. If it keeps
     failing, check the error details for the cause.` / mono detail line /
     `You can restart the conversation from an earlier message.` /
     `[↩ Go back] [↻ Try again]` buttons.
- `Go back` removes the failed turn; `Try again` resends the last user
  message through `agentLoop()`. Raw JSON lives only behind a collapsed
  `show technical details` line. Toasts remain for transient events only
  (upload done, stopping…).

## §6 Backend key + 402 root-cause (single model only)
- New `console/server.py` replaces `serve.sh`'s `python3 -m http.server`:
  static files with `Cache-Control: no-cache` (keep current no-cache-busting
  behavior), plus:
  - `GET /api/model` → `{model}` (no key ever sent to browser).
  - `POST /api/chat` → forwards to `https://openrouter.ai/api/v1/chat/completions`
    with `Authorization: Bearer $OPENROUTER_API_KEY` from `console/.env`,
    streams SSE bytes through (chunked, like `llm-proxy.py`).
- `console/.env` holds `OPENROUTER_API_KEY=…` (gitignored; add
  `console/.env.example` with empty key). ⚙ settings drops the key input —
  shows readonly `key: server (.env)`; keeps base URL (default same-origin),
  model (default `inclusionai/ling-3.1-flash`), system prompt, plus a small
  `Max tokens` number input (default 4096, range 1024–8192).
- Request: single model only — **delete `FALLBACK_MODELS`**, send explicit
  `max_tokens: 4096` + `temperature: 0.4` + unchanged `TOOLS_SCHEMA`.
- 402 repro (same model only, never another): `server.py --log-bodies`
  records redacted request size/token estimate to confirm the 65535 came from
  the missing `max_tokens` (OpenRouter defaulting to full window) vs account
  state. The model is free with 262k context per the user; if the slug turns
  out to need a `:free` suffix or anything else that invalidates the current
  model id, **stop and ask the user** before changing it.

## Data flow
Browser → `POST /api/chat` (same origin, no key) → `server.py` injects key
→ OpenRouter SSE → streamed back → existing `providerCompleteModel` delta
merge → existing tool loop (`run_command` PTY, file plane) → §1/§2/§5 render.
History persists to `fusebox.history` / `fusebox.chat` as today.

## Testing
- `node console/test/smoke.mjs` (WS + file plane, unaffected) must pass.
- `node console/test/chat-e2e.mjs` mock **and** `FAKE_LLM_URL` SSE variants
  must pass — DOM ids `#chatcol .msg #chatin #send #connect #filesdir
  #sessions #status` preserved; text assertions `mock.txt` /
  `Switch the provider` preserved.
- Chromium screenshot per slice (layout, tools, sidebar, errors, composer)
  via `console/test/screenshot.mjs`; user eyeballs against the Claude refs.
- No-cache header check + `.env` gitignore check.

## Slices (for the plan)
1. §1 layout CSS + `.who` removal. 2. §2 tool grouping + card CSS.
3. §3 sidebar titles/search/delete. 4. §4 composer footer.
5. §5 error cards + `Go back`/`Try again`. 6. `server.py` + `.env` + single-model
   `max_tokens` + 402 repro log. Each slice ends green on tests + screenshot.
