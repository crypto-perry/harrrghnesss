import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SubstrateDb } from "../substrate/db.js";
import type { Registry, AgentSession } from "../core/registry.js";
import type { AgentWorker, TurnOutcome, TurnProgress } from "./worker.js";
import { sync, defaultRoots } from "../substrate/sync.js";
import { delta } from "../substrate/search.js";
import { snapshotHeads, recordTurnCommits } from "./commits.js";

/**
 * Claude Agent SDK worker. One Claude session per harness session, resumed across
 * turns. Like Codex, Claude persists transcripts to ~/.claude/projects — the
 * substrate tailers ingest them automatically.
 *
 * Auth: requires ANTHROPIC_API_KEY (subscription OAuth is not accepted by the
 * Agent SDK; from 2026-06-15 usage draws from the plan's Agent SDK credit).
 * Cost note: claude-fable-5 is the premium tier — expect a $20/mo Pro credit to
 * cover only a handful of long turns.
 */

export class ClaudeWorker implements AgentWorker {
  readonly vendor = "claude";

  constructor(
    private db: SubstrateDb,
    private registry: Registry,
    private model: string = "claude-fable-5",
  ) {}

  private sessionBrief(session: AgentSession): string {
    return [
      `You are a task-session agent in a multi-agent harness. Task: "${session.title}" (project ${session.project}).`,
      `The user drives you over TELEGRAM from a phone: keep responses short and skimmable — outcome first,`,
      `no headers, no code dumps unless asked.`,
      session.branch
        ? `Your folder contains a dedicated clone of the project repo, on branch ${session.branch}. Commit in reasonable increments on that branch; never switch branches, never push unless the user asks.`
        : `Your folder starts empty — create whatever the task needs inside it.`,
      `Other agents work in parallel in their own folders — never leave yours.`,
      `Turn inputs may begin with <workspace-activity>: recent activity by other agents — read it before editing.`,
    ].join(" ");
  }

  private composeInput(session: AgentSession, userMessage: string): string {
    sync(this.db, defaultRoots());
    const news = delta(this.db, `harness-session:${session.id}`, { limit: 120 })
      .filter((c) => c.sessionId !== session.vendorThreadId)
      .slice(-12);
    if (news.length === 0) return userMessage;
    const lines = news.map((c) => {
      const t = new Date(c.ts).toISOString().slice(5, 16).replace("T", " ");
      const files = c.files.length ? ` [${c.files.slice(0, 2).join(", ")}]` : "";
      return `- ${t} ${c.vendor}/${c.kind}${files}: ${c.summary.slice(0, 140)}`;
    });
    return `<workspace-activity note="recent activity by other agents/sessions in this workspace">\n${lines.join("\n")}\n</workspace-activity>\n\n${userMessage}`;
  }

  async runTurn(sessionId: string, userMessage: string, progress: TurnProgress = {}): Promise<TurnOutcome> {
    const session = this.registry.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.status === "running") throw new Error(`session ${sessionId} already has a turn in flight`);

    this.registry.setStatus(sessionId, "running");
    const headsBefore = snapshotHeads(session.worktreePath);
    const filesTouched = new Set<string>();
    let finalResponse = "";
    let threadId: string | null = session.vendorThreadId;
    let usage: TurnOutcome["usage"] = null;

    try {
      const q = query({
        prompt: this.composeInput(session, userMessage),
        options: {
          cwd: session.worktreePath,
          model: this.model,
          ...(session.vendorThreadId ? { resume: session.vendorThreadId } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: this.sessionBrief(session) },
          permissionMode: "bypassPermissions",
        },
      });

      for await (const message of q) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              finalResponse = block.text;
            } else if (block.type === "tool_use") {
              const input = block.input as Record<string, unknown>;
              const path = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
              if (path && (block.name === "Write" || block.name === "Edit" || block.name === "NotebookEdit")) {
                filesTouched.add(path);
              }
              const detail = path || (typeof input["command"] === "string" ? String(input["command"]).slice(0, 80) : "");
              progress.onItem?.(`⚙ ${block.name} ${detail}`.trim());
            }
          }
        } else if (message.type === "result") {
          threadId = message.session_id ?? threadId;
          if (message.subtype === "success" && message.result) finalResponse = message.result;
          const u = message.usage;
          if (u) {
            usage = {
              input: u.input_tokens ?? 0,
              cachedInput: u.cache_read_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
            };
          }
        } else if (message.type === "system" && message.subtype === "init") {
          threadId = message.session_id ?? threadId;
        }
      }
      if (threadId && threadId !== session.vendorThreadId) this.registry.setThreadId(sessionId, threadId);
    } finally {
      this.registry.setStatus(sessionId, "idle");
    }
    sync(this.db, defaultRoots());
    recordTurnCommits(this.db, threadId, session.worktreePath, headsBefore);

    return {
      finalResponse: finalResponse || "(turn produced no response)",
      threadId,
      filesTouched: [...filesTouched],
      usage,
    };
  }
}
