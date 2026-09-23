# FuseConsole Claude-clone redesign — design spec

Date: 2026-09-23 | Status: approved by user (all sections) | Approach: **B (full DOM rebuild)**

## Goal

Rebuild FuseConsole's UI as a full Claude-clone (per reference screenshots in
`~/Pictures/screenshot-2026-09-23_*.png`): calm dark empty-state, centered serif
conversation, collapsible `Ran a command` cards, artifact-styled Terminal/Files
panel, plus a chat-history sidebar. One focused session: fresh `index.html` +
`style.css`, adapted JS selectors, full verification before commit.

Non-goals: cloud sync, message search, pinning/rename, Cowork mode, backend
changes (PTY protocol 2024, Control API 2025, llm-proxy untouched).

## §1 Layout skeleton (new index.html)

```
body.app
├─ aside.sidebar (collapsible → icon strip)
│   ├─ New chat button
│   └─ ul.chatlist (auto-titles, active highlight, per-chat delete)
├─ div.main
│   ├─ header.topbar (slim: nav icons · chat-title dropdown · conn pill ·
│   │                  Terminal/Files toggles · New chat · ⚙ · ✕)
│   ├─ main.chatwrap
│   │   ├─ div.chatscroll > div.chatcol (hero | messages)
│   │   └─ section.composer-zone (composer card + disclaimer microcopy)
├─ aside.panel (Terminal|Files segmented tabs, artifact-card chrome)
├─ settings + preview modals, toasts, hidden upload input
```

Contract: every id touched by `test/*.mjs` keeps working — either preserved
(`chatcol`, `chatin`, `send`, `status`, `connect`, `sessions`, `filelist`,
`filesdir`, `.tab[data-tab]`, `#terminal .xterm`) or re-mapped with the test
updated in the same commit.

## §2 Visual tokens

- BG warm near-black `#1f1e1d`; pure-CSS radial arch-glow + faint silhouette
  (no image asset, offline-safe).
- Assistant/headline text: cream `#ece7df`, serif — self-hosted **Lora**
  (`console/fonts/`, already vendored), serif-stack fallback.
- UI chrome: quiet sans; user bubble `#2e2c2b`; cards `#262524`, border
  `#3b3835`; inline code dark-red pill + coral text.
- Accent coral `#d97757` (✳ mark, separators, active states) — already the
  favicon color, so the clone keeps a FuseBox root.
- Send: rust round `↑` button; thinking dots, streaming cursor, code copy
  buttons carry over from current UI.

## §3 Empty state

Coral ✳ + serif headline `You're in the sandbox!`, one-line subcopy
("Ask for anything — the model runs commands and reads/writes files inside
the microVM"), three low-chrome suggestion pills (reuse today's prompts:
explore mounts, save & run script, inspect machine). Composer centered below.

## §4 Composer card

Placeholder `Write a message…`. Bottom row: `+` (upload menu) · single `Chat`
segment (Cowork slot dropped — no such mode) · right-side model label
(e.g. `gemma4:31b`, click → settings modal) · rust `↑` send. Connection pill,
new chat, terminal/files live as slim header icons. Behavior unchanged:
Enter sends, Shift+Enter newline, abort mid-stream, autosize, file upload to
`/mnt/user-data/uploads`.

## §5 Conversation

- No avatars/names. Coral ✳ separators between turns; `Sep 16`-style
  timestamps with edit/copy affordances.
- User messages: right-aligned dark pills. Assistant: plain serif, generous
  line-height. Inline code → coral pills; fenced blocks → copy buttons.
- Quoted pending text, scroll-down `↓` pill, thinking dots → live markdown
  with cursor, then final render. Errors via toasts + `[model error]` notices.

## §5b Tool-call cards (`run_command`)

Each call renders a collapsible dark card: header `Ran a command ⌄/›`
(expanded while streaming, auto-collapses on completion, click toggles);
body has language label (`bash`), syntax-tinted command, divider, `Output`
section with exit code, scrollable past ~10 lines. Live deltas append into the
open card; the terminal drawer keeps mirroring raw PTY. File artifacts render
as file cards below (icon, name, kind, Open → preview modal).

## §6 Terminal / Files panel

Same PTY + Control-API wiring, restyled as Claude artifact panel: dark card,
title header with actions, `Terminal|Files` segmented tabs, toolbar
(connect, dir select, refresh, dropzone). Collapses to give the chat column
full document width.

## §8 Narrow widths

Column fluid `min(680px, 100% - 32px)`. Below ~560px: file cards → horizontal
snap-scroll chip row; command cards keep full width with internal scroll;
composer row condenses to `+` / input / `↑`; sidebar becomes overlay drawer;
topbar collapses to icons.

## §9 Chat sidebar

`New chat`, auto-titles from first user message, active highlight, per-chat
delete, collapsible to icon strip. `localStorage`-only persistence (offline /
keyless ethos, same as API key); settings stay global across chats.
Excluded: search, pinning, rename, sync.

## §7 Verification

1. `node --check` on touched JS + python AST check on mocks.
2. Mock-provider chat E2E — ALL PASS (regression).
3. `FAKE_LLM_URL` SSE E2E — loop completes over SSE (tool file via Control API).
4. `smoke.mjs` 15/15.
5. CDP screenshots at 1440px + 390px: empty state, conversation (incl.
   command card open/collapsed), panel open — each reviewed against the five
   reference PNGs; iterate until visually approved.
6. Sidebar switching test (new chat → send → switch → transcript + delete).
7. README touch-up + commit on clean tree.
