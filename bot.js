// bot.js — Claude Code <-> Telegram bridge (LIVE stream-json mode).
// Chat with Claude Code from Telegram. No terminal, no screenshots: Claude
// streams clean structured events, we forward them as messages.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { ClaudeSession, sleep } = require("./session");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "").trim();
const DEFAULT_WORKDIR = process.env.DEFAULT_WORKDIR || process.env.HOME || "/root";

if (!TOKEN) { console.error("Missing TELEGRAM_BOT_TOKEN in .env"); process.exit(1); }
if (!ALLOWED) { console.error("Missing ALLOWED_CHAT_ID in .env"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ---- state ----
const sessions = new Map();   // chatId -> ClaudeSession
const workdirs = new Map();   // chatId -> current workdir
const models = new Map();     // chatId -> model alias
const efforts = new Map();    // chatId -> effort

// ---- persistent sessionId store ----
// Claude keeps the full transcript on disk; we only need to remember its
// session id so we can --resume the SAME conversation after a bridge restart.
// That's the whole "don't forget context on restart" fix — no daemon, no cloud,
// just one tiny JSON file.
const SESS_FILE = process.env.BRIDGE_SESS_FILE || require("path").join(__dirname, "sessions.json");
const resumeIds = new Map();  // chatId -> last sessionId (from disk)

function loadResumeIds() {
  try {
    const d = JSON.parse(fs.readFileSync(SESS_FILE, "utf8"));
    for (const [k, v] of Object.entries(d)) if (v) resumeIds.set(String(k), String(v));
  } catch {}
}
function saveResumeId(chatId, sid) {
  const id = String(chatId);
  if (sid) resumeIds.set(id, String(sid)); else resumeIds.delete(id);
  try {
    const obj = {};
    for (const [k, v] of resumeIds.entries()) obj[k] = v;
    fs.writeFileSync(SESS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}
loadResumeIds();

const MODELS = ["opus", "sonnet", "fable"];
const MODEL_LABELS = { opus: "opus 4.8", sonnet: "sonnet 4.6", fable: "fable 5" };
const modelLabel = (x) => MODEL_LABELS[x] || x;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "opus";
const DEFAULT_EFFORT = process.env.DEFAULT_EFFORT || "high";

function getModel(chatId) { return models.get(String(chatId)) || DEFAULT_MODEL; }
function getEffort(chatId) { return efforts.get(String(chatId)) || DEFAULT_EFFORT; }
function getWorkdir(chatId) { return workdirs.get(String(chatId)) || DEFAULT_WORKDIR; }
function authorized(msg) {
  return String(msg.chat.id) === ALLOWED || String(msg.from?.id) === ALLOWED;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert Claude's markdown prose to Telegram HTML. A markdown TABLE (pipe rows)
// or a fenced code block is rendered as monospace <pre> so columns stay aligned
// (Telegram's proportional font would otherwise break tables). Everything else
// becomes inline-formatted prose.
function mdInline(s) {
  let t = esc(s);
  // markdown headers (#, ##, ###...) -> bullet + bold, so they don't show raw
  t = t.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "• <b>$1</b>");
  t = t.replace(/`([^`\n]+?)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/__([^\n]+?)__/g, "<b>$1</b>");
  t = t.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
  t = t.replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=[^\w*]|$)/g, "$1<i>$2</i>");
  return t;
}

// Is this line part of a markdown table? ("| a | b |" or the "|---|---|" rule)
function isTableLine(l) {
  const t = l.trim();
  return /^\|.*\|$/.test(t) || /^\|?[\s:]*-{2,}[\s:|-]*\|/.test(t);
}

// Strip inline markdown noise (**bold**, `code`, __u__, ~~s~~) from a table cell
// so it doesn't show raw inside the rendered output.
function stripInlineMd(s) {
  return String(s)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

// Is this line a markdown table separator row? (|---|:--:|---|)
function isSepRow(t) {
  return /^[|\s:-]+$/.test(t) && /-/.test(t);
}

// Parse a block of table lines into rows of string cells. Merges continuation
// lines (a wrapped cell that spilled onto a line NOT starting with |) back into
// the previous row — Claude sometimes emits a table row split across 2 lines.
function parseTableRows(lines) {
  const merged = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^\|/.test(t)) merged.push(t);
    else if (merged.length) merged[merged.length - 1] += " " + t; // continuation
  }
  const rows = [];
  for (const ln of merged) {
    const inner = ln.replace(/^\|/, "").replace(/\|$/, "");
    if (isSepRow(ln)) { rows.push("SEP"); continue; }
    rows.push(inner.split("|").map((c) => stripInlineMd(c)));
  }
  return rows;
}

// Render a markdown table into clean Telegram messages.
//  • 2 columns  -> "label: value" blocks (best on a narrow phone screen)
//  • 3+ columns -> aligned monospace grid inside <pre>
// Returns [{ pre: bool, body: string }].
function renderTable(lines) {
  const rows = parseTableRows(lines);
  const dataRows = rows.filter((r) => r !== "SEP");
  if (!dataRows.length) return [{ pre: true, body: lines.join("\n") }];
  const header = dataRows[0];
  const ncols = Math.max(...dataRows.map((r) => r.length));
  // body = rows after the header (the separator row is already filtered out)
  const body = dataRows.slice(1);

  if (ncols <= 2) {
    const blocks = (body.length ? body : dataRows).map((r) => {
      const label = esc(r[0] || "");
      const val = esc((r.slice(1).join(" ") || "").trim());
      return val ? `<b>${label}</b>\n${val}` : `<b>${label}</b>`;
    });
    return [{ pre: false, body: blocks.join("\n\n") }];
  }

  // 3+ columns: try an aligned monospace grid, but only if it fits a phone
  // screen (~42 cols). A wide grid wraps and looks broken on mobile — so when
  // it's too wide (long description columns), fall back to stacked "cards":
  // each row becomes a bold first-cell title with "Header: value" lines under it.
  const all = [header, ...body];
  const widths = [];
  for (let c = 0; c < ncols; c++) {
    widths[c] = Math.max(...all.map((r) => String(r[c] || "").length));
  }
  const gridWidth = widths.reduce((a, b) => a + b, 0) + (ncols - 1) * 2;
  const PHONE_COLS = 42;

  if (gridWidth <= PHONE_COLS) {
    const fmt = (r) => r.map((c, i) => String(c || "").padEnd(widths[i])).join("  ");
    const sep = widths.map((w) => "-".repeat(w)).join("  ");
    return [{ pre: true, body: [fmt(header), sep, ...body.map(fmt)].join("\n") }];
  }

  // Too wide for a phone: stacked cards. First cell = title, remaining cells =
  // "Header: value" lines. Blank line between cards so it's easy to scan.
  const cards = (body.length ? body : dataRows).map((r) => {
    const title = esc(String(r[0] || "").trim());
    const subs = [];
    for (let c = 1; c < ncols; c++) {
      const h = esc(String(header[c] || `Col ${c + 1}`).trim());
      const v = esc(String(r[c] || "").trim());
      if (v) subs.push(`${h}: ${v}`);
    }
    return subs.length ? `<b>${title}</b>\n${subs.join("\n")}` : `<b>${title}</b>`;
  });
  return [{ pre: false, body: cards.join("\n\n") }];
}

const TG_LIMIT = 3800;

// Split a long string into <=LIMIT chunks on line boundaries.
function chunk(text) {
  const lines = String(text).split("\n");
  const out = [];
  let buf = "";
  for (const ln of lines) {
    if (ln.length > TG_LIMIT) {
      if (buf) { out.push(buf); buf = ""; }
      let l = ln;
      while (l.length > TG_LIMIT) { out.push(l.slice(0, TG_LIMIT)); l = l.slice(TG_LIMIT); }
      buf = l;
      continue;
    }
    if ((buf + (buf ? "\n" : "") + ln).length > TG_LIMIT) { out.push(buf); buf = ln; }
    else buf += (buf ? "\n" : "") + ln;
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

function sendPre(chatId, text) {
  let p = Promise.resolve();
  for (const c of chunk(text)) {
    p = p.then(() => bot.sendMessage(chatId, `<pre>${esc(c)}</pre>`, { parse_mode: "HTML" }).catch(() => {}));
  }
  return p;
}

// Bot API 10.1 Rich Messages (sendRichMessage). This is the ONLY path that
// renders native tables / task lists on supporting clients — send the RAW
// markdown (exact pipes), Telegram renders it. node-telegram-bot-api 0.66 has
// no sendRichMessage wrapper, so we hit the raw endpoint via _request, exactly
// like Hermes does via PTB do_api_request. Payload: { chat_id, rich_message:
// { markdown } }. Latches off after a capability error so we stop retrying.
let richDisabled = false;

async function sendRich(chatId, markdown) {
  if (richDisabled) return false;
  try {
    await bot._request("sendRichMessage", {
      form: {
        chat_id: chatId,
        rich_message: JSON.stringify({ markdown }),
      },
    });
    return true;
  } catch (e) {
    const msg = String(e && (e.message || e)).toLowerCase();
    // Endpoint missing on this Bot API server / PTB → latch off permanently.
    if (msg.includes("not found") || msg.includes("method not") || msg.includes("unknown method") || msg.includes("404")) {
      richDisabled = true;
    }
    return false;
  }
}


// Render Claude's prose. Markdown tables and ```fenced code``` become monospace
// <pre> (aligned columns / code), normal prose becomes inline-HTML text. We walk
// the text line by line, batching contiguous table/code runs vs prose runs.
async function sendProse(chatId, text) {
  const lines = String(text).split("\n");
  let mode = null;     // "table" | "fence" | "prose"
  let buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const lines = buf;
    const m = mode;
    buf = [];
    if (m === "table") {
      // Tables: try Bot API 10.1 Rich Messages first (RAW markdown → native
      // table render, same as Hermes). If rich isn't supported, fall back to
      // Hermes-style "cards" (bold title + "Header: value" lines) which read
      // cleanly on a phone — never raw pipes, never a wide monospace grid.
      const tbl = lines.join("\n").trim();
      if (!tbl) return;
      const ok = await sendRich(chatId, tbl);
      if (ok) return;
      for (const part of renderTable(lines)) {
        if (part.pre) await sendPre(chatId, part.body);
        else for (const c of chunk(part.body)) {
          await bot.sendMessage(chatId, c, { parse_mode: "HTML" }).catch(() => {});
        }
      }
      return;
    }
    const body = lines.join("\n").trim();
    if (!body) return;
    if (m === "fence") await sendPre(chatId, body);
    else {
      for (const c of chunk(body)) {
        await bot.sendMessage(chatId, mdInline(c), { parse_mode: "HTML" }).catch(() => {});
      }
    }
  };
  for (const raw of lines) {
    const ln = raw;
    if (/^\s*```/.test(ln)) {
      // fence toggle: flush current run, switch in/out of code mode
      if (mode === "fence") { await flush(); mode = null; }
      else { await flush(); mode = "fence"; }
      continue; // drop the ``` marker line itself
    }
    if (mode === "fence") { buf.push(ln); continue; }
    // Continuation: a non-blank line that doesn't start a new table row but
    // follows one is a wrapped table cell — keep it in the table run so the
    // parser can stitch it back, instead of flipping to prose mid-table.
    if (mode === "table" && ln.trim() && !isTableLine(ln) && !/^\s*#{1,6}\s/.test(ln)) {
      buf.push(ln);
      continue;
    }
    const t = isTableLine(ln) ? "table" : "prose";
    if (mode === null) mode = t;
    else if (t !== mode) { await flush(); mode = t; }
    buf.push(ln);
  }
  await flush();
}

// Tool-call label: show the user WHAT Claude is doing, live. A Bash command or
// file edit shows its key detail; other tools just name themselves.
function toolLabel(name, input) {
  const i = input || {};
  // AskUserQuestion: Claude is asking YOU something with options. The generic
  // label would hide the actual question, so render it in full — you answer in chat.
  if (name === "AskUserQuestion") {
    const qs = Array.isArray(i.questions) ? i.questions : (i.question ? [i] : []);
    if (qs.length) {
      const parts = qs.map((q) => {
        const head = q.header ? `<b>${esc(q.header)}</b>\n` : "";
        const qt = esc(q.question || q.prompt || "");
        const opts = Array.isArray(q.options)
          ? q.options.map((o, n) => {
              const label = typeof o === "string" ? o : (o.label || o.text || "");
              const desc = typeof o === "object" && o.description ? ` — ${o.description}` : "";
              return `  ${n + 1}. ${esc(label)}${esc(desc)}`;
            }).join("\n")
          : "";
        return `${head}❓ ${qt}${opts ? "\n" + opts : ""}`;
      });
      return `🙋 <b>Claude is asking:</b>\n\n${parts.join("\n\n")}\n\n<i>Reply in chat to answer.</i>`;
    }
  }
  if (name === "Bash" && i.command) return `🖥️ <code>${esc(String(i.command).slice(0, 300))}</code>`;
  if ((name === "Edit" || name === "Write" || name === "MultiEdit") && i.file_path)
    return `✏️ <b>${name}</b> <code>${esc(i.file_path)}</code>`;
  if (name === "Read" && i.file_path) return `📖 Read <code>${esc(i.file_path)}</code>`;
  if ((name === "Grep" || name === "Glob") && (i.pattern || i.query))
    return `🔎 ${name} <code>${esc(i.pattern || i.query)}</code>`;
  return `🔧 <b>${esc(name)}</b>`;
}

// Wire a session's live events to Telegram messages for this chat.
function wire(chatId, sess) {
  const id = String(chatId);
  sess.removeAllListeners("text");
  sess.removeAllListeners("tool");
  sess.removeAllListeners("toolresult");
  sess.removeAllListeners("done");
  sess.removeAllListeners("dequeued");
  sess.removeAllListeners("stderr");
  sess.removeAllListeners("error");

  sess.on("text", (txt) => {
    // Skip trivial/empty emissions (e.g. "...", ".", whitespace) — Claude
    // sometimes emits a filler dot as a pause/ack; sending it makes an ugly
    // "• • •" bubble in Telegram. Only forward text with real content.
    const stripped = String(txt).replace(/[\s.·•…]/g, "");
    if (!stripped) return;
    sendProse(id, txt);
  });
  sess.on("tool", ({ name, input }) => {
    bot.sendMessage(id, toolLabel(name, input), { parse_mode: "HTML" }).catch(() => {});
  });
  sess.on("toolresult", ({ text, isError }) => {
    const head = isError ? "⚠️ " : "";
    const trimmed = String(text).trim();
    // keep results short; long output collapses to first lines
    const shown = trimmed.length > 1500 ? trimmed.slice(0, 1500) + "\n…" : trimmed;
    bot.sendMessage(id, `${head}<pre>${esc(shown)}</pre>`, { parse_mode: "HTML" }).catch(() => {});
  });
  sess.on("done", () => { bot.sendChatAction(id, "typing").catch(() => {}); });
  sess.on("dequeued", ({ text, remaining }) => {
    const preview = String(text).length > 80 ? String(text).slice(0, 80) + "…" : String(text);
    const more = remaining > 0 ? ` (${remaining} more queued)` : "";
    plain(id, `▶️ Now running your queued message${more}:\n<i>${esc(preview)}</i>`);
    bot.sendChatAction(id, "typing").catch(() => {});
  });
  sess.on("stderr", (s) => console.error("[claude stderr]", s.slice(0, 200)));
  sess.on("error", (e) => bot.sendMessage(id, `❌ ${esc(e)}`).catch(() => {}));
  sess.on("exit", (code) => { if (code) console.error(`[claude exit ${code}] chat=${id}`); });
}

async function ensureSession(chatId) {
  const id = String(chatId);
  let s = sessions.get(id);
  if (s && s.exists()) return s;
  s = new ClaudeSession(id, getWorkdir(id), { model: getModel(id), effort: getEffort(id) });
  // persist the session id whenever Claude reports it, so a bridge restart can
  // --resume the same conversation (context survives restarts).
  s.on("session", (sid) => saveResumeId(id, sid));
  // resume the last conversation for this chat if we have one on disk
  const resumeId = resumeIds.get(id) || null;
  await s.start(resumeId);
  wire(id, s);
  sessions.set(id, s);
  return s;
}

function plain(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: "HTML", ...extra }).catch(() => {});
}

// ---- settings UI ----
function settingsKeyboard(chatId) {
  const m = getModel(chatId), e = getEffort(chatId);
  const modelRow = MODELS.map((x) => ({ text: `${x === m ? "✅ " : ""}${modelLabel(x)}`, callback_data: `set:model:${x}` }));
  const effortRow = EFFORTS.map((x) => ({ text: `${x === e ? "✅ " : ""}${x}`, callback_data: `set:effort:${x}` }));
  return { inline_keyboard: [
    [{ text: "── Model ──", callback_data: "set:noop" }], modelRow,
    [{ text: "── Effort ──", callback_data: "set:noop" }], effortRow,
    [{ text: "🗑️ Delete", callback_data: "set:delete" }],
  ] };
}
function settingsText(chatId) {
  return "⚙️ <b>Settings</b>\n\n" +
    `🧠 Model: <code>${esc(modelLabel(getModel(chatId)))}</code>\n` +
    `⚡ Effort: <code>${esc(getEffort(chatId))}</code>\n\n` +
    "Pick below. Changing model/effort restarts the Claude session (context is preserved).";
}

bot.onText(/^\/settings/, (msg) => {
  if (!authorized(msg)) return;
  plain(msg.chat.id, settingsText(msg.chat.id), { reply_markup: settingsKeyboard(msg.chat.id) });
});

bot.onText(/^\/start/, (msg) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  plain(id, "🤖 <b>Claude Bridge</b> (live)\n\n" +
    "Chat with Claude Code here. Edits and commands run live and are shown as they happen.\n\n" +
    `📁 Folder: <code>${esc(getWorkdir(id))}</code>\n\n` +
    "<b>Commands:</b>\n/settings — model &amp; effort\n/cd &lt;path&gt; — add project folder\n/new — fresh session\n/interrupt — stop current turn\n/stop — kill session\n/status — session status\n\nSlash commands like /compact /clear are forwarded to Claude.");
});

bot.onText(/^\/cd(?:\s+(.+))?/, async (msg, m) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  const p = (m[1] || "").trim();
  if (!p) return plain(id, `📁 Current folder: <code>${esc(getWorkdir(id))}</code>`);
  if (!fs.existsSync(p)) return plain(id, `❌ Folder not found: <code>${esc(p)}</code>`);
  workdirs.set(String(id), p);
  const s = sessions.get(String(id));
  if (s) s.kill();
  sessions.delete(String(id));
  plain(id, `✅ Project folder set: <code>${esc(p)}</code>\nClaude can read/edit/run here.`);
});

bot.onText(/^\/new/, async (msg) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  const s = sessions.get(String(id));
  if (s) s.kill();
  sessions.delete(String(id));
  saveResumeId(id, null); // forget stored session -> next message starts fresh
  plain(id, "🔄 Old session closed. A new one opens on your next message.");
});

bot.onText(/^\/(interrupt|esc)\b/, async (msg) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  const s = sessions.get(String(id));
  if (!s || !s.exists()) return plain(id, "⚪ No active session.");
  s.interrupt();
  plain(id, "⏸️ Interrupt sent.");
});

bot.onText(/^\/stop/, async (msg) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  const s = sessions.get(String(id));
  if (s) s.kill();
  sessions.delete(String(id));
  plain(id, "⏹️ Claude session stopped.");
});

// Estimate the live conversation size for a chat. Claude resumes the full
// transcript on every turn, so a long-lived session re-sends all of it as input
// each message — this is the main bridge cost driver. We read the resumed
// session's .jsonl transcript size so /status can warn when it's time for /new.
function contextSizeInfo(chatId) {
  const sid = resumeIds.get(String(chatId));
  if (!sid) return null;
  const os = require("os");
  const dir = require("path").join(os.homedir(), ".claude", "projects");
  // transcript filename is <sessionId>.jsonl, project subdir varies — search
  let bytes = 0;
  try {
    for (const proj of fs.readdirSync(dir)) {
      const f = require("path").join(dir, proj, `${sid}.jsonl`);
      if (fs.existsSync(f)) { bytes = fs.statSync(f).size; break; }
    }
  } catch {}
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  const approxTokens = Math.round(bytes / 4); // rough: ~4 chars/token
  let flag = "🟢 light";
  if (mb >= 1.5) flag = "🔴 heavy — /new recommended";
  else if (mb >= 0.7) flag = "🟡 growing";
  return { mb, approxTokens, flag };
}

bot.onText(/^\/status/, async (msg) => {
  if (!authorized(msg)) return;
  const id = msg.chat.id;
  const s = sessions.get(String(id));
  const alive = s && s.exists();
  const ctx = contextSizeInfo(id);
  const ctxLine = ctx
    ? `\nContext: ${ctx.mb.toFixed(2)} MB (~${ctx.approxTokens.toLocaleString()} tok) ${ctx.flag}`
    : "\nContext: fresh (no resumed transcript)";
  plain(id, `📊 <b>Status</b>\nSession: ${alive ? "🟢 alive" : "⚪ off"}\nFolder: <code>${esc(getWorkdir(id))}</code>\nWorking: ${alive && s.busy ? "yes" : "no"}\nQueued: ${alive ? (s.queue ? s.queue.length : 0) : 0}\nModel: <code>${esc(modelLabel(getModel(id)))}</code>${ctxLine}`);
});

// ---- free text -> Claude ----
bot.on("message", async (msg) => {
  if (!authorized(msg)) {
    if (msg.text) bot.sendMessage(msg.chat.id, "⛔ This bot is private.").catch(() => {});
    return;
  }
  const text = msg.text;
  if (!text) return;
  const BOT_CMDS = /^\/(start|settings|cd|new|stop|status|interrupt|esc)\b/;
  if (text.startsWith("/") && BOT_CMDS.test(text)) return; // handled above
  const id = msg.chat.id;
  try {
    const sess = await ensureSession(id);
    bot.sendChatAction(id, "typing").catch(() => {});
    const r = sess.sendUser(text);
    if (r === "queued") {
      const pos = sess.queue.length;
      plain(id, `📥 Queued (#${pos}). Claude is still working — I'll send this when the current task finishes. /interrupt to skip ahead.`);
    }
  } catch (e) {
    plain(id, `❌ Error: ${esc(e.message || String(e))}`);
  }
});

// ---- settings buttons ----
bot.on("callback_query", async (q) => {
  const id = q.message.chat.id;
  if (String(id) !== ALLOWED && String(q.from?.id) !== ALLOWED) {
    return bot.answerCallbackQuery(q.id, { text: "⛔" }).catch(() => {});
  }
  if (!q.data || (!q.data.startsWith("set:") && !q.data.startsWith("perm:"))) return bot.answerCallbackQuery(q.id).catch(() => {});

  // ---- approve/deny (Bash command or file edit) ----
  if (q.data.startsWith("perm:")) {
    const [, decision, reqId] = q.data.split(":");
    // decision: "allow" (once) | "always" (persist + allow) | "deny"
    const ans = decision === "always" ? "always" : decision === "allow" ? "allow" : "deny";
    answerPerm(reqId, ans);
    const toast = ans === "always" ? "Approved (always)" : ans === "allow" ? "Approved" : "Denied";
    await bot.answerCallbackQuery(q.id, { text: toast }).catch(() => {});
    const msgTxt =
      ans === "always" ? "✅ <b>Approved &amp; won't ask again</b> — added to allow-list."
      : ans === "allow" ? "✅ <b>Approved</b> — running."
      : "🚫 <b>Denied</b> — cancelled.";
    await bot.editMessageText(msgTxt, {
      chat_id: id, message_id: q.message.message_id, parse_mode: "HTML",
    }).catch(() => {});
    return;
  }

  const [, kind, val] = q.data.split(":");
  if (kind === "noop") return bot.answerCallbackQuery(q.id).catch(() => {});
  if (kind === "delete") {
    await bot.answerCallbackQuery(q.id, { text: "deleted" }).catch(() => {});
    return bot.deleteMessage(id, q.message.message_id).catch(() => {});
  }
  if (kind === "model" && MODELS.includes(val)) models.set(String(id), val);
  if (kind === "effort" && EFFORTS.includes(val)) efforts.set(String(id), val);
  const toastTxt = kind === "model" ? modelLabel(val) : val;
  await bot.answerCallbackQuery(q.id, { text: `${kind}: ${toastTxt}` }).catch(() => {});
  // restart session so the new model/effort applies. We DON'T clear the
  // stored resumeId, so ensureSession() will --resume the SAME conversation —
  // changing model/effort mid-chat keeps full context.
  const old = sessions.get(String(id));
  if (old) old.kill();
  sessions.delete(String(id));
  await bot.editMessageText(settingsText(id), {
    chat_id: id, message_id: q.message.message_id, parse_mode: "HTML",
    reply_markup: settingsKeyboard(id),
  }).catch(() => {});
});

bot.on("polling_error", (e) => console.error("polling_error:", e.code || e.message));
startPermWatcher();
console.log("Claude Bridge (live) running. Allowed chat:", ALLOWED);

// Restart marker: tell the chat the bridge just came back up, so a restart is
// never silent. Context is preserved (sessions --resume on next message).
bot.sendMessage(
  ALLOWED,
  `♻️ <b>Bridge restarted</b>\nModel: <code>${esc(modelLabel(DEFAULT_MODEL))}</code>\nContext preserved — just keep chatting.`,
  { parse_mode: "HTML" }
).catch(() => {});

// ---- approval bridge (file-based handshake with approve-hook.js) ----
const PERM_DIR = process.env.BRIDGE_PERM_DIR || "/tmp/claude-bridge-perm";
const seenReq = new Set();          // request ids already shown
const reqMsg = new Map();           // request id -> telegram message_id

function permToolLabel(tool, file, input) {
  if (tool === "Bash") {
    const cmd = (input && input.command) || "";
    return `🖥️ <code>${esc(String(cmd).slice(0, 400))}</code>`;
  }
  const i = input || {};
  // helper: clamp a block so a big edit doesn't flood Telegram
  const clip = (s, n) => {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "\n…(" + (s.length - n) + " more chars)" : s;
  };
  if (tool === "Edit") {
    // show what changes: old -> new, so you approve seeing the actual diff
    const oldS = clip(i.old_string, 600);
    const newS = clip(i.new_string, 600);
    return `✏️ <b>Edit</b> <code>${esc(file)}</code>\n` +
      `<b>− old:</b>\n<pre>${esc(oldS)}</pre>` +
      `<b>+ new:</b>\n<pre>${esc(newS)}</pre>`;
  }
  if (tool === "MultiEdit") {
    const edits = Array.isArray(i.edits) ? i.edits : [];
    let body = `✏️ <b>MultiEdit</b> <code>${esc(file)}</code> · ${edits.length} change(s)\n`;
    edits.slice(0, 4).forEach((e, idx) => {
      body += `\n<b>[${idx + 1}] − old:</b>\n<pre>${esc(clip(e.old_string, 300))}</pre>` +
        `<b>+ new:</b>\n<pre>${esc(clip(e.new_string, 300))}</pre>`;
    });
    if (edits.length > 4) body += `\n…(+${edits.length - 4} more edits)`;
    return body;
  }
  if (tool === "Write") {
    // show the content being written (clamped)
    return `📝 <b>Write</b> <code>${esc(file)}</code>\n<pre>${esc(clip(i.content, 900))}</pre>`;
  }
  if (tool === "NotebookEdit") return `📓 <b>NotebookEdit</b> <code>${esc(file)}</code>`;
  return `🔧 <b>${esc(tool)}</b> <code>${esc(file)}</code>`;
}

// Poll the pending-request dir; show an Approve/Deny card per new request.
// Bash commands get a 3rd button ("Approve & don't ask again") that persists the
// command to the allow-list — mirroring Claude's terminal prompt. File edits keep
// the simple 2-button Approve/Deny.
function startPermWatcher() {
  try { fs.mkdirSync(PERM_DIR, { recursive: true }); } catch {}
  setInterval(() => {
    let files = [];
    try { files = fs.readdirSync(PERM_DIR).filter((f) => f.endsWith(".req")); } catch { return; }
    for (const f of files) {
      const id = f.replace(/\.req$/, "");
      if (seenReq.has(id)) continue;
      seenReq.add(id);
      let req = {};
      try { req = JSON.parse(fs.readFileSync(require("path").join(PERM_DIR, f), "utf8")); } catch { continue; }
      const isBash = req.tool === "Bash";
      const label = permToolLabel(req.tool, req.file, req.input);
      const title = isBash ? "🔐 <b>Claude requests permission to run a command</b>" : "🔐 <b>Claude requests permission to edit a file</b>";
      const buttons = isBash
        ? [
            [{ text: "✅ Approve", callback_data: `perm:allow:${id}` }],
            [{ text: "♾️ Approve & don't ask again", callback_data: `perm:always:${id}` }],
            [{ text: "🚫 Deny", callback_data: `perm:deny:${id}` }],
          ]
        : [[
            { text: "✅ Approve", callback_data: `perm:allow:${id}` },
            { text: "🚫 Deny", callback_data: `perm:deny:${id}` },
          ]];
      bot.sendMessage(ALLOWED, `${title}\n${label}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      }).then((m) => { if (m) reqMsg.set(id, m.message_id); }).catch(() => {});
    }
  }, 700);
}

function answerPerm(id, decision) {
  try { fs.writeFileSync(require("path").join(PERM_DIR, `${id}.ans`), decision); } catch {}
}
