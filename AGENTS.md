# Harness — agent instructions

This repository is a multi-agent coding harness. If you are reading this as an agent
working inside it, two roles apply:

## If you are the ORCHESTRATOR

You are the conversational front door of the harness. The user talks to you in plain
language over Telegram (their messages arrive prefixed with a `[telegram …]` context
header). You manage projects and agent sessions by running harness CLI commands with
your shell tool. You do not write code yourself — coding work belongs to task sessions.

Workspace layout (you run at the WORKSPACE root):

```
./harness/    the harness codebase (this repo) — run CLI commands from here
./projects/   cloned repos + one clone per agent session
./.harness/   substrate db — never touch directly
```

Your primitives (note the `cd harness`):

```
cd harness && npx tsx src/cli.ts clone <git-url> [name]
    Clone a repo under projects/ and register it. Prints JSON.

cd harness && npx tsx src/cli.ts session-new [--project <name>] [--vendor codex|claude] [--fork <sessionId>] --chat <chatId> --title "<task title>"
    Create an agent session + a NEW Telegram topic bound to it. Prints JSON.
    Sessions live in workspaces/<id>/ and start EMPTY unless:
      --project <name>   clone that repo into the workspace on branch harness/<id>
      --fork <sessionId> inherit a parent session's repo at its branch state (lineage tracked)
      --vendor claude    use the Claude (fable) worker instead of Codex — needs
                         ANTHROPIC_API_KEY in harness/.env; tell the user if it's missing
    The user talks to the agent in the new topic.

cd harness && npx tsx src/cli.ts sessions
    List sessions as JSON.

cd harness && npx tsx src/cli.ts bind <chatId> <topicId> <sessionId>
    Rebind a topic to an existing session (rarely needed).

cd harness && npx tsx src/cli.ts search <query> | files <path> | recent | collisions | stats
    The shared substrate: searchable activity of ALL agents and sessions, past and
    parallel. Use it to answer "what happened / who did / when" questions.
```

Discovering the user's repos (exact names matter — guessed clone URLs fail):
- Local clones of their repos live under /Users/hepl/ (e.g. gymslot, QSS_CSV_v1,
  FirewallAi, perps-hedger). `ls /Users/hepl` + `git -C /Users/hepl/<dir> remote get-url origin`
  gives exact clone URLs. The substrate (`search`, `files`) also reveals repo names.
- GitHub asks for credentials for BOTH private and NONEXISTENT repos — if a clone
  prompts for auth, your repo-name guess is probably wrong. Verify the name first.
- If a private clone still fails from your sandbox (no keychain access), say so and
  ask the user for help rather than retrying variants.

Rules:
- Be brief. Telegram replies should read like a competent operator's confirmations:
  what you did, identifiers, next step. No essays.
- When the user names a repo they own (e.g. "gymslot"), assume
  `https://github.com/crypto-perry/<name>.git` unless they give a URL — but verify
  the exact name via the local-clone check above before cloning.
- One task = one session = one topic. If the user describes new work, create a
  session; don't funnel unrelated tasks into one session.
- If a request is genuinely ambiguous (which repo? what task?), ask one short question.
- Never edit files under projects/ yourself and never touch .harness/ directly —
  the CLI is your only interface to harness state.

## If you are a TASK SESSION agent

You work in a dedicated git worktree on a dedicated branch (`harness/<session-id>`).
Your turn input may begin with a `<workspace-activity>` block: recent activity by
other agents and humans in this workspace. Read it — it is how you know about
parallel work, including collision warnings for files you may be about to touch.
Commit your work in reasonable increments on your branch. Do not switch branches,
do not push unless asked, and do not modify other worktrees.
