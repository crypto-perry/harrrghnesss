import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

/** Plain git over SSH — no gh, no API. Worktree-per-session keeps parallel agents isolated. */

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

export function nameFromUrl(url: string): string {
  return basename(url.replace(/\.git$/, "")).toLowerCase();
}

export function cloneProject(url: string, projectsRoot: string, name?: string): { name: string; path: string; defaultBranch: string } {
  const projectName = name ?? nameFromUrl(url);
  const path = join(projectsRoot, projectName);
  if (existsSync(path)) throw new Error(`projects/${projectName} already exists`);
  mkdirSync(projectsRoot, { recursive: true });
  git(["clone", url, path]);
  const defaultBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], path).trim();
  return { name: projectName, path, defaultBranch };
}

/**
 * One worktree per agent session, as a sibling under projects/ so the collision
 * scanner sees it: projects/<project>--<sessionId>, on branch harness/<sessionId>.
 */
export function createSessionWorktree(
  projectPath: string,
  projectsRoot: string,
  projectName: string,
  sessionId: string,
  baseBranch: string,
): { worktreePath: string; branch: string } {
  const branch = `harness/${sessionId}`;
  const worktreePath = join(projectsRoot, `${projectName}--${sessionId}`);
  git(["worktree", "add", "-b", branch, worktreePath, baseBranch], projectPath);
  return { worktreePath, branch };
}

export function worktreeStatus(worktreePath: string): { branch: string; dirty: string[]; ahead: number } {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).trim();
  const dirty = git(["status", "--porcelain"], worktreePath).split("\n").filter(Boolean);
  let ahead = 0;
  try {
    const counts = git(["rev-list", "--left-right", "--count", `origin/HEAD...HEAD`], worktreePath).trim();
    ahead = Number(counts.split("\t")[1] ?? 0);
  } catch {
    /* no upstream — fine */
  }
  return { branch, dirty, ahead };
}
