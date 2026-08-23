/* FuseConsole — chat layer.
 *
 * Turns the console into a Claude-web-style assistant whose hands are the
 * sandbox: an OpenAI-compatible chat completion endpoint receives the
 * conversation plus a run_command tool, and every tool call executes inside
 * the live PTY session of the microVM. A built-in "mock" provider makes the
 * whole loop work without any API key.
 *
 * Wires itself to app.js exclusively through window.ConsoleAPI.
 */
"use strict";

window.Chat = (() => {
  const $ = (id) => document.getElementById(id);

  /* ------------------------------ settings ------------------------------ */

  const DEFAULT_SETTINGS = {
    baseUrl: "mock",
    key: "",
    model: "fusebox-mock",
    systemPrompt:
      "You are the assistant of FuseConsole, a web terminal attached to a " +
      "Firecracker microVM sandbox running Linux. You have root access.\n" +
      "Writable paths: /mnt/user-data/outputs (deliverables), " +
      "/mnt/user-data/uploads (user files), /mnt/user-data/tool_results, and /tmp.\n" +
      "Read-only: /mnt/skills/public, /mnt/skills/examples, /mnt/filestore.\n" +
      "Use the run_command tool for anything that touches the machine. Keep " +
      "answers concise. When you create files, put them in outputs.",
  };

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("fusebox.api") ?? "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  let settings = loadSettings();
  const saveSettings = () => localStorage.setItem("fusebox.api", JSON.stringify(settings));

  /* --------------------------- markdown (mini) -------------------------- */

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function md(src) {
    if (src == null) src = "";
    const fences = [];
    // pull fenced blocks out first so nothing inside them gets transformed
    let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      fences.push(`<pre><code class="lang-${esc(lang)}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000F${fences.length - 1}\u0000`;
    });

    text = esc(text);

    // headings
    text = text.replace(/^### (.*)$/gm, "<h4>$1</h4>")
               .replace(/^## (.*)$/gm, "<h3>$1</h3>")
               .replace(/^# (.*)$/gm, "<h3>$1</h3>");

    // lists (- and *)
    text = text.replace(/^(?:[-*] .*(?:\n|$))+/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
      return `<ul>${items}</ul>`;
    });
    text = text.replace(/^(?:\d+\. .*(?:\n|$))+/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
      return `<ol>${items}</ol>`;
    });

    // inline
    text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    // paragraphs: split on blank lines, keep block elements intact
    const parts = text.split(/\n{2,}/).map((p) => {
      const t = p.trim();
      if (!t) return "";
      if (/^<(h[34]|ul|ol|pre)/.test(t) || t.startsWith("\u0000F")) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    });

    let html = parts.join("\n");
    // re-inject fenced blocks
    html = html.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[+i]);
    return html;
  }

  /* ------------------------------ rendering ----------------------------- */

  const chatcol = $("chatcol");
  const emptystate = $("emptystate");
  const chatscroll = $("chatscroll");
  const chatin = $("chatin");
  const sendBtn = $("send");

  let messages = loadMessages();

  // Restored transcripts can be junk (old format, interrupted runs, manual
  // edits): keep only well-formed entries so boot never throws.
  function loadMessages() {
    let msgs = [];
    try {
      msgs = JSON.parse(localStorage.getItem("fusebox.chat") ?? "[]");
    } catch { msgs = []; }
    if (!Array.isArray(msgs)) return [];
    const clean = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user" && typeof m.content === "string") {
        clean.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        clean.push({
          role: "assistant",
          content: typeof m.content === "string" ? m.content : "",
          ...(Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls } : {}),
        });
      } else if (m.role === "tool" && m.tool_call_id) {
        clean.push({
          role: "tool",
          name: m.name ?? "run_command",
          tool_call_id: m.tool_call_id,
          content: String(m.content ?? ""),
          rc: m.rc,
        });
      }
    }
    return clean;
  }

  let generating = false;
  let abortFlag = false;

  function scrollBottom() {
    chatscroll.scrollTop = chatscroll.scrollHeight;
  }

  function autosize() {
    chatin.style.height = "auto";
    chatin.style.height = Math.min(chatin.scrollHeight, 180) + "px";
  }

  function elFor(msg) {
    if (msg.role === "user") {
      const w = document.createElement("div");
      w.className = "msg user";
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = msg.content;
      w.appendChild(b);
      return w;
    }
    if (msg.role === "tool") {
      const w = document.createElement("div");
      w.className = "msg tool";
      const head = document.createElement("div");
      head.className = "tool-head";
      head.textContent = `▸ ${msg.name} · exit ${msg.rc ?? "?"}`;
      const pre = document.createElement("pre");
      pre.textContent = msg.content || "(no output)";
      w.append(head, pre);
      return w;
    }
    // assistant
    const w = document.createElement("div");
    w.className = "msg assistant";
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = `<span class="mark">✳</span> assistant`;
    const b = document.createElement("div");
    b.className = "bubble md";
    const body = typeof msg.content === "string" ? msg.content : "";
    if (!body && msg.tool_calls?.length) {
      // intent-only reply (tool call round) — no prose to render
      b.innerHTML = `<span class="toolcall-note">▸ ${esc(msg.tool_calls.map((c) => c.function?.name ?? "tool").join(", "))}…</span>`;
      b.classList.add("quiet");
    } else {
      b.innerHTML = window.__mdRender ? window.__mdRender(body) : md(body);
    }
    w.append(who, b);
    return w;
  }

  function renderMsg(msg) {
    emptystate.hidden = true;
    const el = elFor(msg);
    chatcol.appendChild(el);
    scrollBottom();
    return el;
  }

  function rerenderAll() {
    [...chatcol.querySelectorAll(".msg")].forEach((n) => n.remove());
    emptystate.hidden = messages.length > 0;
    for (const m of messages) renderMsg(m);
  }

  const persist = () => localStorage.setItem("fusebox.chat", JSON.stringify(messages.slice(-200)));

  /* ---------------------------- run_command ----------------------------- */

  const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

  function runCommand(command) {
    return ConsoleAPI.ensureConnected().then(
      () =>
        new Promise((resolve) => {
          let buf = "";
          let timer = null;
          let done = false;
          let round = 0;
          let wantRc = false;

          const deadline = Date.now() + 45000;

          const sub = (text) => {
            buf += text;
            arm();
          };
          const unsub = ConsoleAPI.onOutput(sub);

          const finish = () => {
            if (done) return;
            done = true;
            unsub();
            clearTimeout(timer);
            let out = buf.replace(ANSI_RE, "");
            let rc = null;
            const m = out.match(/__RC=(\d+)\s*\r?\n?/);
            if (m) {
              rc = Number(m[1]);
              out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
            }
            // strip the echo of our own probe lines
            out = out.replace(/^echo "__RC=\$\?"\r?\n?/gm, "").replace(/__RC=\$\?\r?\n/g, "");
            // strip any leftover line echoing the rc probe
            out = out
              .split("\n")
              .filter((l) => !l.includes('echo "__RC=$?"'))
              .join("\n");
            // drop trailing blank lines and bare shell prompts
            const PROMPT_RE = /^(?:[\w.-]+@[\w.-]+:[^\s]*[#$]|\$\s*)$/;
            const ls = out.replace(/\r/g, "").split("\n");
            while (ls.length && (ls.at(-1).trim() === "" || PROMPT_RE.test(ls.at(-1).trim()))) ls.pop();
            out = ls.join("\n").trim();
            // strip echo of the submitted command (first line matching its head)
            const head = command.split("\n")[0].slice(0, 32);
            const lines = out.split("\n");
            const at = lines.findIndex((l) => l.includes(head));
            if (at >= 0) lines.splice(0, at + 1);
            out = lines.join("\n").trim();
            resolve({ output: out.length > 8000 ? "…truncated…\n" + out.slice(-8000) : out, rc });
          };

          const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              if (Date.now() > deadline) return finish();
              if (round === 0) {
                round = 1;
                wantRc = true;
                ConsoleAPI.sendRaw(`echo "__RC=$?"\n`);
                arm();
              } else {
                finish();
              }
            }, quiet());
          };

          // longer commands get a bit more quiet time
          const quiet = () => 700 + Math.min(1500, command.length * 4);

          ConsoleAPI.sendRaw(command + "\n");
          arm();
        }),
    );
  }

  /* ------------------------------- providers ---------------------------- */

  const TOOLS_SCHEMA = [
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a bash command inside the FuseBox microVM as root. " +
          "Captured stdout/stderr and the exit code are returned.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The bash command line to execute." },
          },
          required: ["command"],
        },
      },
    },
  ];

  async function providerComplete(payloadMessages) {
    if (settings.baseUrl === "mock") return mockComplete(payloadMessages);

    const res = await fetch(settings.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.key ? { Authorization: `Bearer ${settings.key}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: payloadMessages,
        tools: TOOLS_SCHEMA,
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message ?? { role: "assistant", content: "(empty response)" };
  }

  // Deterministic demo brain: proves the whole tool loop without any key.
  let mockTurn = 0;
  async function mockComplete(messages) {
    await new Promise((r) => setTimeout(r, 350));
    const usedTool = messages.some((m) => m.role === "tool");
    if (!usedTool && mockTurn === 0) {
      mockTurn++;
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_mock_1",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                // probe the canonical outputs dir; dev hosts without it
                // fall back to /tmp so the demo always works
                command:
                  'D=/mnt/user-data/outputs; { mkdir -p "$D" 2>/dev/null && [ -w "$D" ]; } || D=/tmp/fusebox-demo; mkdir -p "$D"; ' +
                  'echo "hello from the FuseBox mock model" > "$D/mock.txt"; uname -m; cat "$D/mock.txt"; echo "WROTE:$D/mock.txt"',
              }),
            },
          },
        ],
      };
    }
    const toolOut = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    mockTurn = 0;
    return {
      role: "assistant",
      content:
        "I ran a command inside your sandbox and wrote `mock.txt`.\n\n```\n" +
        toolOut.trim() +
        "\n```\nSwitch the provider in ⚙ settings to a real endpoint to talk to an actual model.",
    };
  }

  /* ------------------------------ agent loop ---------------------------- */

  function setBusy(b) {
    generating = b;
    sendBtn.textContent = b ? "■" : "➤";
    sendBtn.classList.toggle("stop", b);
    sendBtn.title = b ? "stop" : "send (Enter)";
  }

  async function agentLoop() {
    let turns = 0;
    while (turns < 8) {
      if (abortFlag) break;
      turns++;

      const payload = [
        { role: "system", content: settings.systemPrompt },
        ...messages.map((m) =>
          m.role === "tool"
            ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content }
            : m.role === "assistant"
              ? {
                  role: "assistant",
                  content: m.content,
                  ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                }
              : { role: "user", content: m.content },
        ),
      ];

      const reply = await providerComplete(payload);
      messages.push(reply);
      persist();

      const toolCalls = reply.tool_calls ?? [];
      if (toolCalls.length === 0 || abortFlag) {
        renderMsg(reply);
        persist();
        return;
      }

      // render the assistant intent + execute each tool call
      renderMsg(reply);
      for (const call of toolCalls) {
        if (abortFlag) break;
        let args = {};
        try { args = JSON.parse(call.function.arguments ?? "{}"); } catch {}
        const command = String(args.command ?? "");

        const toolMsg = { role: "assistant_tool", name: call.function.name, command };
        const toolEl = document.createElement("div");
        toolEl.className = "msg tool";
        toolEl.innerHTML = `<div class="tool-head">▸ ${call.function.name}</div><pre></pre>`;
        toolEl.querySelector("pre").textContent = command;
        emptystate.hidden = true;
        chatcol.appendChild(toolEl);
        scrollBottom();

        const { output, rc } = await runCommand(command);
        const resultMsg = {
          role: "tool",
          name: call.function.name,
          tool_call_id: call.id,
          content: output || "(no output)",
          rc,
        };
        messages.push(resultMsg);
        renderMsg(resultMsg);
        persist();
      }
    }
  }

  /* ------------------------------- sending ------------------------------ */

  async function sendMessage() {
    const text = chatin.value.trim();
    if (!text || generating) return;
    chatin.value = "";
    autosize();

    messages.push({ role: "user", content: text });
    renderMsg(messages.at(-1));
    persist();

    abortFlag = false;
    setBusy(true);
    try {
      await ConsoleAPI.ensureConnected();
      await agentLoop();
    } catch (e) {
      // Never leave an unanswered assistant tool_call in the transcript —
      // OpenAI-compatible endpoints reject that on the next turn.
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.tool_calls?.length) {
        const answered = new Set(
          messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
        );
        for (const call of last.tool_calls) {
          if (!answered.has(call.id)) {
            messages.push({
              role: "tool",
              name: call.function?.name ?? "run_command",
              tool_call_id: call.id,
              content: `(interrupted: ${e.message ?? e})`,
              rc: null,
            });
          }
        }
        persist();
      }
      toast(`model error: ${e.message ?? e}`, "err", 6000);
      notice(`[model error] ${e.message ?? e}`, "31");
    } finally {
      setBusy(false);
    }
  }

  function stopGenerating() {
    abortFlag = true;
    toast("stopping after current step…", "info", 2000);
  }

  function notice(text, color) {
    ConsoleAPI.termNotice(text, color);
  }
  function toast(msg, kind, ms) {
    ConsoleAPI.toast(msg, kind, ms);
  }

  /* ------------------------------ composer ------------------------------ */

  chatin.addEventListener("input", autosize);
  chatin.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      generating ? stopGenerating() : sendMessage();
    }
  });
  sendBtn.addEventListener("click", () => {
    generating ? stopGenerating() : (chatin.value.trim() ? sendMessage() : null);
  });
  for (const b of document.querySelectorAll(".suggestions button")) {
    b.addEventListener("click", () => {
      chatin.value = b.dataset.fill;
      autosize();
      chatin.focus();
    });
  }
  $("newchat").addEventListener("click", () => {
    messages = [];
    mockTurnReset();
    persist();
    rerenderAll();
  });

  function mockTurnReset() { mockTurn = 0; }

  /* --------------------------- file viewer ------------------------------ */

  const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

  async function previewFile(name) {
    const path = `${document.getElementById("filesdir").value}/${name}`;
    $("preview-name").textContent = name;
    $("preview-download").href = ConsoleAPI.downloadURL(path);
    const body = $("preview-body");
    body.innerHTML = '<span style="color:var(--fg-2)">loading…</span>';
    $("preview").hidden = false;

    try {
      if (IMG_RE.test(name)) {
        body.innerHTML = "";
        const img = document.createElement("img");
        img.src = ConsoleAPI.downloadURL(path);
        body.appendChild(img);
        return;
      }
      const res = await ConsoleAPI.fetchFile(path);
      let text = await res.text();
      if (text.length > 400_000) text = text.slice(0, 400_000) + "\n… truncated …";
      if (/\.md$/i.test(name)) {
        body.innerHTML = `<div class="md">${md(text)}</div>`;
      } else {
        body.innerHTML = "";
        const pre = document.createElement("pre");
        pre.textContent = text;
        body.appendChild(pre);
      }
    } catch (e) {
      body.innerHTML = `<pre style="color:var(--danger)">cannot preview: ${String(e.message ?? e)}</pre>`;
    }
  }
  $("preview-close").addEventListener("click", () => ($("preview").hidden = true));
  $("preview").addEventListener("click", (e) => {
    if (e.target === $("preview")) $("preview").hidden = true;
  });

  /* ------------------------------ settings ------------------------------ */

  function openSettings() {
    $("set-base").value = settings.baseUrl;
    $("set-key").value = settings.key;
    $("set-model").value = settings.model;
    $("set-sys").value = settings.systemPrompt;
    $("settings").hidden = false;
  }
  $("settingsbtn").addEventListener("click", openSettings);
  $("modelchip").addEventListener("click", openSettings);
  $("set-cancel").addEventListener("click", () => ($("settings").hidden = true));
  $("set-save").addEventListener("click", () => {
    settings.baseUrl = $("set-base").value.trim() || "mock";
    settings.key = $("set-key").value.trim();
    settings.model = $("set-model").value.trim() || (settings.baseUrl === "mock" ? "fusebox-mock" : settings.model);
    settings.systemPrompt = $("set-sys").value;
    saveSettings();
    updateChip();
    $("settings").hidden = true;
    ConsoleAPI.toast(`model: ${settings.baseUrl === "mock" ? "mock" : settings.model}`, "ok", 2500);
  });
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) $("settings").hidden = true;
  });

  function updateChip() {
    $("modelchip").textContent =
      settings.baseUrl === "mock" ? "⚙ mock model" : `⚙ ${settings.model}`;
  }

  /* -------------------------------- boot -------------------------------- */

  updateChip();
  rerenderAll();
  autosize();
  ConsoleAPI.setMdRenderer(md);
  chatin.focus();

  // public surface consumed by app.js
  return { previewFile, onUploaded: () => {}, };
})();
