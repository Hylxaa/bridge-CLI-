#!/usr/bin/env bash
# install.sh — one-shot setup for the Claude Telegram Bridge.
# Installs deps, checks prerequisites, and (optionally) installs a systemd unit
# with the correct absolute paths auto-filled. Safe to re-run.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==> Claude Telegram Bridge installer"
echo "    repo: $DIR"

# 1. prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js first."; exit 1; }
command -v claude >/dev/null 2>&1 || echo "WARN: 'claude' CLI not found in PATH — install + log in before running."
command -v rtk >/dev/null 2>&1 && echo "    rtk found -> token-saver will be used" || echo "    rtk not found -> skipped (bridge still works)"

# 2. deps
echo "==> npm install"
npm install --silent

# 3. .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example — EDIT IT NOW:"
  echo "    TELEGRAM_BOT_TOKEN= (from @BotFather)"
  echo "    ALLOWED_CHAT_ID=    (from @userinfobot)"
else
  echo "==> .env already exists, left untouched"
fi

# 4. optional systemd unit
if [ "${1:-}" = "--systemd" ]; then
  NODE_BIN="$(command -v node)"
  UNIT=/etc/systemd/system/claude-bridge.service
  echo "==> Writing systemd unit to $UNIT"
  cat > "$UNIT" <<EOF
[Unit]
Description=Claude Telegram Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/bot.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  echo "==> Done. Start with: systemctl enable --now claude-bridge.service"
else
  echo "==> Done. Run with: node bot.js"
  echo "    (or re-run: ./install.sh --systemd  to install a 24/7 service)"
fi
