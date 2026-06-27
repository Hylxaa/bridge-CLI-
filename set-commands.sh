#!/bin/bash
cd "$(cd "$(dirname "$0")" && pwd)"
TOKEN=$(node -e 'require("dotenv").config(); process.stdout.write(process.env.TELEGRAM_BOT_TOKEN||"")')
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"commands":[
{"command":"start","description":"Start / help"},
{"command":"settings","description":"Pick model and effort"},
{"command":"cd","description":"Change project folder"},
{"command":"new","description":"Fresh Claude session (reset)"},
{"command":"interrupt","description":"Send Esc (stop Claude)"},
{"command":"status","description":"Session status"},
{"command":"raw","description":"View Claude raw screen"},
{"command":"stop","description":"Kill session"}
]}
JSON
echo ""
echo "=== verify ==="
curl -s "https://api.telegram.org/bot${TOKEN}/getMyCommands"
