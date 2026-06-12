/** Shared domain types for the harness substrate. */

export type Vendor = "codex" | "claude";

export type CapsuleKind = "user" | "agent" | "tool" | "decision" | "file_change";

/** One distilled unit of agent/human activity. Points back into the raw source. */
export interface Capsule {
  id: number;
  sessionId: string;
  vendor: Vendor;
  /** epoch millis */
  ts: number;
  kind: CapsuleKind;
  /** repo-relative or absolute file paths touched/referenced */
  files: string[];
  /** compact, single-line extract — deterministic in v1, no LLM */
  summary: string;
  /** provenance pointer: `<sourcePath>:<lineStart>-<lineEnd>` */
  rawRef: string;
  /** visibility tier: task-local by default; 'global' is explicitly broadcast */
  scope: "task" | "global";
}

export interface SessionRecord {
  id: string;
  vendor: Vendor;
  sourcePath: string;
  cwd: string | null;
  startedAt: number | null;
  lastEventAt: number | null;
}

/** Event extracted by a tailer from new lines of a session file. */
export interface TailedEvent {
  ts: number;
  kind: CapsuleKind;
  summary: string;
  files: string[];
  lineStart: number;
  lineEnd: number;
}

export interface TailResult {
  sessionId: string;
  cwd: string | null;
  events: TailedEvent[];
  /** lines whose JSON parsed but whose shape was unrecognized — surfaced, never silent */
  unknownLines: number;
}

/** Thrown when a session file's structure no longer matches what the tailer knows. Fail loud, never misparse. */
export class TailerSchemaError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly lineNo: number,
    detail: string,
  ) {
    super(`schema drift in ${sourcePath}:${lineNo} — ${detail}`);
    this.name = "TailerSchemaError";
  }
}
