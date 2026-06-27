#!/usr/bin/env node
// approve-hook.js — Claude Code PreToolUse hook for the Telegram bridge.
//
// Fires before a file-mutating tool (Write/Edit/MultiEdit) runs. It writes a
// "pending request" file that bot.js watches, then BLOCKS (polls) until bot.js
// writes a decision file (the user pressed Approve/Deny in Telegram). It then
// returns allow/deny to Claude. This recreates the Hermes-style approve/deny
// flow on top of the live stream-json session.
//
// Bash is intentionally NOT matched here (RTK's own Bash hook stays untouched).

const fs = require("fs");
const path = require("path");

const DIR = process.env.BRIDGE_PERM_DIR || "/tmp/claude-bridge-perm";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 min then auto-deny
const POLL_MS = 500;

function sleepSync(ms) {
  const end = Date.now() + ms;
  // busy-wait is fine: the hook process is short-lived and idle-blocking
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,           // "allow" | "deny"
      permissionDecisionReason: reason || "",
    },
  }));
  process.exit(0);
}

let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  let inp = {};
  try { inp = JSON.parse(buf); } catch {}
  const tool = inp.tool_name || "";
  const ti = inp.tool_input || {};
  const file = ti.file_path || ti.path || "";

  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  const id = `${process.pid}_${Date.now()}`;
  const reqFile = path.join(DIR, `${id}.req`);
  const ansFile = path.join(DIR, `${id}.ans`);

  // hand the request to bot.js
  fs.writeFileSync(reqFile, JSON.stringify({ id, tool, file, input: ti }));

  // block until bot.js answers (or timeout)
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(ansFile)) {
      let ans = "deny";
      try { ans = fs.readFileSync(ansFile, "utf8").trim(); } catch {}
      try { fs.unlinkSync(ansFile); } catch {}
      try { fs.unlinkSync(reqFile); } catch {}
      if (ans === "allow") out("allow", "Approved via Telegram");
      out("deny", "Denied via Telegram");
    }
    sleepSync(POLL_MS);
  }
  try { fs.unlinkSync(reqFile); } catch {}
  out("deny", "Approval timeout (5 min)");
});
