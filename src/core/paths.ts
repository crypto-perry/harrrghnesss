import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Layout:
 *   <workspace>/            umbrella — not a git repo
 *     harness/              this repo (code only)
 *     projects/             cloned repos + session worktrees
 *     .harness/             substrate db + workspace state
 */

/** Root of the harness repo (the directory containing package.json). */
export const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The umbrella workspace that contains harness/, projects/, .harness/. */
export const WORKSPACE_ROOT = process.env["HARNESS_WORKSPACE"] ?? join(HARNESS_ROOT, "..");

export const DB_PATH = process.env["HARNESS_DB"] ?? join(WORKSPACE_ROOT, ".harness", "substrate.db");

export const PROJECTS_ROOT = process.env["HARNESS_PROJECTS"] ?? join(WORKSPACE_ROOT, "projects");

export function loadEnv(): void {
  try {
    process.loadEnvFile(join(HARNESS_ROOT, ".env"));
  } catch {
    /* .env optional */
  }
}
