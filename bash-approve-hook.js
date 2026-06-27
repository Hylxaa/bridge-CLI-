#!/usr/bin/env node
// bash-approve-hook.js — Claude Code PreToolUse hook for Bash, Telegram bridge.
//
// Mirrors how Claude behaves in the terminal:
//   - Command already in the allow-list  -> run immediately (no prompt)
//   - New command                        -> ask via Telegram Approve/Deny
//   - "Approve & don't ask again"         -> command pattern saved to allow-list
//
// Runs AFTER `rtk hook claude` in the Bash matcher chain. RTK only rewrites the
// command (updatedInput); it returns no permission decision, so this hook is the
// sole gatekeeper for Bash. The command we inspect here is the ORIGINAL command
// (verified empirically — the gate receives the pre-rewrite command string).

const fs = require("fs");
const path = require("path");

const DIR = process.env.BRIDGE_PERM_DIR || "/tmp/claude-bridge-perm";
const SETTINGS = process.env.BRIDGE_ALLOW_FILE || require("path").join(require("os").homedir(), ".claude", "settings.local.json");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 min then auto-deny
const POLL_MS = 500;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,        // "allow" | "deny" | "ask"
      permissionDecisionReason: reason || "",
    },
  }));
  process.exit(0);
}

// Read the Bash() allow rules from settings.local.json.
function loadAllowRules() {
  try {
    const d = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    const arr = (d.permissions && d.permissions.allow) || [];
    return arr
      .filter((r) => typeof r === "string" && r.startsWith("Bash(") && r.endsWith(")"))
      .map((r) => r.slice(5, -1)); // inside Bash( ... )
  } catch {
    return [];
  }
}

// Does `cmd` match an allow rule? A rule may be an exact command or a prefix
// rule ending in ":*" (Claude's own convention, e.g. "git push:*").
function isAllowed(cmd, rules) {
  if (!cmd) return false;
  for (const rule of rules) {
    if (rule.endsWith(":*")) {
      const prefix = rule.slice(0, -2);
      if (cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix)) return true;
    } else if (cmd === rule) {
      return true;
    }
  }
  return false;
}

// Auto-allow read-only inspection commands (mirrors what Claude runs silently in
// the terminal). A command is "safe read-only" only if EVERY pipeline segment
// starts with a known read-only tool AND it contains no shell features that could
// write, delete, chain side effects, or run a subshell. Anything borderline falls
// through to the Approve/Deny card.
const SAFE_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "sed", "awk",
  "find", "stat", "file", "echo", "pwd", "whoami", "date", "cut", "sort", "uniq",
  "tr", "column", "diff", "tree", "du", "df", "basename", "dirname", "readlink",
  "realpath", "node", "python3", "jq", "xxd", "od", "nl", "tac", "less", "more",
]);
// shell features that can mutate state / escape the read-only assumption
const DANGER_RE = /[>$`]|>>|&&|\|\||;|\brm\b|\bmv\b|\bcp\b|\btee\b|\bdd\b|\btruncate\b|\bchmod\b|\bchown\b|\bmkdir\b|\brmdir\b|\btouch\b|\bln\b|\bgit\b|\bnpm\b|\bsystemctl\b|\bkill\b|\bcurl\b|\bwget\b|\bsudo\b|\bnpx\b/;

function isSafeReadonly(cmd) {
  if (!cmd) return false;
  // sed/awk with in-place edit flag is NOT read-only
  if (/\bsed\b[^|]*\s-i\b/.test(cmd) || /\bsed\b[^|]*-i[^|]*\s/.test(cmd)) return false;
  // strip quoted strings first so a `|`, `>` or `$` INSIDE a regex/arg (e.g.
  // grep "a\|b", awk "NR>100") isn't misread as a pipe / redirect / subshell.
  const bare = cmd.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (DANGER_RE.test(bare)) return false;
  // every pipeline segment must start with a known read-only tool
  const segs = bare.split("|").map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return false;
  for (const seg of segs) {
    const first = seg.split(/\s+/)[0];
    const bin = first.includes("/") ? first.split("/").pop() : first;
    if (!SAFE_CMDS.has(bin)) return false;
  }
  return true;
}

let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  let inp = {};
  try { inp = JSON.parse(buf); } catch {}
  const tool = inp.tool_name || "";
  const ti = inp.tool_input || {};
  const cmd = (ti.command || "").trim();

  // Only gate Bash. Anything else: let Claude's normal flow handle it.
  if (tool !== "Bash") out("ask", "");

  // Already approved before -> run silently, just like the terminal.
  const rules = loadAllowRules();
  if (isAllowed(cmd, rules)) out("allow", "in allow-list");

  // Read-only inspection (grep/sed/cat/head/...) -> auto-allow, no prompt.
  if (isSafeReadonly(cmd)) out("allow", "read-only inspection");

  // New command -> hand to bot.js for an Approve/Deny card.
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  const id = `${process.pid}_${Date.now()}`;
  const reqFile = path.join(DIR, `${id}.req`);
  const ansFile = path.join(DIR, `${id}.ans`);
  fs.writeFileSync(reqFile, JSON.stringify({ id, tool: "Bash", cmd, input: ti }));

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(ansFile)) {
      let ans = "deny";
      try { ans = fs.readFileSync(ansFile, "utf8").trim(); } catch {}
      try { fs.unlinkSync(ansFile); } catch {}
      try { fs.unlinkSync(reqFile); } catch {}
      // bot.js writes "allow" (once) or "always" (persist + allow) or "deny".
      if (ans === "allow" || ans === "always") {
        if (ans === "always") persistAllow(cmd);
        out("allow", "Approved via Telegram");
      }
      out("deny", "Denied via Telegram");
    }
    sleepSync(POLL_MS);
  }
  try { fs.unlinkSync(reqFile); } catch {}
  out("deny", "Approval timeout (5 min)");
});

// Append an exact Bash() rule for this command to settings.local.json so future
// runs of the same command skip the prompt (the "don't ask again" path).
function persistAllow(cmd) {
  if (!cmd) return;
  try {
    const d = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    d.permissions = d.permissions || {};
    d.permissions.allow = d.permissions.allow || [];
    const rule = `Bash(${cmd})`;
    if (!d.permissions.allow.includes(rule)) {
      d.permissions.allow.push(rule);
      fs.writeFileSync(SETTINGS, JSON.stringify(d, null, 2));
    }
  } catch {}
}
