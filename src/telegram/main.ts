#!/usr/bin/env node
import { openDb } from "../substrate/db.js";
import { Registry } from "../core/registry.js";
import { CodexWorker } from "../agent/codex.js";
import { Orchestrator } from "../agent/orchestrator.js";
import { DB_PATH, WORKSPACE_ROOT, loadEnv } from "../core/paths.js";
import { createBot } from "./bot.js";

loadEnv();

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN missing — set it in .env");
  process.exit(1);
}

const db = openDb(DB_PATH);
const registry = new Registry(db);

// a fresh process has no turns in flight — any 'running' status is a stale leftover
// from a previous process dying mid-turn, and would bounce every new message
registry.clearStaleRunning();
const worker = new CodexWorker(db, registry);
// the orchestrator works at WORKSPACE level: it sees harness/, projects/, AGENTS.md (symlink)
const orchestrator = new Orchestrator(registry, WORKSPACE_ROOT);

const bot = createBot({ token, registry, worker, orchestrator });

bot.catch((err) => console.error("bot error:", err.error));

console.log("harness telegram bot starting (long polling)…");
await bot.start({
  onStart: (me) => console.log(`@${me.username} is live — /start in your group to claim it`),
});
