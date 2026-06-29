# Feature Inspiration Library

A deep catalog of feature patterns organized by project type. Use this when you want more specific creative fuel beyond the main ideation lenses.

---

## CLI Tools

- **Replay mode**: Record every command run and its context (cwd, env, time taken), replay any session interactively
- **Smart aliases**: Detect repeated command sequences and auto-suggest aliases or scripts to replace them
- **Diff-as-a-feature**: Before destructive operations, show a preview of exactly what will change
- **Audit log**: Every action stored locally with full context — searchable, exportable, reversible
- **Health check command**: Scan environment for misconfigurations, missing deps, drift from expected state
- **Interactive TUI mode**: Offer a `--interactive` flag that wraps the same logic in a full terminal UI
- **Config drift detection**: Compare current config to last-known-good, highlight what changed and when
- **Shell integration hooks**: Emit events the shell can subscribe to (completion %, errors, summaries)
- **Contextual --why flag**: Every command can explain the reasoning behind its decisions

---

## Web Apps

- **Session replay with intent**: Record not just clicks but inferred intent — "user was trying to find X"
- **Collaborative cursor**: Show where teammates are in the app in real time (even on static content)
- **Undo everything**: Full client-side undo stack that survives page refresh
- **Ambient presence**: Show "3 people have done this today" next to actions — social proof without social media
- **Keyboard shortcut discovery**: After 10 uses of a mouse action, surface the keyboard shortcut
- **Smart empty states**: Empty screens that suggest exactly what to do based on user's history
- **Friction heatmap**: Highlight (in dev mode) which UI elements take users the most time
- **Personalized onboarding replay**: Let users re-watch their own onboarding at any time
- **"What changed since I was last here"**: Summarize all changes since the user's last visit

---

## APIs / Backend Services

- **Request archaeology**: Every API call stored and replayable — for debugging, auditing, or time-travel
- **Semantic versioning of behavior**: Not just schema versions but behavioral diffs ("this endpoint now rounds differently")
- **Live contract testing**: Validate callers against the schema on every request, surface mismatches as warnings
- **Graceful degradation modes**: Pre-defined fallback behaviors when dependencies fail, user-configurable
- **Usage fingerprinting**: Identify which callers use which features — deprecate safely
- **Explainable errors**: Every error includes a structured explanation + what to do next
- **Rate limit negotiation**: Callers can request higher limits with justification; auto-approved under threshold
- **Shadow mode**: Run old and new logic in parallel and diff results before cutting over

---

## Developer Tools / IDEs / Code Tools

- **Semantic diff**: Show what changed in terms of behavior/logic, not just text
- **Decision log**: Capture "why" alongside "what" — commit messages that explain the tradeoff made
- **Test coverage storytelling**: Not just % covered, but "these 3 paths have never been tested in production"
- **Complexity heatmap**: Color files/functions by cyclomatic complexity, updated on every save
- **Pair with your past self**: AI trained on your own code history suggests what *you* would do next
- **Rubber duck mode**: Explain what you're about to do; the tool asks one clarifying question
- **Dead code funeral**: Identify code that hasn't been touched or called in >90 days, surface for review
- **Dependency time machine**: Show what your deps looked like 6 months ago, flag what's drifted

---

## Games

- **Emergent reputation**: NPCs remember what the player has done and react without explicit reputation score
- **Procedural history**: The world has a history before the player arrived — discoverable, consistent
- **Difficulty as a spectrum not a setting**: Adjust 10 independent axes (enemy aggression, resource scarcity, etc.)
- **Meta-progression that changes the game**: Unlocks that make things harder, not just easier
- **Player-authored lore**: Let players name things, write notes — the game saves and displays them
- **Consequence echoes**: Decisions from 10 hours ago surface as consequences in unexpected ways
- **Ghost replay**: See a translucent ghost of your previous run alongside the current one
- **Accessible speedrun mode**: Real-time splits and route suggestions built into the UI

---

## Data / Analytics / Dashboards

- **Anomaly narration**: Instead of flagging anomalies, explain them in plain English with likely causes
- **"So what?" layer**: Every metric annotated with its business implication, not just its value
- **Comparative self**: Compare current data to "you at the same stage 3 months ago"
- **Confidence visualization**: Show uncertainty ranges, not just point estimates
- **Alert fatigue detector**: Track which alerts fire but are never acted on — auto-snooze
- **Narrative export**: Turn a dashboard into a slide-ready written summary with one click
- **Proactive digest**: Email/notification with "3 things that changed this week and why they matter"
- **Data lineage everywhere**: Click any number to see exactly where it came from

---

## AI / LLM-Powered Tools

- **Calibration mode**: Let users correct the AI and have those corrections persist as personal fine-tuning
- **Confidence spectrum**: AI expresses how sure it is and changes its behavior (ask for confirmation vs. act)
- **Adversarial testing built in**: A second AI tries to break the first one's output — surfaces edge cases
- **Explainability trail**: Every AI decision shows the reasoning chain in a collapsible UI
- **Cost transparency**: Show exactly how many tokens/dollars each operation costs in real time
- **Model swapper**: Same interface, swap the model underneath — A/B test outputs side by side
- **Offline fallback mode**: When the API is unavailable, degrade gracefully with cached or rule-based logic
- **Human-in-the-loop escalation**: AI automatically escalates to the user when its confidence drops below a threshold

---

## Cross-Cutting Patterns That Work Almost Anywhere

### The Digest Pattern
Collect events silently → batch them → surface a summary at the right time (daily, weekly, on exit).
Works in: CLI tools, web apps, dev tools, games.

### The Archaeology Pattern
Store everything. Make the past fully navigable. Let users travel back in time.
Works in: any stateful system.

### The Explain Yourself Pattern
Every automated action can be asked "why did you do that?" and gives a clear answer.
Works in: AI tools, build systems, formatters, linters, any automation.

### The Teach Me Pattern
Let users define new behaviors through example, not configuration.
Works in: CLI tools, AI tools, automation tools.

### The Ambient Intelligence Pattern
Compute something expensive in the background. Surface the result only when it becomes relevant.
Works in: web apps, dev tools, data tools.

### The Social Layer Pattern
Make a solo tool aware that other people exist — even asynchronously.
Works in: any tool where multiple users exist.

### The Graceful Degradation Pattern
Design explicit fallback behaviors. Make failure a first-class feature.
Works in: APIs, networked apps, AI tools.
