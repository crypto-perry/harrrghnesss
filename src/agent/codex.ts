import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import type { SubstrateDb } from "../substrate/db.js";
import type { Registry, AgentSession } from "../core/registry.js";
import { sync, defaultRoots } from "../substrate/sync.js";
import { delta } from "../substrate/search.js";

/**
 * Codex SDK worker. One Codex thread per harness session, resumed across turns.
 * Codex persists its own transcript to ~/.codex/sessions — the substrate tailers
 * pick those up automatically, so this worker needs zero self-reporting.
 */

export interface TurnProgress {
  onItem?: (line: string) => void;
}

export interface TurnOutcome {
  finalResponse: string;
  threadId: string | null;
  filesTouched: string[];
  usage: { input: number; cachedInput: number; output: number } | null;
}

const describeItem = (item: ThreadItem): string | null => {
  switch (item.type) {
    case "command_execution":
      return `$ ${item.command.slice(0, 120)}`;
    case "file_change":
      return `✎ ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ").slice(0, 200)}`;
    case "web_search":
      return `🔎 ${item.query}`;
    case "error":
      return `⚠ ${item.message}`;
    default:
      return null;
  }
};

export class CodexWorker {
  private codex = new Codex();

  constructor(
    private db: SubstrateDb,
    private registry: Registry,
  ) {}

  /** Injected once, on a session's first turn — the thread carries it (cached) afterwards. */
  private sessionBrief(session: AgentSession): string {
    return [
      `<session-brief>`,
      `You are a task-session agent in a multi-agent harness. Task: "${session.title}" (project ${session.project}).`,
      `The user drives you over TELEGRAM from a phone: keep responses short and skimmable —`,
      `outcome first, no headers, no code dumps unless asked. Ask at most one question at a time.`,
      `You work in a dedicated git worktree on branch ${session.branch}. Other agents work in`,
      `parallel elsewhere. Commit your work in reasonable increments on this branch; never switch`,
      `branches, never push unless the user asks, never touch paths outside this worktree.`,
      `Turn inputs may begin with <workspace-activity>: recent activity by other agents/humans,`,
      `including parallel work on files you may be about to touch — read it before editing.`,
      `</session-brief>`,
    ].join("\n");
  }

  /**
   * Compose the turn input: first-turn role brief (stable prefix), then the
   * cross-agent delta (what happened elsewhere since this session's last turn),
   * then the user request. Volatile content last; never repeats (watermarked).
   */
  private composeInput(session: AgentSession, userMessage: string): string {
    sync(this.db, defaultRoots());
    const news = delta(this.db, `harness-session:${session.id}`, { limit: 120 })
      // a session's own codex thread writes capsules too — don't echo it back to itself
      .filter((c) => c.sessionId !== session.vendorThreadId)
      .slice(-12);

    const brief = session.vendorThreadId ? "" : `${this.sessionBrief(session)}\n\n`;
    if (news.length === 0) return `${brief}${userMessage}`;

    const lines = news.map((c) => {
      const t = new Date(c.ts).toISOString().slice(5, 16).replace("T", " ");
      const files = c.files.length ? ` [${c.files.slice(0, 2).join(", ")}]` : "";
      return `- ${t} ${c.vendor}/${c.kind}${files}: ${c.summary.slice(0, 140)}`;
    });
    return (
      `${brief}<workspace-activity note="recent activity by other agents/sessions in this workspace">\n` +
      `${lines.join("\n")}\n</workspace-activity>\n\n${userMessage}`
    );
  }

  async runTurn(sessionId: string, userMessage: string, progress: TurnProgress = {}): Promise<TurnOutcome> {
    const session = this.registry.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.status === "running") throw new Error(`session ${sessionId} already has a turn in flight`);

    const threadOptions = {
      workingDirectory: session.worktreePath,
      sandboxMode: "workspace-write" as const,
      modelReasoningEffort: "medium" as const,
    };
    const thread = session.vendorThreadId
      ? this.codex.resumeThread(session.vendorThreadId, threadOptions)
      : this.codex.startThread(threadOptions);

    const input = this.composeInput(session, userMessage);
    this.registry.setStatus(sessionId, "running");

    const filesTouched = new Set<string>();
    let finalResponse = "";
    let usage: TurnOutcome["usage"] = null;

    try {
      const { events } = await thread.runStreamed(input);
      for await (const event of events as AsyncGenerator<ThreadEvent>) {
        switch (event.type) {
          case "thread.started":
            this.registry.setThreadId(sessionId, event.thread_id);
            break;
          case "item.completed": {
            if (event.item.type === "agent_message") finalResponse = event.item.text;
            if (event.item.type === "file_change") {
              for (const c of event.item.changes) filesTouched.add(c.path);
            }
            const line = describeItem(event.item);
            if (line) progress.onItem?.(line);
            break;
          }
          case "turn.completed":
            usage = {
              input: event.usage.input_tokens,
              cachedInput: event.usage.cached_input_tokens,
              output: event.usage.output_tokens,
            };
            break;
          case "turn.failed":
            throw new Error(`codex turn failed: ${event.error.message}`);
          case "error":
            throw new Error(`codex stream error: ${event.message}`);
        }
      }
    } finally {
      this.registry.setStatus(sessionId, "idle");
    }

    return {
      finalResponse: finalResponse || "(turn produced no agent message)",
      threadId: thread.id,
      filesTouched: [...filesTouched],
      usage,
    };
  }
}
