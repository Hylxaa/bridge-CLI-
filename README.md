# 🤖 Claude Telegram Bridge

Talk to **Claude Code** straight from Telegram. No terminal, no SSH, no typing `claude`. The session stays alive — chat back and forth and Claude keeps the context.

## Why I built this

I call it **Bridge CLI** — a way to use my Claude account without ever opening a terminal.

Why not just use an agent like Hermes/OpenClaw through 9router? Because that burns usage fast. Bridge talks to the Claude CLI directly, so usage stays normal, plus it ships with built-in **RTK** and a few tweaks of my own to make every chat cheaper.

## How it works

```
Phone (Telegram) → Telegram servers → Bot (on your VPS) → Claude Code CLI (same VPS)
```

The bot runs 24/7 on your VPS. You chat from your phone, the bot relays it to Claude over a live `stream-json` session, and the structured reply comes back to Telegram. Claude login is persistent (until `claude auth logout`).

Context survives restarts: the bot stores Claude's session id on disk and `--resume`s the same conversation after a restart, so it never goes amnesiac.

## Setup (plug-and-play)

1. **Create a bot** with [@BotFather](https://t.me/BotFather) → get the token
2. **Find your chat id** with [@userinfobot](https://t.me/userinfobot)
3. Copy `.env.example` → `.env` and fill in:
   ```
   TELEGRAM_BOT_TOKEN=your_botfather_token
   ALLOWED_CHAT_ID=your_numeric_id
   ```
   `DEFAULT_WORKDIR` is optional (defaults to your home directory).
4. `npm install`
5. Run: `node bot.js` (or use the systemd unit below for 24/7)

That's it — no paths to edit. The bridge auto-detects its own location and your home directory, and generates its Claude settings file on start.

## Commands

| Command | What it does |
|---|---|
| (any text) | Goes straight to Claude — interactive chat |
| `/start` | Menu + help |
| `/settings` | Pick model & reasoning effort (restarts session, keeps context) |
| `/cd <path>` | Switch project folder |
| `/new` | Fresh Claude session (reset context) — use when `/status` hits 🔴 |
| `/interrupt` | Stop the current turn |
| `/stop` | Kill the session |
| `/status` | **The one to watch** — session state, folder, model, queue, and context size: 🟢 light · 🟡 growing · 🔴 heavy. Bigger session = pricier turns, so check it to avoid quietly burning usage |

Slash commands the bot doesn't own (e.g. `/compact`, `/clear`) are forwarded to Claude.

**Message queue** — send a message while Claude is still working and it queues (📥), then runs in order when the current turn finishes. `/interrupt` skips the line.

## Approve / Deny

The bridge mirrors Claude's terminal permission flow:

- **Read-only commands** (`grep`, `sed`, `cat`, `head`, `ls`, `awk`, ...) run automatically — no prompt.
- **New / mutating commands** (write, `rm`, `git push`, `systemctl`, `curl`, ...) send Approve / Deny buttons to Telegram.
- Bash prompts get a third button — **♾️ Approve & don't ask again** — which adds the command to the allow-list so it runs silently next time.
- File edits (`Write`/`Edit`/`MultiEdit`) always send a simple Approve / Deny.

The allow-list lives in `~/.claude/settings.local.json` — the same one Claude uses in the terminal.

## What makes it cheaper

Two things trim usage without dumbing Claude down:

- **Built-in RTK** — if the [`rtk`](https://github.com/) token-saver CLI is installed, the bridge chains it before the Bash gate so command output comes back smaller. Claude reads less, spends fewer tokens. Not installed? It's skipped automatically — the bridge works the same, just without the savings.
- **Output efficiency** — every session gets a built-in instruction that strips the wasted output tokens: no preamble, no restating your question, no wrap-up filler. It cuts the junk words, **not the thinking** — hard problems still get full reasoning.

## Run 24/7 (systemd)

Create `/etc/systemd/system/claude-bridge.service`:

```ini
[Unit]
Description=Claude Telegram Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/claude-telegram-bridge
ExecStart=/usr/bin/node /path/to/claude-telegram-bridge/bot.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then:
```bash
systemctl daemon-reload
systemctl enable --now claude-bridge.service
systemctl status claude-bridge.service
```

## Security

- **Bot is locked to `ALLOWED_CHAT_ID`** — anyone else who messages it is rejected.
- The bot can run anything on your VPS through Claude. Never share the token and never set `ALLOWED_CHAT_ID` to a public chat.
- Approval prompts are on (not auto-approve), so you stay in control of every mutating action.

## Files

- `bot.js` — Telegram handler, commands, access lock, approve/deny UI, session persistence
- `session.js` — live Claude `stream-json` session manager, generates the settings file
- `approve-hook.js` — PreToolUse hook for file edits (Write/Edit/MultiEdit)
- `bash-approve-hook.js` — PreToolUse hook for Bash (allow-list + read-only auto-allow + Telegram gate)

## Notes

- Claude streams structured JSON events (`--output-format stream-json`), so output is clean — no screen-scraping. Very long output is auto-split at ~3800 chars per Telegram message.
- `bridge-settings.json` and `sessions.json` are generated at runtime and gitignored.
