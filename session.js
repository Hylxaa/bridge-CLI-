// session.js — manages one LIVE Claude Code session per chat.
//
// Instead of spawning Claude in a tmux TUI and screenshotting the pane (which
// produced garbled, half-cut output), we run Claude in stream-json mode:
//   claude --input-format stream-json --output-format stream-json --verbose
// Claude then emits clean, structured JSON events — one per assistant text
// block, tool call, and tool result. We forward those as Telegram messages.
// No screenshots, no guessing, no cut sentences. The process stays alive across
// turns so the conversation keeps its memory.

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ANCHOR = process.env.BRIDGE_ANCHOR || os.homedir(); // fixed launch dir -> Claude memory in one bucket
// Generated settings file lives next to this script, so it works wherever the
// repo is cloned (no hardcoded /root path).
const SETTINGS_PATH = path.join(__dirname, "bridge-settings.json");

// Is the `rtk` token-saver CLI available? If so we chain it before the Bash gate
// (it only rewrites the command). If not, we skip it — the bridge works fine
// without RTK, just without token savings.
function hasRtk() {
  try {
    require("child_process").execSync("command -v rtk", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Write bridge-settings.json at runtime using absolute paths to THIS repo's hook
// scripts. Regenerated on every start so a fresh clone needs zero manual editing.
function ensureSettingsFile() {
  const bashApprove = path.join(__dirname, "bash-approve-hook.js");
  const editApprove = path.join(__dirname, "approve-hook.js");
  const bashHooks = [];
  if (hasRtk()) bashHooks.push({ type: "command", command: "rtk hook claude" });
  bashHooks.push({ type: "command", command: `node ${bashApprove}` });
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: bashHooks },
        { matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `node ${editApprove}` }] },
      ],
    },
  };
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch {}
}

// Bridge-only formatting + output-efficiency guidance. Telegram renders
// tables/code as monospace <pre>, so markdown tables and fenced code blocks come
// out clean — encourage them. The token-saving block trims wasted OUTPUT tokens
// (the expensive kind) WITHOUT touching reasoning depth: cut filler, keep
// thinking. This is the opposite of "always talk short" — complex problems still
// get full reasoning, only the throwaway words around the answer are removed.
const TG_FMT =
  "You are talking through a Telegram bridge. Replies render as Telegram " +
  "messages. Markdown tables and ```fenced code blocks``` are rendered as " +
  "aligned monospace, so use them freely when they help (comparisons, data, " +
  "config, diffs). Use **bold** and `inline code` normally.\n\n" +
  "OUTPUT EFFICIENCY (saves the expensive output tokens — follow strictly):\n" +
  "- No preamble or filler: skip 'Great question', 'Sure!', 'Let me', 'I'll help you'. Answer directly.\n" +
  "- Don't restate my question back to me before answering.\n" +
  "- No wrap-up filler: skip 'Let me know if you need anything', 'Hope this helps', 'Feel free to ask'.\n" +
  "- Don't explain what you're ABOUT to do, then do it. Just do it and report the result.\n" +
  "- No unsolicited alternatives, caveats, or 'you might also want to' unless I ask.\n" +
  "- For simple/factual asks: one tight answer, no padding.\n" +
  "CRITICAL — this trims words, NOT thinking: for hard problems (debugging, " +
  "architecture, analysis, tradeoffs) keep your reasoning FULL and rigorous. " +
  "Never sacrifice correctness, depth, or a needed step to be shorter. Cut the " +
  "fluff around the answer, never the substance of the answer itself.";

class ClaudeSession extends EventEmitter {
  constructor(chatId, workdir, opts = {}) {
    super();
    this.chatId = String(chatId);
    this.workdir = workdir;
    this.model = opts.model || "opus";
    this.effort = opts.effort || "high";
    this.proc = null;
    this.buf = "";
    this.sessionId = null;     // captured from events; used to --resume
    this.busy = false;         // a turn is in flight
    this.textThisTurn = false; // did we emit any assistant text this turn?
    this.queue = [];           // user turns sent while busy, fed in order when free
  }

  exists() {
    return !!(this.proc && this.proc.pid && !this.proc.killed && this.proc.exitCode === null);
  }

  // Start a live Claude process. If resumeId is set, continue that conversation
  // (preserves memory across model switches / interrupts).
  start(resumeId = null) {
    ensureSettingsFile();
    return new Promise((resolve) => {
      const modelArg = this.model;
      const args = [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", modelArg,
        "--effort", this.effort,
        // default = every Bash/Edit goes through our bridge hooks (allow-list
        // check -> Telegram Approve/Deny), mirroring Claude's terminal prompt.
        // (Not acceptEdits: that adds a 2nd permission voice that conflicts with
        // our gate. The bash-approve-hook + approve-hook are the sole gatekeepers.)
        "--permission-mode", "default",
        "--settings", SETTINGS_PATH,
        "--append-system-prompt", TG_FMT,
      ];
      if (this.workdir && this.workdir !== ANCHOR) args.push("--add-dir", this.workdir);
      if (resumeId) args.push("--resume", resumeId);

      // Use the logged-in Claude account (env inherited untouched). Strip any
      // stale ANTHROPIC_* override so we always talk to the real account.
      const env = { ...process.env };
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_API_KEY;

      this.proc = spawn("claude", args, { cwd: ANCHOR, env });
      this.buf = "";
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(true); } };

      this.proc.stdout.on("data", (d) => {
        this.buf += d.toString();
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (line.trim()) this._onLine(line, done);
        }
      });
      this.proc.stderr.on("data", (d) => {
        const s = d.toString().trim();
        if (s) this.emit("stderr", s);
      });
      this.proc.on("exit", (code) => {
        this.busy = false;
        this.emit("exit", code);
      });
      this.proc.on("error", (e) => this.emit("error", e.message || String(e)));

      // resolve once Claude is initialized (or after a safety timeout)
      this.once("ready", done);
      setTimeout(done, 12000);
    });
  }

  _onLine(line, onReady) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.session_id && ev.session_id !== this.sessionId) {
      this.sessionId = ev.session_id;
      this.emit("session", this.sessionId); // bot.js persists this to disk
    }

    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") { if (onReady) onReady(); this.emit("ready"); }
        break;

      case "assistant": {
        const content = (ev.message && ev.message.content) || [];
        for (const c of content) {
          if (c.type === "text" && c.text && c.text.trim()) {
            this.textThisTurn = true;
            this.emit("text", c.text);
          } else if (c.type === "tool_use") {
            this.emit("tool", { name: c.name, input: c.input || {} });
          }
        }
        break;
      }

      case "user": {
        // tool results come back wrapped as a user message
        const content = (ev.message && ev.message.content) || [];
        for (const c of content) {
          if (c.type === "tool_result") {
            let out = "";
            if (typeof c.content === "string") out = c.content;
            else if (Array.isArray(c.content)) out = c.content.map((x) => (x && x.text) || "").join("\n");
            if (out && out.trim()) this.emit("toolresult", { text: out, isError: !!c.is_error });
          }
        }
        break;
      }

      case "result": {
        // turn finished. if Claude produced no streamed text, fall back to the
        // final result string so the user still gets a reply.
        if (!this.textThisTurn && ev.result && String(ev.result).trim()) {
          this.emit("text", String(ev.result));
        }
        this.busy = false;
        this.emit("done", ev);
        // if messages arrived while busy, feed the next one now (in order).
        this._drainQueue();
        break;
      }
    }
  }

  // Send a user turn. If a turn is already in flight, queue it instead of
  // dropping it — it will be fed automatically when the current turn finishes.
  // Returns "sent" if dispatched now, "queued" if held, false if no process.
  sendUser(text) {
    if (!this.exists()) return false;
    if (this.busy) {
      this.queue.push(String(text));
      this.emit("queued", { text: String(text), position: this.queue.length });
      return "queued";
    }
    this._dispatch(String(text));
    return "sent";
  }

  // Actually write a turn to Claude's stdin.
  _dispatch(text) {
    this.busy = true;
    this.textThisTurn = false;
    const payload = JSON.stringify({ type: "user", message: { role: "user", content: String(text) } });
    this.proc.stdin.write(payload + "\n");
  }

  // Feed the next queued turn (if any) once the current one is done.
  _drainQueue() {
    if (this.busy || this.queue.length === 0 || !this.exists()) return;
    const next = this.queue.shift();
    this.emit("dequeued", { text: next, remaining: this.queue.length });
    this._dispatch(next);
  }

  // Best-effort interrupt of the in-flight turn. Also clears any queued turns
  // so a stop request doesn't get followed by stale queued messages.
  interrupt() {
    if (!this.exists()) return false;
    this.queue = [];
    try {
      this.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "int_" + Date.now(), request: { subtype: "interrupt" } }) + "\n");
      return true;
    } catch { return false; }
  }

  kill() {
    this.busy = false;
    this.queue = [];
    if (this.proc && !this.proc.killed) { try { this.proc.kill("SIGTERM"); } catch {} }
    this.proc = null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { ClaudeSession, sleep, ANCHOR };
