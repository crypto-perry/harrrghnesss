/** Extract plausible file paths from free text (tool args, commands). Deterministic, capped. */

const PATH_RE = /(?:~|\.{0,2})?(?:\/[\w.@~+-]+){2,}/g;

const NOISE_PREFIXES = [
  "/dev/",
  "/proc/",
  "/sys/",
  "/bin/",
  "/usr/bin/",
  "/usr/lib/",
  "/opt/homebrew/",
  "/private/tmp/",
  "/tmp/",
];

export function extractPaths(text: string, explicit: string[] = []): string[] {
  const found = new Set<string>(explicit.filter((p) => p.length > 1));
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0];
    if (p.length < 5) continue;
    if (NOISE_PREFIXES.some((n) => p.startsWith(n))) continue;
    found.add(p);
    if (found.size >= 20) break; // cap — capsules stay small
  }
  return [...found];
}

/** Collapse whitespace and truncate for a single-line capsule summary. */
export function squash(text: string, max = 300): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
