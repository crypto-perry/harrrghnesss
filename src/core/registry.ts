import { randomBytes } from "node:crypto";
import type { SubstrateDb } from "../substrate/db.js";

/**
 * Control-plane registry: projects, agent sessions, telegram bindings.
 * Lives in the same SQLite file as the substrate — one inspectable database.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  name           TEXT PRIMARY KEY,
  repo_url       TEXT,
  path           TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id               TEXT PRIMARY KEY,
  project          TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL,
  worktree_path    TEXT NOT NULL,
  branch           TEXT NOT NULL,
  vendor           TEXT NOT NULL DEFAULT 'codex',
  vendor_thread_id TEXT,
  status           TEXT NOT NULL DEFAULT 'idle',  -- idle | running | archived
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER
);

-- (chat, topic) -> active agent session; one binding per telegram conversation surface
CREATE TABLE IF NOT EXISTS telegram_bindings (
  chat_id    TEXT NOT NULL,
  topic_id   TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  PRIMARY KEY (chat_id, topic_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Additive migrations for columns introduced after first release. */
const MIGRATIONS = ["ALTER TABLE agent_sessions ADD COLUMN parent_id TEXT"];

export interface Project {
  name: string;
  repoUrl: string | null;
  path: string;
  defaultBranch: string;
}

export interface AgentSession {
  id: string;
  /** registered project name, or "" for repo-less sessions */
  project: string;
  title: string;
  /** the session's home folder (may contain repo clones, or nothing) */
  worktreePath: string;
  /** working branch in the session's repo clone, or "" for repo-less sessions */
  branch: string;
  vendor: string;
  vendorThreadId: string | null;
  parentId: string | null;
  status: "idle" | "running" | "archived";
  createdAt: number;
  lastActiveAt: number | null;
}

interface SessionRow {
  id: string;
  project: string;
  title: string;
  worktree_path: string;
  branch: string;
  vendor: string;
  vendor_thread_id: string | null;
  parent_id: string | null;
  status: AgentSession["status"];
  created_at: number;
  last_active_at: number | null;
}

const toSession = (r: SessionRow): AgentSession => ({
  id: r.id,
  project: r.project,
  title: r.title,
  worktreePath: r.worktree_path,
  branch: r.branch,
  vendor: r.vendor,
  vendorThreadId: r.vendor_thread_id,
  parentId: r.parent_id ?? null,
  status: r.status,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
});

export class Registry {
  constructor(private db: SubstrateDb) {
    db.exec(SCHEMA);
    for (const m of MIGRATIONS) {
      try {
        db.exec(m);
      } catch {
        /* column already exists */
      }
    }
    this.dropProjectFkIfPresent();
  }

  /**
   * Repo-less sessions store project = "". Databases created before that change
   * carry a REFERENCES projects(name) constraint SQLite can't drop in place —
   * rebuild the table once.
   */
  private dropProjectFkIfPresent(): void {
    const fks = this.db.pragma("foreign_key_list(agent_sessions)") as { table: string }[];
    if (!fks.some((f) => f.table === "projects")) return;
    // telegram_bindings references this table — FK enforcement must be off for the rebuild
    this.db.pragma("foreign_keys = OFF");
    this.db.exec(`
      BEGIN;
      CREATE TABLE agent_sessions_new (
        id               TEXT PRIMARY KEY,
        project          TEXT NOT NULL DEFAULT '',
        title            TEXT NOT NULL,
        worktree_path    TEXT NOT NULL,
        branch           TEXT NOT NULL,
        vendor           TEXT NOT NULL DEFAULT 'codex',
        vendor_thread_id TEXT,
        status           TEXT NOT NULL DEFAULT 'idle',
        created_at       INTEGER NOT NULL,
        last_active_at   INTEGER,
        parent_id        TEXT
      );
      INSERT INTO agent_sessions_new (id, project, title, worktree_path, branch, vendor, vendor_thread_id, status, created_at, last_active_at, parent_id)
        SELECT id, project, title, worktree_path, branch, vendor, vendor_thread_id, status, created_at, last_active_at, parent_id FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
      COMMIT;
    `);
    this.db.pragma("foreign_keys = ON");
  }

  // ── projects ────────────────────────────────────────────────────────────────

  addProject(p: Project): void {
    this.db
      .prepare("INSERT INTO projects (name, repo_url, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(p.name, p.repoUrl, p.path, p.defaultBranch, Date.now());
  }

  getProject(name: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as
      | { name: string; repo_url: string | null; path: string; default_branch: string }
      | undefined;
    return r ? { name: r.name, repoUrl: r.repo_url, path: r.path, defaultBranch: r.default_branch } : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name").all() as {
      name: string;
      repo_url: string | null;
      path: string;
      default_branch: string;
    }[]).map((r) => ({ name: r.name, repoUrl: r.repo_url, path: r.path, defaultBranch: r.default_branch }));
  }

  // ── agent sessions ──────────────────────────────────────────────────────────

  createSession(
    s: Omit<AgentSession, "id" | "createdAt" | "lastActiveAt" | "status" | "vendorThreadId" | "parentId"> & {
      parentId?: string | null;
    },
  ): AgentSession {
    const id = randomBytes(4).toString("hex");
    this.db
      .prepare(
        `INSERT INTO agent_sessions (id, project, title, worktree_path, branch, vendor, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, s.project, s.title, s.worktreePath, s.branch, s.vendor, s.parentId ?? null, Date.now());
    return this.getSession(id)!;
  }

  getSession(id: string): AgentSession | null {
    const r = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return r ? toSession(r) : null;
  }

  listSessions(opts: { includeArchived?: boolean } = {}): AgentSession[] {
    const sql = opts.includeArchived
      ? "SELECT * FROM agent_sessions ORDER BY created_at DESC"
      : "SELECT * FROM agent_sessions WHERE status != 'archived' ORDER BY created_at DESC";
    return (this.db.prepare(sql).all() as SessionRow[]).map(toSession);
  }

  setWorktree(sessionId: string, worktreePath: string, branch: string): void {
    this.db
      .prepare("UPDATE agent_sessions SET worktree_path = ?, branch = ? WHERE id = ?")
      .run(worktreePath, branch, sessionId);
  }

  setThreadId(sessionId: string, threadId: string): void {
    this.db
      .prepare("UPDATE agent_sessions SET vendor_thread_id = ?, last_active_at = ? WHERE id = ?")
      .run(threadId, Date.now(), sessionId);
  }

  setStatus(sessionId: string, status: AgentSession["status"]): void {
    this.db
      .prepare("UPDATE agent_sessions SET status = ?, last_active_at = ? WHERE id = ?")
      .run(status, Date.now(), sessionId);
  }

  /** Recover from a process death mid-turn: a fresh process has no turns in flight. */
  clearStaleRunning(): void {
    this.db.prepare("UPDATE agent_sessions SET status = 'idle' WHERE status = 'running'").run();
  }

  // ── telegram bindings ───────────────────────────────────────────────────────

  bind(chatId: string, topicId: string | undefined, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO telegram_bindings (chat_id, topic_id, session_id) VALUES (?, ?, ?)
         ON CONFLICT(chat_id, topic_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(chatId, topicId ?? "", sessionId);
  }

  boundSession(chatId: string, topicId: string | undefined): AgentSession | null {
    const r = this.db
      .prepare("SELECT session_id FROM telegram_bindings WHERE chat_id = ? AND topic_id = ?")
      .get(chatId, topicId ?? "") as { session_id: string } | undefined;
    return r ? this.getSession(r.session_id) : null;
  }

  // ── settings (e.g. telegram owner lock) ─────────────────────────────────────

  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}
