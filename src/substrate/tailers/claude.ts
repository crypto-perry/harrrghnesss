import { basename } from "node:path";
import type { TailedEvent, TailResult } from "../../core/types.js";
import { TailerSchemaError } from "../../core/types.js";
import { extractPaths, squash } from "./paths.js";

/**
 * Tailer for Claude Code session files: ~/.claude/projects/<project-slug>/<uuid>.jsonl
 *
 * Observed line shape (verified 2026-06-12 against a live session):
 *   { "type": "user"|"assistant"|..., "message": { role, content: string | Block[] },
 *     "timestamp": ISO8601, "uuid": ..., "cwd"?: string, "isSidechain"?: boolean }
 *   Block: {type:"text",text} | {type:"tool_use",name,input} | {type:"tool_result",...}
 *   Plus non-conversation line types we skip: queue-operation, file-history-snapshot,
 *   ai-title, last-prompt, mode, attachment, system, summary, …
 */

const FILENAME_RE = /^([0-9a-f-]{36})\.jsonl$/;

export function matchesClaude(sourcePath: string): boolean {
  return FILENAME_RE.test(basename(sourcePath)) && sourcePath.includes(".claude");
}

export function sessionIdFromPath(sourcePath: string): string {
  const m = basename(sourcePath).match(FILENAME_RE);
  if (!m) throw new TailerSchemaError(sourcePath, 0, "unrecognized session filename");
  return m[1]!;
}

const SKIP_TYPES = new Set([
  "queue-operation",
  "file-history-snapshot",
  "ai-title",
  "last-prompt",
  "mode",
  "attachment",
  "system",
  "summary",
  "progress",
  "todo",
]);

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function tailClaudeLines(
  sourcePath: string,
  lines: string[],
  startLineNo: number,
): TailResult {
  const sessionId = sessionIdFromPath(sourcePath);
  const events: TailedEvent[] = [];
  let cwd: string | null = null;
  let unknownLines = 0;

  lines.forEach((line, i) => {
    const lineNo = startLineNo + i;
    if (!line.trim()) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new TailerSchemaError(sourcePath, lineNo, "line is not valid JSON");
    }

    const type = obj["type"];
    if (typeof type !== "string") {
      throw new TailerSchemaError(sourcePath, lineNo, "line without type field");
    }
    if (SKIP_TYPES.has(type)) return;
    if (type !== "user" && type !== "assistant") {
      unknownLines += 1;
      return;
    }
    if (obj["isSidechain"] === true) return; // subagent traffic: its outcome surfaces in the parent turn

    if (typeof obj["cwd"] === "string") cwd = obj["cwd"] as string;
    const ts = Date.parse(String(obj["timestamp"] ?? "")) || Date.now();
    const message = obj["message"] as { role?: string; content?: unknown } | undefined;
    if (!message) {
      throw new TailerSchemaError(sourcePath, lineNo, `${type} line without message`);
    }

    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) {
        events.push({
          ts,
          kind: type === "user" ? "user" : "agent",
          summary: squash(content),
          files: extractPaths(content),
          lineStart: lineNo,
          lineEnd: lineNo,
        });
      }
      return;
    }
    if (!Array.isArray(content)) {
      throw new TailerSchemaError(sourcePath, lineNo, "message.content is neither string nor array");
    }

    for (const block of content as ContentBlock[]) {
      if (block.type === "text" && block.text?.trim()) {
        // command/caveat wrappers in user turns are harness noise, not conversation
        if (type === "user" && block.text.startsWith("<")) continue;
        events.push({
          ts,
          kind: type === "user" ? "user" : "agent",
          summary: squash(block.text),
          files: extractPaths(block.text),
          lineStart: lineNo,
          lineEnd: lineNo,
        });
      } else if (block.type === "tool_use" && block.name) {
        const input = block.input ?? {};
        const explicit = ["file_path", "path", "notebook_path", "cwd"]
          .map((k) => input[k])
          .filter((v): v is string => typeof v === "string");
        const argText = [input["command"], input["pattern"], input["query"], input["description"]]
          .filter((v): v is string => typeof v === "string")
          .join(" ");
        events.push({
          ts,
          kind: "tool",
          summary: squash(`${block.name} ${explicit.join(" ")} ${argText}`, 200),
          files: extractPaths(argText, explicit),
          lineStart: lineNo,
          lineEnd: lineNo,
        });
      }
      // tool_result / thinking blocks: skipped in v1 — raw_ref preserves access to them
    }
  });

  return { sessionId, cwd, events, unknownLines };
}
