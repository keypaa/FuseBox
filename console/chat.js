window.Chat = (() => {
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function md(src) {
    if (src == null) src = "";
    const fences = [];
    let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      fences.push(`<pre><code class="lang-${esc(lang)}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000F${fences.length - 1}\u0000`;
    });
    text = esc(text);
    text = text.replace(/^### (.*)$/gm, "<h4>$1</h4>")
               .replace(/^## (.*)$/gm, "<h3>$1</h3>")
               .replace(/^# (.*)$/gm, "<h3>$1</h3>");
    text = text.replace(/^(?:[-*] .*(?:\n|$))+/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
      return `<ul>${items}</ul>`;
    });
    text = text.replace(/^(?:\d+\. .*(?:\n|$))+/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
      return `<ol>${items}</ol>`;
    });
    text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    const parts = text.split(/\n{2,}/).map((p) => {
      const t = p.trim();
      if (!t) return "";
      if (/^<(h[34]|ul|ol|pre)/.test(t) || t.startsWith("\u0000F")) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    });
    let html = parts.join("\n");
    html = html.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[+i]);
    return html;
  }

  const chatcol = $("chatcol");
  const emptystate = $("emptystate");
  const chatscroll = $("chatscroll");
  const chatin = $("chatin");
  const sendBtn = $("send");

  let messages = [];
  let generating = false;
  let abortFlag = false;
  let currentId = null;
  let history = [];

  function scrollBottom() { chatscroll.scrollTop = chatscroll.scrollHeight; }
  function autosize() { chatin.style.height = "auto"; chatin.style.height = Math.min(chatin.scrollHeight, 180) + "px"; }

  /* ------------------------------ run_command ----------------------------- */
  const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

  function runCommand(command) {
    return ConsoleAPI.ensureConnected().then(
      () => new Promise((resolve) => {
        let buf = "";
        let timer = null, done = false, round = 0, wantRc = false;
        const deadline = Date.now() + 45000;
        const sub = (text) => { buf += text; arm(); };
        const unsub = ConsoleAPI.onOutput(sub);
        const finish = () => {
          if (done) return;
          done = true; unsub(); clearTimeout(timer);
          let out = buf.replace(ANSI_RE, "");
          let rc = null;
          const m = out.match(/__RC=(\d+)\s*\r?\n?/);
          if (m) { rc = Number(m[1]); out = out.slice(0, m.index) + out.slice(m.index + m[0].length); }
          out = out.replace(/^echo "__RC=\$\?"\r?\n?/gm, "").replace(/__RC=\$\?\r?\n/g, "");
          out = out.split("\n").filter((l) => !l.includes('echo "__RC=$?"')).join("\n");
          const PROMPT_RE = /^(?:[\w.-]+@[\w.-]+:[^\s]*[#$]|\$\s*)$/;
          const ls = out.replace(/\r/g, "").split("\n");
          while (ls.length && (ls.at(-1).trim() === "" || PROMPT_RE.test(ls.at(-1).trim()))) ls.pop();
          out = ls.join("\n").trim();
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
            if (round === 0) { round = 1; wantRc = true; ConsoleAPI.sendRaw('echo "__RC=$?"\n'); arm(); }
            else finish();
          }, quiet());
        };
        const quiet = () => 700 + Math.min(1500, command.length * 4);
        ConsoleAPI.sendRaw(command + "\n");
        arm();
      }),
    );
  }

  function readFile(path) {
    return ConsoleAPI.ensureConnected().then(() => ConsoleAPI.fetchFile(path)).then((res) => res.text());
  }

  async function writeFile(path, content) {
    const form = new FormData();
    const blob = new Blob([content], { type: "application/octet-stream" });
    const fname = path.split("/").pop() || "file";
    form.append("file", blob, fname);
    const target = path;
    const xhr = new XMLHttpRequest();
    await new Promise((resolve, reject) => {
      xhr.open("POST", `${ConsoleAPI.apiBase()}/files/upload?path=${encodeURIComponent(target)}`);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`)));
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(form);
    });
  }

  async function listFiles(path) {
    const res = await fetch(`${ConsoleAPI.apiBase()}/files/list?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!Array.isArray(data.entries)) throw new Error(data.error ?? "list failed");
    return data.entries;
  }

  function deleteFile(path) {
    return ConsoleAPI.ensureConnected().then(() =>
      runCommand(`rm -f ${JSON.stringify(path)}`),
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
          "Captured stdout/stderr and the exit code are returned. Use for " +
          "inspecting the system, building, running scripts, installing packages.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The bash command line to execute." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a file inside the microVM. Returns the full " +
          "text. Prefer this over run_command + cat for source files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path inside the VM." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write content to a file inside the microVM, creating parent " +
          "directories as needed. Use this to create deliverables — source " +
          "code, docs, configs, scripts.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path inside the VM." },
            content: { type: "string", description: "The full file contents." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files and directories at a path inside the microVM. " +
          "Returns names, sizes, and whether each entry is a directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path inside the VM." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description:
          "Delete a file inside the microVM. Use with care — deletion is permanent.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path inside the VM." },
          },
          required: ["path"],
        },
      },
    },
  ];

  /* ------------------------------ settings ------------------------------ */

  const DEFAULT_SYSTEM_PROMPT =
    "You are FuseBox, an expert AI software engineer with direct access to a " +
    "sandboxed Linux microVM (root user, x86_64, Ubuntu 24.04 base).\n\n" +
    "You work inside the sandbox. Use the provided tools to inspect, build, and " +
    "deliver. Never claim you cannot do something you can do with a tool.\n\n" +
    "Working directories:\n" +
    "  - /mnt/user-data/outputs   — deliverables you create (write here)\n" +
    "  - /mnt/user-data/uploads   — files the user uploads\n" +
    "  - /mnt/user-data/tool_results — structured tool results\n" +
    "  - /tmp                     — scratch space\n" +
    "  - /mnt/skills/public, /mnt/skills/examples, /mnt/filestore — read-only\n\n" +
    "Guidance:\n" +
    "  - Use run_command for anything touching the machine. It runs as root.\n" +
    "  - read_file / write_file are for source files, docs, configs — prefer\n" +
    "    them over run_command + cat when the file is the deliverable.\n" +
    "  - run_command output is captured; the exit code is reported. On failure,\n" +
    "    diagnose and retry.\n" +
    "  - Keep responses concise and concrete. Show the result, not just say\n" +
    "    'done'. When you create a file, quote its path and a short summary.\n" +
    "  - When a user asks you to build something, actually build it and show\n" +
    "    the working output.\n\n" +
    "Tool use: call tools whenever they move the work forward. After a tool\n" +
    "result, continue the task — don't ask permission to proceed.";

  const DEFAULT_SETTINGS = {
    baseUrl: "",
    key: "",
    model: "inclusionai/ling-3.1-flash",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };

  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("fusebox.api") ?? "{}") }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  let settings = loadSettings();
  const saveSettings = () => localStorage.setItem("fusebox.api", JSON.stringify(settings));

  async function providerComplete(payloadMessages, onDelta) {
    // settings is captured at module load; re-read from storage so a key
    // or model set after boot (or edited in the settings modal) takes effect.
    try {
      const saved = JSON.parse(localStorage.getItem("fusebox.api") ?? "{}");
      if (saved.baseUrl !== undefined) settings.baseUrl = saved.baseUrl;
      if (saved.key !== undefined) settings.key = saved.key;
      if (saved.model) settings.model = saved.model;
      if (saved.systemPrompt) settings.systemPrompt = saved.systemPrompt;
    } catch {}

    if (settings.baseUrl === "mock") return mockComplete(payloadMessages);

    // Single model only — no fallback substitution, ever.
    const stream = settings.stream !== false;
    const body = {
      model: settings.model,
      messages: payloadMessages,
      tools: TOOLS_SCHEMA,
      temperature: 0.4,
      ...(stream ? { stream: true } : {}),
    };

    let url, headers;
    if (/^https?:\/\//.test(settings.baseUrl || "")) {
      // Legacy direct-from-browser mode: an absolute baseUrl (e.g. the
      // FAKE_LLM_URL test harness) POSTs straight at the provider, with the
      // browser key attached only in this mode.
      url = settings.baseUrl.replace(/\/$/, "") + "/chat/completions";
      headers = {
        "Content-Type": "application/json",
        ...(settings.key ? { Authorization: `Bearer ${settings.key}` } : {}),
      };
    } else {
      // Default: same-origin relay — server.py injects the key server-side,
      // so the browser never sends (or sees) one. No max_tokens in the body.
      url = "/api/chat";
      headers = { "Content-Type": "application/json" };
    }

    const isRelay = url === "/api/chat";
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const msg = `${res.status} ${detail.slice(0, 300)}`;
      if (res.status === 401 && (isRelay || !settings.key)) {
        throw new Error("model endpoint unauthorized — check OPENROUTER_API_KEY in console/.env");
      }
      throw new Error(msg);
    }
    if (!stream || !res.body) {
      const data = await res.json();
      return data.choices?.[0]?.message ?? { role: "assistant", content: "(empty response)" };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls = [];
    while (true) {
      if (abortFlag) { reader.cancel().catch(() => {}); throw new DOMException("stopped", "AbortError"); }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const delta = j.choices?.[0]?.delta ?? {};
        if (delta.content) content += delta.content;
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          toolCalls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
        if (delta.content || delta.tool_calls?.length) onDelta?.(content, toolCalls);
      }
    }
    if (!content && !toolCalls.length) content = "(empty response)";
    return {
      role: "assistant",
      ...(content ? { content } : { content: null }),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
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
  /* ------------------------------ rendering ----------------------------- */

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
    const b = document.createElement("div");
    b.className = "bubble md";
    const body = typeof msg.content === "string" ? msg.content : "";
    if (!body && msg.tool_calls?.length) {
      b.innerHTML = `<span class="toolcall-note">▸ ${esc(msg.tool_calls.map((c) => c.function?.name ?? "tool").join(", "))}…</span>`;
      b.classList.add("quiet");
    } else {
      b.innerHTML = window.__mdRender ? window.__mdRender(body) : md(body);
    }
    w.append(b);
    return w;
  }

  function renderMsg(msg) {
    emptystate.hidden = true;
    const el = elFor(msg);
    chatcol.appendChild(el);
    enhanceCode(el);
    scrollBottom();
    return el;
  }

  function enhanceCode(scope) {
    for (const pre of scope.querySelectorAll(".bubble pre")) {
      if (pre.parentElement?.classList.contains("codewrap")) continue;
      const wrap = document.createElement("div");
      wrap.className = "codewrap";
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", () => {
        navigator.clipboard?.writeText(pre.textContent).then(() => {
          btn.textContent = "copied";
          setTimeout(() => (btn.textContent = "copy"), 1200);
        }).catch(() => {});
      });
      pre.replaceWith(wrap);
      wrap.append(btn, pre);
    }
  }

  function rerenderAll() {
    [...chatcol.querySelectorAll(".msg")].forEach((n) => n.remove());
    emptystate.hidden = messages.length > 0;
    for (const m of messages) renderMsg(m);
  }

  const persist = () => {
    localStorage.setItem("fusebox.chat", JSON.stringify(messages.slice(-200)));
    saveConv();
  };

  /* ----------------------------- tool cards ------------------------------ */

  function toolCard(call) {
    let args = {};
    try { args = JSON.parse(call.function.arguments ?? "{}"); } catch {}
    const name = call.function.name;
    const summary = name === "run_command" ? (args.command || "").split("\n")[0].slice(0, 90)
      : name === "write_file" ? `write ${args.path || "?"}`
      : name === "read_file" ? `read ${args.path || "?"}`
      : name === "list_files" ? `list ${args.path || "?"}`
      : name === "delete_file" ? `delete ${args.path || "?"}`
      : name;
    const lang = name === "run_command" ? "bash" : name;
    const cmdText = name === "run_command" ? (args.command || "") : summary;

    const el = document.createElement("div");
    el.className = "tool-card";
    el.innerHTML = `
      <div class="tc-head">
        <span class="tc-chevron">▸</span>
        <span class="tc-name">${esc(name)}</span>
        <span class="tc-summary">${esc(summary)}</span>
      </div>
      <div class="tc-body">
        <div class="tc-lang">${esc(lang)}</div>
        <div class="tc-cmd"><pre>${esc(cmdText)}</pre></div>
        <div class="tc-out-label">Output</div>
        <div class="tc-out"><pre></pre></div>
        <div class="tc-foot"><span class="tc-rc"></span><span class="tc-act"><button type="button" class="tc-copy">copy</button><span class="tc-time"></span></span></div>
        <div class="tc-details">
          <button type="button" class="tc-details-toggle">show request JSON</button>
          <div class="tc-details-body" hidden><pre>${esc(JSON.stringify(args, null, 2))}</pre></div>
        </div>
      </div>`;
    el.querySelector(".tc-head").addEventListener("click", () => el.classList.toggle("open"));
    const detToggle = el.querySelector(".tc-details-toggle");
    const detBody = el.querySelector(".tc-details-body");
    detToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const hidden = detBody.hidden;
      detBody.hidden = !hidden;
      detToggle.textContent = hidden ? "hide request JSON" : "show request JSON";
    });
    el.querySelector(".tc-copy").addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigator.clipboard?.writeText(el.querySelector(".tc-out pre").textContent ?? "").catch(() => {});
    });
    return { el, outPre: el.querySelector(".tc-out pre"), rcEl: el.querySelector(".tc-rc"), footTime: el.querySelector(".tc-time") };
  }

  function setToolRunning(card) {
    card.rcEl.innerHTML = '<span class="spin"></span>running…';
    card.rcEl.className = "tc-rc";
  }
  function setToolDone(card, output, rc) {
    card.outPre.textContent = output || "(no output)";
    card.rcEl.textContent = rc === null ? "(no exit code)" : `exit ${rc}`;
    card.rcEl.className = "tc-rc " + (rc === 0 || rc === null ? "ok" : "err");
  }
  function setToolError(card, msg) {
    card.outPre.textContent = "";
    card.rcEl.textContent = "error: " + msg;
    card.rcEl.className = "tc-rc err";
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
              ? { role: "assistant", content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) }
              : { role: "user", content: m.content },
        ),
      ];

      const live = document.createElement("div");
      live.className = "msg assistant streaming";
      live.innerHTML =
        `<div class="bubble md"><span class="thinking"><i></i><i></i><i></i></span></div>`;
      emptystate.hidden = true;
      chatcol.appendChild(live);
      scrollBottom();
      const liveBody = live.querySelector(".bubble");
      let liveRaf = false;
      const onDelta = (text, tools) => {
        if (tools?.length) {
          liveBody.innerHTML =
            `<span class="toolcall-note">▸ ${esc(tools.map((c) => c.function?.name || "tool").join(", "))}…</span>`;
        } else {
          liveBody.innerHTML = md(text) + '<span class="cursor"></span>';
        }
        if (!liveRaf) { liveRaf = true; requestAnimationFrame(() => { liveRaf = false; scrollBottom(); }); }
      };

      let reply;
      try {
        reply = await providerComplete(payload, onDelta);
      } finally {
        live.remove();
      }
      messages.push(reply);
      persist();

      const toolCalls = reply.tool_calls ?? [];
      if (toolCalls.length === 0 || abortFlag) {
        renderMsg(reply);
        persist();
        return;
      }

      if (toolCalls.length && !(typeof reply.content === "string" && reply.content.trim())) {
        // pure tool-call round: the group header below stands in for it
      } else {
        renderMsg(reply);
      }
      const turn = document.createElement("div");
      turn.className = "tool-turn";
      const groupLabel = document.createElement("span");
      groupLabel.className = "tg-label";
      groupLabel.textContent = toolCalls.length === 1 ? "Ran a command" : `Ran ${toolCalls.length} commands`;
      turn.appendChild(groupLabel);
      chatcol.appendChild(turn);
      turn.addEventListener("click", (ev) => {
        if (ev.target.closest(".tc-copy")) return;
        turn.classList.toggle("collapsed");
      });
      let done = 0;
      for (const call of toolCalls) {
        if (abortFlag) break;
        let args = {};
        try { args = JSON.parse(call.function.arguments ?? "{}"); } catch {}
        const name = call.function.name;

        const card = toolCard(call);
        turn.appendChild(card.el);
        setToolRunning(card);
        scrollBottom();

        let output = "", rc = null, err = null;
        try {
          if (name === "run_command") ({ output, rc } = await runCommand(args.command));
          else if (name === "read_file") output = await readFile(args.path);
          else if (name === "write_file") { await writeFile(args.path, args.content); output = `wrote ${args.path} (${args.content.length} bytes)`; rc = 0; }
          else if (name === "list_files") { const e = await listFiles(args.path); output = e.map((x) => `${x.is_dir ? "d" : "-"} ${x.name}${x.is_dir ? "" : "  " + formatSize(x.size)}`).join("\n") || "(empty)"; rc = 0; }
          else if (name === "delete_file") { output = await deleteFile(args.path); rc = 0; }
          else throw new Error(`unknown tool: ${name}`);
        } catch (e) {
          err = e.message ?? String(e);
        }

        if (err) setToolError(card, err);
        else setToolDone(card, output, rc);

        const resultMsg = {
          role: "tool",
          name,
          tool_call_id: call.id,
          content: err ? `error: ${err}` : (output || "(no output)"),
          rc,
        };
        messages.push(resultMsg);
        persist();
        scrollBottom();
        if (done === 0) card.el.classList.add("open");
        done++;
        card.footTime.textContent = window.relTime ? window.relTime(Date.now()) : "just now";
      }
    }
  }

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

  /* ------------------------------- sending ------------------------------ */

  async function sendMessage() {
    const text = chatin.value.trim();
    if (!text || generating) return;
    chatin.value = "";
    autosize();

    messages.push({ role: "user", content: text });
    renderMsg(messages.at(-1));
    persist();
    newConversation(text);

    abortFlag = false;
    setBusy(true);
    try {
      await agentLoop();
    } catch (e) {
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.tool_calls?.length) {
        const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
        for (const call of last.tool_calls) {
          if (!answered.has(call.id)) {
            messages.push({ role: "tool", name: call.function?.name ?? "run_command", tool_call_id: call.id, content: `(interrupted: ${e.message ?? e})`, rc: null });
          }
        }
        persist();
      }
      if (e?.name === "AbortError") notice("[stopped]", "33");
      else { renderError(new Error(`[${settings.model}] ${e.message ?? e}`)); }
    } finally {
      setBusy(false);
      saveConv();
    }
  }

  function stopGenerating() {
    abortFlag = true;
    toast("stopping…", "info", 1500);
  }
  function notice(text, color) { ConsoleAPI.termNotice(text, color); }
  function toast(msg, kind, ms) { ConsoleAPI.toast(msg, kind, ms); }

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
    b.addEventListener("click", () => { chatin.value = b.dataset.fill; autosize(); chatin.focus(); });
  }

  /* ------------------------------ settings ------------------------------ */

  function openSettings() {
    $("set-base").value = settings.baseUrl;
    $("set-model").value = settings.model;
    $("set-sys").value = settings.systemPrompt;
    $("settings").hidden = false;
  }
  $("settingsbtn").addEventListener("click", openSettings);
  $("modelfoot").addEventListener("click", openSettings);
  $("set-cancel").addEventListener("click", () => $("settings").hidden = true);
  $("set-save").addEventListener("click", () => {
    const v = $("set-base").value.trim();
    settings.baseUrl = v;
    settings.model = $("set-model").value.trim() || (settings.baseUrl === "mock" ? "fusebox-mock" : settings.model);
    settings.systemPrompt = $("set-sys").value;
    saveSettings();
    updateChip();
    $("settings").hidden = true;
    ConsoleAPI.toast(`model: ${settings.baseUrl === "mock" ? "mock" : settings.model}`, "ok", 2500);
  });
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").hidden = true; });

  function updateChip() {
    const short = (settings.model || "").split("/").pop() || "model";
    const foot = $("modelfoot");
    if (foot) foot.textContent = short;
  }

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

  /* ------------------------------ history ------------------------------ */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem("fusebox.history") ?? "[]"); }
    catch { return []; }
  }
  history = loadHistory();

  function saveHistory() { localStorage.setItem("fusebox.history", JSON.stringify(history)); }

  function newConversation(prefill) {
    currentId = "conv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    history.unshift({ id: currentId, title: (prefill || "new conversation").slice(0, 50), ts: Date.now() });
    if (history.length > 50) history.pop();
    saveHistory();
    renderHistory();
  }

  function loadConversation(id) {
    const h = history.find((x) => x.id === id);
    if (!h) return;
    currentId = id;
    messages = h.messages || [];
    rerenderAll();
    renderHistory();
    chatin.focus();
  }

  function saveConv() {
    if (!currentId) return;
    const h = history.find((x) => x.id === currentId);
    if (h) {
      h.messages = messages;
      h.ts = Date.now();
      const first = messages.find((m) => m.role === "user");
      if (first) h.title = first.content.slice(0, 50);
    }
    saveHistory();
    renderHistory();
  }

  /* ------------------------------ preview ------------------------------ */

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
      if (/\.md$/i.test(name)) body.innerHTML = `<div class="md">${md(text)}</div>`;
      else { body.innerHTML = ""; const pre = document.createElement("pre"); pre.textContent = text; body.appendChild(pre); }
    } catch (e) {
      body.innerHTML = `<pre style="color:var(--danger)">cannot preview: ${String(e.message ?? e)}</pre>`;
    }
  }
  $("preview-close").addEventListener("click", () => $("preview").hidden = true);
  $("preview").addEventListener("click", (e) => { if (e.target === $("preview")) $("preview").hidden = true; });

  function onUploaded() {}

  /* -------------------------------- boot -------------------------------- */

  updateChip();
  rerenderAll();
  autosize();
  ConsoleAPI.setMdRenderer(md);
  chatin.focus();
  // app.js renders the sidebar before this script defines __dedupeTitles,
  // so re-render once here to apply smart titles on boot.
  if (window.renderHistory) window.renderHistory();

  return {
    previewFile, onUploaded,
    getHistory: () => history,
    getCurrentId: () => currentId,
    newChat: () => { messages = []; currentId = null; newConversation(); rerenderAll(); },
    loadConversation,
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
  };
})();
