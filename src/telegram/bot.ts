import { existsSync } from "node:fs";
import { Bot, InputFile, type Context } from "grammy";
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
    console.log(
      `[update] chat=${ctx.chat?.id} topic=${ctx.message?.message_thread_id ?? "-"} from=${from} (${ctx.from?.first_name ?? "?"}) text=${ctx.message?.text?.slice(0, 60) ?? "<non-text>"}`,
    );
    if (from === undefined) return;
    const owner = registry.getSetting(OWNER_KEY);
    if (owner === null) {
      registry.setSetting(OWNER_KEY, String(from));
      await ctx.reply(`harness claimed by ${ctx.from?.first_name} (${from}).`);
    } else if (owner !== String(from)) {
      console.log(`[update] ignored: from=${from} is not owner=${owner}`);
      return;
    }
    await next();
  });

  const reply = async (ctx: Context, text: string) => {
    for (const part of chunk(text)) {
      await ctx.reply(part, { message_thread_id: ctx.message?.message_thread_id });
    }
    // agents reference generated/edited images by absolute path — relay the files themselves
    const imagePaths = [...text.matchAll(/(?:`|\s|^)(\/[^\s`'"]+\.(?:png|jpe?g|webp|gif))(?:`|\s|$)/gim)]
      .map((m) => m[1]!)
      .filter((p, i, a) => a.indexOf(p) === i && existsSync(p))
      .slice(0, 3);
    for (const p of imagePaths) {
      await ctx
        .replyWithPhoto(new InputFile(p), { message_thread_id: ctx.message?.message_thread_id })
        .catch(() => {});
    }
  };

  // non-text content has no handler yet — say so instead of ghosting the user
  bot.on("message", async (ctx, next) => {
    if (ctx.message.text) return next();
    await ctx
      .reply("(text only for now — photos/files/voice land in a future build)", {
        message_thread_id: ctx.message.message_thread_id,
      })
      .catch(() => {});
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const { chatId, topicId } = surface(ctx);
    const session = registry.boundSession(chatId, topicId);

    // telegram's typing indicator dies after ~5s; keep it alive for the whole turn
    const sendTyping = () => ctx.replyWithChatAction("typing").catch(() => {});
    void sendTyping();
    const typing = setInterval(sendTyping, 5000);
    const doneTyping = () => clearInterval(typing);

    // ── unbound surface → orchestrator ─────────────────────────────────────────
    if (!session) {
      console.log(`[route] → orchestrator: "${text.slice(0, 80)}"`);
      try {
        const answer = await orchestrator.handle(text, { chatId, topicId, userName: ctx.from?.first_name });
        console.log(`[route] orchestrator replied: "${answer.slice(0, 150).replace(/\n/g, " ")}"`);
        doneTyping();
        await reply(ctx, answer);
      } catch (e) {
        doneTyping();
        console.error(`[route] orchestrator failed:`, e);
        await reply(ctx, `orchestrator error: ${String(e).slice(0, 600)}`);
      }
      return;
    }
    console.log(`[route] → session ${session.id}: "${text.slice(0, 80)}"`);

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
      doneTyping();
      await flush();
      const usage = outcome.usage
        ? `\n— in ${outcome.usage.input} (${outcome.usage.cachedInput} cached) / out ${outcome.usage.output} tok`
        : "";
      const files = outcome.filesTouched.length ? `\nfiles: ${outcome.filesTouched.join(", ").slice(0, 400)}` : "";
      await reply(ctx, `${outcome.finalResponse}${files}${usage}`);
    } catch (e) {
      clearInterval(timer);
      doneTyping();
      await reply(ctx, `turn failed: ${String(e).slice(0, 800)}`);
    }
  });

  return bot;
}
