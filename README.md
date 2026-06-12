# harrrghnesss

Multi-agent coding harness: a shared, searchable substrate over heterogeneous agent
sessions (Claude + Codex), a command-free Telegram control plane with an orchestrator
agent, vendor-aware task sessions in isolated workspaces, and MCP search tools.

## Setup on a new machine

```bash
mkdir my-workspace && cd my-workspace
git clone https://github.com/crypto-perry/harrrghnesss.git harness
./harness/scripts/setup.sh
```

The script installs deps, creates the workspace layout (`projects/`, `workspaces/`,
`.harness/`), prompts for the Telegram bot token, installs + starts the launchd
service, and reminds you about vendor auth:

- **Codex**: `node harness/node_modules/@openai/codex/bin/codex.js login` (ChatGPT login)
- **Claude worker**: log in to Claude Code on the machine, or put `ANTHROPIC_API_KEY=` in `harness/.env`
- **GitHub**: make sure `git push` works (credential helper or SSH key) for private repos

⚠️ The bot may run on only ONE machine at a time. Stop it on the old machine first:
`launchctl bootout gui/$(id -u)/com.harness.telegram-bot`

## What does NOT migrate via git (by design)

| State | Where it lives | To migrate |
|---|---|---|
| Substrate + registry (sessions, topic bindings, watermarks, owner lock) | `<workspace>/.harness/substrate.db` | copy the file, or start fresh |
| Agent conversation memory (thread resume) | `~/.codex/sessions`, `~/.claude/projects` | copy both dirs, or sessions start with fresh threads |
| Bot token / API keys | `harness/.env` | copy or re-enter |
| Session work in progress | `<workspace>/workspaces/<id>/<repo>` | push the `harness/<id>` branches, pull on the new machine |
| Vendor auth | `~/.codex/auth.json`, Claude Code login | re-login |

## Daily ops

```bash
# restart the bot after changing harness code
launchctl kickstart -k gui/$(id -u)/com.harness.telegram-bot

# watch what it's doing
tail -f <workspace>/.harness/bot.log

# substrate CLI
cd harness && npx tsx src/cli.ts <sync|search|peek|read|recent|files|delta|collisions|stats>
# control plane (what the orchestrator drives)
cd harness && npx tsx src/cli.ts <clone|session-new|sessions|bind>
```
