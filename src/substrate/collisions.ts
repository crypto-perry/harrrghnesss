import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Collision detection without any session parsing: two checkouts of the same repo
 * (clones or linked worktrees) with uncommitted changes to the same file are on a
 * merge collision course. Pure git — works on day one, no index required.
 */

export interface Collision {
  repo: string;
  file: string;
  /** checkout paths where this file is dirty */
  sites: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Identity key for "same repo": origin URL when present, else the main worktree path. */
function repoIdentity(dir: string): string {
  try {
    const url = git(["remote", "get-url", "origin"], dir).trim();
    if (url) return url;
  } catch {
    /* no origin */
  }
  try {
    return git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir).trim();
  } catch {
    return dir;
  }
}

function dirtyFiles(dir: string): string[] {
  try {
    return git(["status", "--porcelain"], dir)
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** All checkouts of a repo: the directory itself plus its linked worktrees. */
function checkouts(dir: string): string[] {
  try {
    const out = git(["worktree", "list", "--porcelain"], dir);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  } catch {
    return [dir];
  }
}

function gitDirsUnder(root: string, depth: 1 | 2): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepo(p)) dirs.push(p);
    else if (depth === 2) dirs.push(...gitDirsUnder(p, 1));
  }
  return dirs;
}

/**
 * Scan every checkout the harness knows about: project caches (projects/<name>)
 * and session repos (workspaces/<id>/<name>).
 */
export function findCollisions(projectsRoot: string, workspacesRoot?: string): Collision[] {
  const repoDirs = [
    ...gitDirsUnder(projectsRoot, 1),
    ...(workspacesRoot ? gitDirsUnder(workspacesRoot, 2) : []),
  ];
  if (repoDirs.length === 0) return [];

  // group every checkout (clone or worktree) by repo identity
  const byIdentity = new Map<string, Set<string>>();
  for (const dir of repoDirs) {
    const id = repoIdentity(dir);
    const set = byIdentity.get(id) ?? new Set<string>();
    for (const c of checkouts(dir)) set.add(c);
    set.add(dir);
    byIdentity.set(id, set);
  }

  const collisions: Collision[] = [];
  for (const [identity, sites] of byIdentity) {
    if (sites.size < 2) continue;
    const dirtyBySite = new Map<string, Set<string>>();
    for (const site of sites) dirtyBySite.set(site, new Set(dirtyFiles(site)));

    const fileSites = new Map<string, string[]>();
    for (const [site, files] of dirtyBySite) {
      for (const f of files) {
        const arr = fileSites.get(f) ?? [];
        arr.push(site);
        fileSites.set(f, arr);
      }
    }
    for (const [file, where] of fileSites) {
      if (where.length >= 2) collisions.push({ repo: identity, file, sites: where.sort() });
    }
  }
  return collisions;
}
