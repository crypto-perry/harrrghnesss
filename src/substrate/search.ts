import { readFileSync } from "node:fs";
import type { SubstrateDb } from "./db.js";
import type { Capsule, CapsuleKind, Vendor } from "../core/types.js";

/**
 * Staged retrieval (the monomento lesson): SEARCH returns refs + one-line previews,
 * PEEK returns a session's skeleton, READ resolves one capsule down to raw source lines.
 * Cheap by default; expensive only by explicit choice.
 */

export interface SearchHit {
  capsuleId: number;
  sessionId: string;
  vendor: Vendor;
  ts: number;
  kind: CapsuleKind;
  files: string[];
  preview: string;
  /** which retrieval ranked it — monodex-style provenance tag */
  via: "fts" | "like";
}

interface CapsuleRow {
  id: number;
  session_id: string;
  vendor: Vendor;
  ts: number;
  kind: CapsuleKind;
  files: string;
  summary: string;
  raw_ref: string;
  scope: "task" | "global";
}

function toCapsule(r: CapsuleRow): Capsule {
  return {
    id: r.id,
    sessionId: r.session_id,
    vendor: r.vendor,
    ts: r.ts,
    kind: r.kind,
    files: JSON.parse(r.files) as string[],
    summary: r.summary,
    rawRef: r.raw_ref,
    scope: r.scope,
  };
}

const preview = (s: string, n = 140) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function search(
  db: SubstrateDb,
  query: string,
  opts: { limit?: number; sessionId?: string } = {},
): SearchHit[] {
  const limit = opts.limit ?? 12;
  const hit = (r: CapsuleRow, via: SearchHit["via"]): SearchHit => ({
    capsuleId: r.id,
    sessionId: r.session_id,
    vendor: r.vendor,
    ts: r.ts,
    kind: r.kind,
    files: JSON.parse(r.files) as string[],
    preview: preview(r.summary),
    via,
  });

  // trigram FTS needs ≥3-char tokens. OR the words so one typo'd word doesn't sink the
  // query — bm25 rank still floats rows matching more words to the top.
  const words = query.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length > 0) {
    try {
      const ftsQuery = words.map((w) => JSON.stringify(w)).join(" OR ");
      const sql = opts.sessionId
        ? `SELECT c.* FROM capsules_fts f JOIN capsules c ON c.id = f.rowid
           WHERE capsules_fts MATCH @q AND c.session_id = @sid ORDER BY rank LIMIT @lim`
        : `SELECT c.* FROM capsules_fts f JOIN capsules c ON c.id = f.rowid
           WHERE capsules_fts MATCH @q ORDER BY rank LIMIT @lim`;
      const params = opts.sessionId
        ? { q: ftsQuery, sid: opts.sessionId, lim: limit }
        : { q: ftsQuery, lim: limit };
      const rows = db.prepare(sql).all(params) as CapsuleRow[];
      if (rows.length > 0) return rows.map((r) => hit(r, "fts"));
    } catch {
      // fall through to LIKE
    }
  }
  const sql = opts.sessionId
    ? `SELECT * FROM capsules WHERE (summary LIKE @q OR files LIKE @q) AND session_id = @sid
       ORDER BY ts DESC LIMIT @lim`
    : `SELECT * FROM capsules WHERE (summary LIKE @q OR files LIKE @q) ORDER BY ts DESC LIMIT @lim`;
  const params = opts.sessionId
    ? { q: `%${query}%`, sid: opts.sessionId, lim: limit }
    : { q: `%${query}%`, lim: limit };
  const rows = db.prepare(sql).all(params) as CapsuleRow[];
  return rows.map((r) => hit(r, "like"));
}

export interface SessionSkeleton {
  sessionId: string;
  vendor: Vendor;
  cwd: string | null;
  sourcePath: string;
  lastEventAt: number | null;
  capsuleCount: number;
  capsules: { capsuleId: number; ts: number; kind: CapsuleKind; preview: string; files: string[] }[];
}

export function peek(db: SubstrateDb, sessionId: string, opts: { limit?: number } = {}): SessionSkeleton | null {
  const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | { id: string; vendor: Vendor; source_path: string; cwd: string | null; last_event_at: number | null }
    | undefined;
  if (!s) return null;
  const count = db.prepare("SELECT COUNT(*) AS n FROM capsules WHERE session_id = ?").get(sessionId) as { n: number };
  const rows = db
    .prepare("SELECT * FROM capsules WHERE session_id = ? ORDER BY ts DESC LIMIT ?")
    .all(sessionId, opts.limit ?? 30) as CapsuleRow[];
  return {
    sessionId: s.id,
    vendor: s.vendor,
    cwd: s.cwd,
    sourcePath: s.source_path,
    lastEventAt: s.last_event_at,
    capsuleCount: count.n,
    capsules: rows.map((r) => ({
      capsuleId: r.id,
      ts: r.ts,
      kind: r.kind,
      preview: preview(r.summary),
      files: JSON.parse(r.files) as string[],
    })),
  };
}

export interface ReadResult extends Capsule {
  /** raw source lines around the capsule's origin, capped — the final, most expensive stage */
  raw: string | null;
}

export function read(db: SubstrateDb, capsuleId: number, opts: { rawBytes?: number } = {}): ReadResult | null {
  const r = db.prepare("SELECT * FROM capsules WHERE id = ?").get(capsuleId) as CapsuleRow | undefined;
  if (!r) return null;
  const capsule = toCapsule(r);

  let raw: string | null = null;
  const m = capsule.rawRef.match(/^(.*):(\d+)-(\d+)$/);
  if (m) {
    try {
      const [, path, start, end] = m;
      const lines = readFileSync(path!, "utf8").split("\n");
      raw = lines.slice(Number(start) - 1, Number(end)).join("\n");
      const cap = opts.rawBytes ?? 4096;
      if (raw.length > cap) raw = `${raw.slice(0, cap)}… [truncated ${raw.length - cap} bytes — raw_ref: ${capsule.rawRef}]`;
    } catch {
      raw = null; // source file gone; capsule summary survives it
    }
  }
  return { ...capsule, raw };
}

export function recent(
  db: SubstrateDb,
  opts: { minutes?: number; limit?: number; kind?: CapsuleKind } = {},
): Capsule[] {
  const since = Date.now() - (opts.minutes ?? 240) * 60_000;
  const sql = opts.kind
    ? "SELECT * FROM capsules WHERE ts >= @since AND kind = @kind ORDER BY ts DESC LIMIT @lim"
    : "SELECT * FROM capsules WHERE ts >= @since ORDER BY ts DESC LIMIT @lim";
  const params = opts.kind
    ? { since, kind: opts.kind, lim: opts.limit ?? 25 }
    : { since, lim: opts.limit ?? 25 };
  const rows = db.prepare(sql).all(params) as CapsuleRow[];
  return rows.map(toCapsule);
}

export function fileHistory(db: SubstrateDb, pathFragment: string, opts: { limit?: number } = {}): Capsule[] {
  const rows = db
    .prepare("SELECT * FROM capsules WHERE files LIKE ? ORDER BY ts DESC LIMIT ?")
    .all(`%${pathFragment}%`, opts.limit ?? 20) as CapsuleRow[];
  return rows.map(toCapsule);
}

/** Delta since this consumer's watermark, relevance-filtered by file overlap; advances the mark. */
export function delta(
  db: SubstrateDb,
  consumerId: string,
  opts: { files?: string[]; limit?: number; advance?: boolean } = {},
): Capsule[] {
  const row = db.prepare("SELECT last_capsule_id AS id FROM watermarks WHERE consumer_id = ?").get(consumerId) as
    | { id: number }
    | undefined;
  const after = row?.id ?? 0;
  const rows = db
    .prepare("SELECT * FROM capsules WHERE id > ? ORDER BY id ASC LIMIT ?")
    .all(after, opts.limit ?? 200) as CapsuleRow[];

  let capsules = rows.map(toCapsule);
  if (opts.files && opts.files.length > 0) {
    const interest = opts.files;
    capsules = capsules.filter(
      (c) => c.scope === "global" || c.files.some((f) => interest.some((g) => f.includes(g) || g.includes(f))),
    );
  }
  if (opts.advance !== false && rows.length > 0) {
    db.prepare(
      `INSERT INTO watermarks (consumer_id, last_capsule_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(consumer_id) DO UPDATE SET last_capsule_id = excluded.last_capsule_id, updated_at = excluded.updated_at`,
    ).run(consumerId, rows.at(-1)!.id, Date.now());
  }
  return capsules;
}
