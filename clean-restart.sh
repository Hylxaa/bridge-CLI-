#!/bin/bash
# Restart the bridge cleanly and verify only ONE instance runs from this folder.
# Path-agnostic: works wherever you cloned the repo.
DIR="$(cd "$(dirname "$0")" && pwd)"

systemctl stop claude-bridge.service
sleep 2
# kill ALL node processes whose cwd is THIS bridge folder (other bots stay safe, different cwd)
for P in $(pgrep -f "bot.js"); do
  CWD=$(readlink /proc/$P/cwd 2>/dev/null)
  if [ "$CWD" = "$DIR" ]; then
    kill -9 "$P" 2>/dev/null
  fi
done
sleep 2
systemctl start claude-bridge.service
sleep 5
echo "=== MainPID ==="
systemctl show claude-bridge.service -p MainPID --value
echo "=== bridge instances ==="
C=0
for P in $(pgrep -f "bot.js"); do
  CWD=$(readlink /proc/$P/cwd 2>/dev/null)
  if [ "$CWD" = "$DIR" ]; then
    echo "PID $P ppid=$(awk '/PPid/{print $2}' /proc/$P/status)"
    C=$((C+1))
  fi
done
echo "bridge_count=$C"
echo "=== log ==="
tail -3 "$DIR/bot.log" 2>/dev/null
