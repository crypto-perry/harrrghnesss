import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SubstrateDb } from "../substrate/db.js";

/**
 * The bridge between the git world and the session world: after each turn,
 * record which commits the turn produced. NULL-absence in this table later
 * distinguishes merged work from abandoned work (the skill-mining gate).
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Git repos in a session home: the folder itself (legacy layout) or its direct children. */
function sessionRepos(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return [];
  if (existsSync(join(sessionDir, ".git"))) return [sessionDir];
  try {
    return readdirSync(sessionDir)
      .map((n) => join(sessionDir, n))
      .filter((p) => existsSync(join(p, ".git")));
  } catch {
    return [];
  }
}

export function snapshotHeads(sessionDir: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const repo of sessionRepos(sessionDir)) {
    try {
      heads.set(repo, git(["rev-parse", "HEAD"], repo).trim());
    } catch {
      heads.set(repo, ""); // unborn HEAD
    }
  }
  return heads;
}

/** Diff repo heads against a pre-turn snapshot; map each new commit to this session's latest capsule. */
export function recordTurnCommits(
  db: SubstrateDb,
  vendorThreadId: string | null,
  sessionDir: string,
  before: Map<string, string>,
): number {
  let recorded = 0;
  const latestCapsule = vendorThreadId
    ? ((db.prepare("SELECT id FROM capsules WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(vendorThreadId) as
        | { id: number }
        | undefined)?.id ?? 0)
    : 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO commit_work_mapping (commit_hash, repo, capsule_id) VALUES (?, ?, ?)",
  );
  for (const repo of sessionRepos(sessionDir)) {
    const old = before.get(repo);
    try {
      const head = git(["rev-parse", "HEAD"], repo).trim();
      if (head === old) continue;
      const range = old ? `${old}..HEAD` : "HEAD";
      const commits = git(["rev-list", range, "--max-count=50"], repo).split("\n").filter(Boolean);
      for (const c of commits) {
        insert.run(c, repo, latestCapsule);
        recorded += 1;
      }
    } catch {
      /* repo vanished mid-turn or unborn HEAD — skip */
    }
  }
  return recorded;
}
