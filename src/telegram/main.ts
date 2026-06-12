#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../substrate/db.js";
import { Registry } from "../core/registry.js";
import { CodexWorker } from "../agent/codex.js";
import { Orchestrator } from "../agent/orchestrator.js";
import { createBot } from "./bot.js";

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  process.loadEnvFile(join(HARNESS_ROOT, ".env"));
} catch {
  /* .env optional — env vars may come from the shell */
}

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN missing — set it in .env");
  process.exit(1);
}

const db = openDb(process.env["HARNESS_DB"] ?? join(HARNESS_ROOT, ".harness", "substrate.db"));
const registry = new Registry(db);
const worker = new CodexWorker(db, registry);
const orchestrator = new Orchestrator(registry, HARNESS_ROOT);

const bot = createBot({ token, registry, worker, orchestrator });

bot.catch((err) => console.error("bot error:", err.error));

console.log("harness telegram bot starting (long polling)…");
await bot.start({
  onStart: (me) => console.log(`@${me.username} is live — /start in your group to claim it`),
});
