import { Codex } from "@openai/codex-sdk";
import type { Registry } from "../core/registry.js";

/**
 * The conversational front door: a persistent Codex thread rooted at the harness
 * repo. AGENTS.md (read natively by Codex) defines its role; its toolbox is the
 * harness CLI via shell. Thread id persists in settings, so the conversation
 * survives bot restarts.
 */

const THREAD_KEY = "orchestrator_thread_id";

export class Orchestrator {
  private codex = new Codex();

  constructor(
    private registry: Registry,
    private harnessRoot: string,
  ) {}

  async handle(message: string, ctx: { chatId: string; topicId?: string; userName?: string }): Promise<string> {
    const threadOptions = {
      workingDirectory: this.harnessRoot,
      sandboxMode: "workspace-write" as const,
      networkAccessEnabled: true, // clones need the network
      modelReasoningEffort: "low" as const,
    };
    const existing = this.registry.getSetting(THREAD_KEY);
    const thread = existing ? this.codex.resumeThread(existing, threadOptions) : this.codex.startThread(threadOptions);

    const header = `[telegram chat_id=${ctx.chatId}${ctx.topicId ? ` topic_id=${ctx.topicId}` : ""}${ctx.userName ? ` user=${ctx.userName}` : ""}]`;
    const turn = await thread.run(`${header}\n${message}`);

    if (thread.id && thread.id !== existing) this.registry.setSetting(THREAD_KEY, thread.id);
    return turn.finalResponse || "(no response)";
  }
}
