#!/usr/bin/env bash
# One-shot setup on a new machine (macOS).
# Layout it creates/expects:  <workspace>/harness  (this repo)
#                             <workspace>/projects, <workspace>/workspaces, <workspace>/.harness
set -euo pipefail

HARNESS="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="$(dirname "$HARNESS")"
NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"

echo "harness:   $HARNESS"
echo "workspace: $WORKSPACE"
echo "node:      $NODE"

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then echo "ERROR: node >= 22 required"; exit 1; fi

cd "$HARNESS"
npm install

mkdir -p "$WORKSPACE/.harness" "$WORKSPACE/projects" "$WORKSPACE/workspaces"
# the orchestrator reads AGENTS.md at the workspace root
[ -e "$WORKSPACE/AGENTS.md" ] || ln -s harness/AGENTS.md "$WORKSPACE/AGENTS.md"
# workspace-level MCP registration for IDE sessions
if [ ! -e "$WORKSPACE/.mcp.json" ]; then
  sed "s#__HARNESS__#$HARNESS#" "$HARNESS/.mcp.json" > "$WORKSPACE/.mcp.json" 2>/dev/null || cp "$HARNESS/.mcp.json" "$WORKSPACE/.mcp.json"
fi

if [ ! -f "$HARNESS/.env" ]; then
  read -r -p "TELEGRAM_BOT_TOKEN: " token
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" > "$HARNESS/.env"
  echo "wrote .env (add ANTHROPIC_API_KEY=... later for the claude worker, if needed)"
fi

# vendor CLI auth — interactive, idempotent
node "$HARNESS/node_modules/@openai/codex/bin/codex.js" login status 2>/dev/null || \
  echo "NOTE: run 'node node_modules/@openai/codex/bin/codex.js login' to authenticate Codex"

# launchd service
PLIST="$HOME/Library/LaunchAgents/com.harness.telegram-bot.plist"
sed -e "s#__NODE__#$NODE#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__HARNESS__#$HARNESS#g" \
    -e "s#__WORKSPACE__#$WORKSPACE#g" \
    -e "s#__HOME__#$HOME#g" \
    "$HARNESS/launchd/com.harness.telegram-bot.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.harness.telegram-bot" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "bot service installed and started — log: $WORKSPACE/.harness/bot.log"
echo
echo "REMINDER: the bot must run on only ONE machine at a time (telegram getUpdates conflict)."
echo "          On the old machine: launchctl bootout gui/\$(id -u)/com.harness.telegram-bot"
