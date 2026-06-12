import { closeSync, openSync, readSync, fstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SubstrateDb } from "./db.js";
import type { TailResult, Vendor } from "../core/types.js";
import { TailerSchemaError } from "../core/types.js";
import * as codex from "./tailers/codex.js";
import * as claude from "./tailers/claude.js";

export interface SyncRoots {
  claudeProjects: string;
  codexSessions: string;
}

export function defaultRoots(): SyncRoots {
  return {
    claudeProjects: join(homedir(), ".claude", "projects"),
    codexSessions: join(homedir(), ".codex", "sessions"),
  };
}

export interface SyncReport {
  filesSeen: number;
  filesParsed: number;
  capsulesAdded: number;
  unknownLines: number;
  /** schema-drift errors: file is quarantined at its old offset, never half-ingested */
  errors: { sourcePath: string; error: string }[];
}

interface SourceFile {
  path: string;
  vendor: Vendor;
}

function discover(roots: SyncRoots): SourceFile[] {
  const out: SourceFile[] = [];
  for (const [root, vendor, matches] of [
    [roots.claudeProjects, "claude", claude.matchesClaude],
    [roots.codexSessions, "codex", codex.matchesCodex],
  ] as const) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue; // root absent on this machine — fine
    }
    for (const rel of entries) {
      if (!rel.endsWith(".jsonl")) continue;
      const full = join(root, rel);
      if (matches(full)) out.push({ path: full, vendor });
    }
  }
  return out;
}

/**
 * Read complete lines from `offset` to EOF. A trailing partial line (writer mid-append)
 * is left for the next sync — `nextOffset` only ever covers fully terminated lines.
 */
function readNewLines(
  path: string,
  offset: number,
): { lines: string[]; startLineNo: number; nextOffset: number; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) {
      // file shrank: rotated or rewritten — start over rather than misread
      return { lines: [], startLineNo: 0, nextOffset: 0, truncated: true };
    }
    if (size === offset) return { lines: [], startLineNo: 0, nextOffset: offset, truncated: false };

    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return { lines: [], startLineNo: 0, nextOffset: offset, truncated: false };

    const complete = text.slice(0, lastNl);
    const nextOffset = offset + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");

    // line numbers are 1-based over the whole file; count lines before offset cheaply:
    // we store them alongside the offset instead of recounting — see callers.
    return { lines: complete.split("\n"), startLineNo: -1, nextOffset, truncated: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * Lazy sync: stat every known session file, parse only new bytes, write capsules once.
 * Safe to call on every turn boundary — cheap when nothing changed.
 */
export function sync(db: SubstrateDb, roots: SyncRoots = defaultRoots()): SyncReport {
  const report: SyncReport = { filesSeen: 0, filesParsed: 0, capsulesAdded: 0, unknownLines: 0, errors: [] };

  const getOffset = db.prepare(
    "SELECT byte_offset AS off, line_no AS line FROM tailer_offsets WHERE source_path = ?",
  );
  const putOffset = db.prepare(
    `INSERT INTO tailer_offsets (source_path, byte_offset, line_no, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET byte_offset = excluded.byte_offset, line_no = excluded.line_no, updated_at = excluded.updated_at`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (id, vendor, source_path, cwd, started_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cwd = COALESCE(excluded.cwd, sessions.cwd), last_event_at = excluded.last_event_at`,
  );
  const insertCapsule = db.prepare(
    `INSERT INTO capsules (session_id, vendor, ts, kind, files, summary, raw_ref, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'task')`,
  );
  const insertFts = db.prepare("INSERT INTO capsules_fts (rowid, summary, files) VALUES (?, ?, ?)");

  for (const file of discover(roots)) {
    report.filesSeen += 1;

    let size: number;
    try {
      size = statSync(file.path).size;
    } catch {
      continue; // vanished between discover and stat
    }
    const row = getOffset.get(file.path) as { off: number; line: number } | undefined;
    const offset = row?.off ?? 0;
    const lineBase = row?.line ?? 0;
    if (size <= offset) continue; // nothing new — the common case, costs one stat

    let lines: string[];
    let nextOffset: number;
    let startLineNo: number;
    try {
      const r = readNewLines(file.path, offset);
      if (r.truncated) {
        putOffset.run(file.path, 0, 0, Date.now());
        report.errors.push({ sourcePath: file.path, error: "file shrank — offset reset, will re-ingest" });
        continue;
      }
      if (r.lines.length === 0) continue;
      lines = r.lines;
      nextOffset = r.nextOffset;
      startLineNo = lineBase + 1;
    } catch (e) {
      report.errors.push({ sourcePath: file.path, error: String(e) });
      continue;
    }

    let result: TailResult;
    try {
      result =
        file.vendor === "codex"
          ? codex.tailCodexLines(file.path, lines, startLineNo)
          : claude.tailClaudeLines(file.path, lines, startLineNo);
    } catch (e) {
      if (e instanceof TailerSchemaError) {
        // fail loud, never misparse: quarantine the file at its old offset and surface the drift
        report.errors.push({ sourcePath: file.path, error: e.message });
        continue;
      }
      throw e;
    }

    const writeAll = db.transaction(() => {
      for (const ev of result.events) {
        const filesJson = JSON.stringify(ev.files);
        const info = insertCapsule.run(
          result.sessionId,
          file.vendor,
          ev.ts,
          ev.kind,
          filesJson,
          ev.summary,
          `${file.path}:${ev.lineStart}-${ev.lineEnd}`,
        );
        insertFts.run(info.lastInsertRowid, ev.summary, filesJson);
      }
      const lastTs = result.events.at(-1)?.ts ?? null;
      upsertSession.run(result.sessionId, file.vendor, file.path, result.cwd, null, lastTs);
      putOffset.run(file.path, nextOffset, lineBase + lines.length, Date.now());
    });
    writeAll();

    report.filesParsed += 1;
    report.capsulesAdded += result.events.length;
    report.unknownLines += result.unknownLines;
  }

  return report;
}
