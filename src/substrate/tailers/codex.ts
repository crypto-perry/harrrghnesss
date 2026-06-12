import { basename } from "node:path";
import type { TailedEvent, TailResult } from "../../core/types.js";
import { TailerSchemaError } from "../../core/types.js";
import { extractPaths, squash } from "./paths.js";

/**
 * Tailer for Codex CLI rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Observed line shape (verified 2026-06-12 against real rollouts):
 *   { "timestamp": ISO8601, "type": "response_item"|"event_msg"|"turn_context"|"session_meta", "payload": {...} }
 *   event_msg payloads:      user_message / agent_message  → { type, message: string }
 *   response_item payloads:  function_call → { type, name, arguments: string }
 */

const FILENAME_RE = /rollout-.*-([0-9a-f-]{36})\.jsonl$/;

export function matchesCodex(sourcePath: string): boolean {
  return FILENAME_RE.test(basename(sourcePath)) && sourcePath.includes(".codex");
}

export function sessionIdFromPath(sourcePath: string): string {
  const m = basename(sourcePath).match(FILENAME_RE);
  if (!m) throw new TailerSchemaError(sourcePath, 0, "unrecognized rollout filename");
  return m[1]!;
}

export function tailCodexLines(
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
    const payload = obj["payload"] as Record<string, unknown> | undefined;
    const ts = Date.parse(String(obj["timestamp"] ?? "")) || Date.now();

    if (typeof type !== "string" || payload === undefined) {
      // a rollout line without type/payload means the format moved under us — fail loud
      throw new TailerSchemaError(sourcePath, lineNo, "missing type/payload envelope");
    }

    if (type === "session_meta") {
      const p = payload as { cwd?: string };
      if (typeof p.cwd === "string") cwd = p.cwd;
      return;
    }

    const ptype = payload["type"];

    if (type === "event_msg" && (ptype === "user_message" || ptype === "agent_message")) {
      const message = payload["message"];
      if (typeof message !== "string") {
        throw new TailerSchemaError(sourcePath, lineNo, `${String(ptype)} without string message`);
      }
      events.push({
        ts,
        kind: ptype === "user_message" ? "user" : "agent",
        summary: squash(message),
        files: extractPaths(message),
        lineStart: lineNo,
        lineEnd: lineNo,
      });
      return;
    }

    if (type === "response_item" && ptype === "function_call") {
      const name = String(payload["name"] ?? "tool");
      const args = typeof payload["arguments"] === "string" ? (payload["arguments"] as string) : "";
      events.push({
        ts,
        kind: "tool",
        summary: squash(`${name} ${args}`, 200),
        files: extractPaths(args),
        lineStart: lineNo,
        lineEnd: lineNo,
      });
      return;
    }

    // known-irrelevant payloads (reasoning, token_count, task_started, …) are skipped silently;
    // genuinely novel ones are counted so sync can surface drift without poisoning the DB
    const KNOWN_SKIP = new Set([
      "message",
      "reasoning",
      "token_count",
      "function_call_output",
      "task_started",
      "task_complete",
      "web_search_call",
      "web_search_end",
      "turn_aborted",
      "thread_rolled_back",
    ]);
    if (type === "turn_context") return;
    if (typeof ptype === "string" && KNOWN_SKIP.has(ptype)) return;
    unknownLines += 1;
  });

  return { sessionId, cwd, events, unknownLines };
}
