import { Bot, type Context } from "grammy";
import type { Registry } from "../core/registry.js";
import type { CodexWorker } from "../agent/codex.js";
import { cloneProject, createSessionWorktree, worktreeStatus } from "../git/repos.js";
import { findCollisions } from "../substrate/collisions.js";

/**
 * Telegram control plane. Thin by design: commands drive registry/git/worker
 * primitives that exist independently of Telegram.
 *
 * Conversation surface = (chat, topic). Each surface binds to one agent session;
 * plain messages on a surface become turns for its session. Multiple topics in
 * one group = multiple parallel sessions, which is exactly the topology you want.
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
  projectsRoot: string;
}): Bot {
  const { token, registry, worker, projectsRoot } = opts;
  const bot = new Bot(token);

  // ── owner lock: first /start claims the bot; everyone else is ignored ────────
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (from === undefined) return;
    const owner = registry.getSetting(OWNER_KEY);
    if (owner === null) {
      if (ctx.message?.text?.startsWith("/start")) {
        registry.setSetting(OWNER_KEY, String(from));
        await ctx.reply(`Bot claimed by ${ctx.from?.first_name} (${from}). This id now owns the harness.`);
      }
      return;
    }
    if (owner !== String(from)) return; // silently ignore non-owners
    await next();
  });

  const reply = async (ctx: Context, text: string) => {
    for (const part of chunk(text)) {
      await ctx.reply(part, { message_thread_id: ctx.message?.message_thread_id });
    }
  };

  bot.command("start", (ctx) =>
    reply(
      ctx,
      "harness ready.\n" +
        "/clone <git-url> [name] — add a project\n" +
        "/projects — list projects\n" +
        "/new <project> <task…> — new agent session (worktree+branch), bound to this topic\n" +
        "/sessions — list sessions\n" +
        "/use <sessionId> — bind an existing session to this topic\n" +
        "/status — bound session, worktree state, collisions\n" +
        "plain message — a turn for the session bound to this topic",
    ),
  );

  bot.command("clone", async (ctx) => {
    const [url, name] = (ctx.match as string).trim().split(/\s+/);
    if (!url) return reply(ctx, "usage: /clone <git-url> [name]");
    try {
      await ctx.reply(`cloning ${url}…`);
      const p = cloneProject(url, projectsRoot, name);
      registry.addProject({ name: p.name, repoUrl: url, path: p.path, defaultBranch: p.defaultBranch });
      await reply(ctx, `✓ project '${p.name}' ready (default branch: ${p.defaultBranch})`);
    } catch (e) {
      await reply(ctx, `clone failed: ${String(e).slice(0, 500)}`);
    }
  });

  bot.command("projects", async (ctx) => {
    const ps = registry.listProjects();
    await reply(ctx, ps.length === 0 ? "no projects — /clone one" : ps.map((p) => `• ${p.name} (${p.repoUrl ?? p.path})`).join("\n"));
  });

  bot.command("new", async (ctx) => {
    const parts = (ctx.match as string).trim().split(/\s+/);
    const projectName = parts[0];
    const title = parts.slice(1).join(" ") || "untitled task";
    if (!projectName) return reply(ctx, "usage: /new <project> <task title…>");
    const project = registry.getProject(projectName);
    if (!project) return reply(ctx, `unknown project '${projectName}' — /projects to list, /clone to add`);
    try {
      const session = registry.createSession({
        project: project.name,
        title,
        worktreePath: "pending",
        branch: "pending",
        vendor: "codex",
      });
      // session row is created first so its id can name the branch/worktree
      const wt = createSessionWorktree(project.path, projectsRoot, project.name, session.id, project.defaultBranch);
      registry.setWorktree(session.id, wt.worktreePath, wt.branch);
      const { chatId, topicId } = surface(ctx);
      registry.bind(chatId, topicId, session.id);
      await reply(ctx, `✓ session ${session.id} — "${title}"\n  branch ${wt.branch}\n  bound to this topic; just type to give it work`);
    } catch (e) {
      await reply(ctx, `session creation failed: ${String(e).slice(0, 500)}`);
    }
  });

  bot.command("sessions", async (ctx) => {
    const ss = registry.listSessions();
    await reply(
      ctx,
      ss.length === 0
        ? "no sessions — /new <project> <task…>"
        : ss.map((s) => `• ${s.id} [${s.status}] ${s.project}: ${s.title} (${s.branch})`).join("\n"),
    );
  });

  bot.command("use", async (ctx) => {
    const id = (ctx.match as string).trim();
    const session = registry.getSession(id);
    if (!session) return reply(ctx, `unknown session '${id}'`);
    const { chatId, topicId } = surface(ctx);
    registry.bind(chatId, topicId, session.id);
    await reply(ctx, `✓ this topic now drives session ${session.id} (${session.project}: ${session.title})`);
  });

  bot.command("status", async (ctx) => {
    const { chatId, topicId } = surface(ctx);
    const session = registry.boundSession(chatId, topicId);
    if (!session) return reply(ctx, "no session bound here — /new or /use");
    let wt = "";
    try {
      const s = worktreeStatus(session.worktreePath);
      wt = `branch ${s.branch}, ${s.dirty.length} dirty file(s), ${s.ahead} commit(s) ahead`;
    } catch {
      wt = "worktree unavailable";
    }
    const cols = findCollisions(projectsRoot)
      .map((c) => `⚠ ${c.file} dirty in ${c.sites.length} checkouts`)
      .join("\n");
    await reply(ctx, `session ${session.id} [${session.status}] ${session.project}: ${session.title}\n${wt}${cols ? `\n${cols}` : ""}`);
  });

  // ── plain messages = turns ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    const { chatId, topicId } = surface(ctx);
    const session = registry.boundSession(chatId, topicId);
    if (!session) return reply(ctx, "no session bound to this topic — /new <project> <task…> or /use <sessionId>");
    if (session.status === "running") return reply(ctx, `session ${session.id} is mid-turn — wait for it to finish`);

    await ctx.replyWithChatAction("typing");
    // progress lines are batched to avoid hitting telegram rate limits on busy turns
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
