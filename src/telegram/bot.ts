import { Bot, type Context } from "grammy";
import type { Registry } from "../core/registry.js";
import type { CodexWorker } from "../agent/codex.js";
import type { Orchestrator } from "../agent/orchestrator.js";

/**
 * Command-free Telegram control plane.
 *
 * Routing rule — the only rule:
 *   topic bound to a session  → message is a TURN for that session's coding agent
 *   anything else             → message goes to the ORCHESTRATOR, which manages
 *                               projects/sessions conversationally (it creates a
 *                               dedicated topic per new session and binds it)
 */

const OWNER_KEY = "telegram_owner_id";
const MAX_MSG = 4000; // telegram hard cap is 4096

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MSG) out.push(text.slice(i, i + MAX_MSG));
  return out.length > 0 ? out : ["(empty)"];
}

function surface(ctx: Context): { chatId: string; topicId: string | undefined } {
  return {
    chatId: String(ctx.chat?.id ?? ""),
    topicId: ctx.message?.message_thread_id !== undefined ? String(ctx.message.message_thread_id) : undefined,
  };
}

export function createBot(opts: {
  token: string;
  registry: Registry;
  worker: CodexWorker;
  orchestrator: Orchestrator;
}): Bot {
  const { token, registry, worker, orchestrator } = opts;
  const bot = new Bot(token);

  // ── owner lock: the first human to message the bot claims it; others get silence ──
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (from === undefined) return;
    const owner = registry.getSetting(OWNER_KEY);
    if (owner === null) {
      registry.setSetting(OWNER_KEY, String(from));
      await ctx.reply(`harness claimed by ${ctx.from?.first_name} (${from}).`);
    } else if (owner !== String(from)) {
      return;
    }
    await next();
  });

  const reply = async (ctx: Context, text: string) => {
    for (const part of chunk(text)) {
      await ctx.reply(part, { message_thread_id: ctx.message?.message_thread_id });
    }
  };

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const { chatId, topicId } = surface(ctx);
    const session = registry.boundSession(chatId, topicId);

    await ctx.replyWithChatAction("typing");

    // ── unbound surface → orchestrator ─────────────────────────────────────────
    if (!session) {
      try {
        const answer = await orchestrator.handle(text, { chatId, topicId, userName: ctx.from?.first_name });
        await reply(ctx, answer);
      } catch (e) {
        await reply(ctx, `orchestrator error: ${String(e).slice(0, 600)}`);
      }
      return;
    }

    // ── bound surface → a turn for the session's coding agent ──────────────────
    if (session.status === "running") {
      return reply(ctx, `session ${session.id} is mid-turn — wait for it to finish`);
    }

    // progress lines are batched to avoid telegram rate limits on busy turns
    let pending: string[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending.join("\n");
      pending = [];
      await reply(ctx, batch).catch(() => {});
    };
    const timer = setInterval(() => void flush(), 4000);

    try {
      const outcome = await worker.runTurn(session.id, text, {
        onItem: (line) => pending.push(line),
      });
      clearInterval(timer);
      await flush();
      const usage = outcome.usage
        ? `\n— in ${outcome.usage.input} (${outcome.usage.cachedInput} cached) / out ${outcome.usage.output} tok`
        : "";
      const files = outcome.filesTouched.length ? `\nfiles: ${outcome.filesTouched.join(", ").slice(0, 400)}` : "";
      await reply(ctx, `${outcome.finalResponse}${files}${usage}`);
    } catch (e) {
      clearInterval(timer);
      await reply(ctx, `turn failed: ${String(e).slice(0, 800)}`);
    }
  });

  return bot;
}
