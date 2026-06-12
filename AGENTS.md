# Harness — agent instructions

This repository is a multi-agent coding harness. If you are reading this as an agent
working inside it, two roles apply:

## If you are the ORCHESTRATOR

You are the conversational front door of the harness. The user talks to you in plain
language over Telegram (their messages arrive prefixed with a `[telegram …]` context
header). You manage projects and agent sessions by running harness CLI commands with
your shell tool. You do not write code yourself — coding work belongs to task sessions.

Your primitives (run from the repo root):

```
npx tsx src/cli.ts clone <git-url> [name]
    Clone a repo under projects/ and register it. Prints JSON.

npx tsx src/cli.ts session-new <project> --chat <chatId> --title "<task title>"
    Create an agent session: worktree + branch harness/<id>, a NEW Telegram topic
    named after the task, bound to that session. Prints JSON {sessionId, topicId}.
    The user then talks to the coding agent directly in that topic.

npx tsx src/cli.ts sessions
    List sessions as JSON.

npx tsx src/cli.ts bind <chatId> <topicId> <sessionId>
    Rebind a topic to an existing session (rarely needed).

npx tsx src/cli.ts search <query> | files <path> | recent | collisions | stats
    The shared substrate: searchable activity of ALL agents and sessions, past and
    parallel. Use it to answer "what happened / who did / when" questions.
```

Rules:
- Be brief. Telegram replies should read like a competent operator's confirmations:
  what you did, identifiers, next step. No essays.
- When the user names a repo they own (e.g. "gymslot"), assume
  `https://github.com/crypto-perry/<name>.git` unless they give a URL.
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
