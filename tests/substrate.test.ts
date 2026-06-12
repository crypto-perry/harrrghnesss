import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SubstrateDb } from "../src/substrate/db.js";
import { sync, type SyncRoots } from "../src/substrate/sync.js";
import { search, peek, read, fileHistory, delta } from "../src/substrate/search.js";
import { tailCodexLines } from "../src/substrate/tailers/codex.js";
import { tailClaudeLines } from "../src/substrate/tailers/claude.js";
import { TailerSchemaError } from "../src/core/types.js";

// ── fixtures mirror the real on-disk formats observed 2026-06-12 ──────────────

const CODEX_UUID = "019ea878-7283-7c90-999f-9e8d57752799";
const codexLine = (payload: object, type = "event_msg") =>
  JSON.stringify({ timestamp: "2026-06-08T19:22:06.019Z", type, payload });

const CODEX_FIXTURE = [
  codexLine({ cwd: "/Users/hepl/harrrghnesss" }, "session_meta"),
  codexLine({ type: "user_message", message: "Ok we want to build an AI harness for telegram" }),
  codexLine({ type: "agent_message", message: "I will design a context compiler around src/context/compiler.ts" }),
  codexLine({ type: "function_call", name: "shell", arguments: '{"command":["cat","/Users/hepl/projects/demo/src/auth/session.ts"]}' }, "response_item"),
  codexLine({ type: "token_count", info: {} }),
  codexLine({ type: "reasoning", summary: [] }, "response_item"),
].join("\n");

const CLAUDE_UUID = "6eb7ac9a-2b12-4759-b660-1733b3beac91";
const claudeUser = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    uuid: "u1",
    timestamp: "2026-06-12T11:13:49.155Z",
    cwd: "/Users/hepl/harrrghnesss",
  });
const claudeAssistant = (blocks: object[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: blocks },
    uuid: "a1",
    timestamp: "2026-06-12T11:14:02.000Z",
  });

const CLAUDE_FIXTURE = [
  JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-06-12T11:13:49.115Z" }),
  claudeUser("can you load the fable model please"),
  claudeAssistant([
    { type: "text", text: "Editing the settings now." },
    { type: "tool_use", name: "Edit", input: { file_path: "/Users/hepl/.claude/settings.json" } },
  ]),
  JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
].join("\n");

// ── tailer unit tests ──────────────────────────────────────────────────────────

describe("codex tailer", () => {
  const path = `/x/.codex/sessions/2026/06/08/rollout-2026-06-08T19-22-06-${CODEX_UUID}.jsonl`;

  it("extracts user/agent/tool capsules and cwd, skips noise", () => {
    const r = tailCodexLines(path, CODEX_FIXTURE.split("\n"), 1);
    expect(r.sessionId).toBe(CODEX_UUID);
    expect(r.cwd).toBe("/Users/hepl/harrrghnesss");
    expect(r.events.map((e) => e.kind)).toEqual(["user", "agent", "tool"]);
    expect(r.events[2]!.files).toContain("/Users/hepl/projects/demo/src/auth/session.ts");
    expect(r.unknownLines).toBe(0);
  });

  it("fails loud on schema drift instead of misparsing", () => {
    expect(() => tailCodexLines(path, ['{"totally":"different"}'], 1)).toThrow(TailerSchemaError);
  });
});

describe("claude tailer", () => {
  const path = `/x/.claude/projects/-Users-hepl-harrrghnesss/${CLAUDE_UUID}.jsonl`;

  it("extracts conversation + tool_use with explicit file paths, skips harness noise", () => {
    const r = tailClaudeLines(path, CLAUDE_FIXTURE.split("\n"), 1);
    expect(r.sessionId).toBe(CLAUDE_UUID);
    expect(r.events.map((e) => e.kind)).toEqual(["user", "agent", "tool"]);
    expect(r.events[2]!.files).toContain("/Users/hepl/.claude/settings.json");
    expect(r.events[2]!.summary).toContain("Edit");
  });

  it("skips sidechain (subagent) lines", () => {
    const side = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
      timestamp: "2026-06-12T11:15:00.000Z",
    });
    const r = tailClaudeLines(path, [side], 1);
    expect(r.events).toHaveLength(0);
  });
});

// ── end-to-end: sync → search/peek/read/delta over a fake home dir ────────────

describe("sync + staged retrieval", () => {
  let home: string;
  let db: SubstrateDb;
  let roots: SyncRoots;
  let codexFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "harness-test-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "06", "08");
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    codexFile = join(codexDir, `rollout-2026-06-08T19-22-06-${CODEX_UUID}.jsonl`);
    writeFileSync(codexFile, CODEX_FIXTURE + "\n");
    writeFileSync(join(claudeDir, `${CLAUDE_UUID}.jsonl`), CLAUDE_FIXTURE + "\n");
    db = openDb(join(home, "substrate.db"));
    roots = { claudeProjects: join(home, ".claude", "projects"), codexSessions: join(home, ".codex", "sessions") };
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("ingests both vendors; second sync is a no-op (idempotent offsets)", () => {
    const first = sync(db, roots);
    expect(first.filesParsed).toBe(2);
    expect(first.capsulesAdded).toBe(6);
    const second = sync(db, roots);
    expect(second.capsulesAdded).toBe(0);
    expect(second.filesParsed).toBe(0);
  });

  it("picks up appended lines only, and tolerates a partial trailing line", () => {
    sync(db, roots);
    // writer mid-append: complete line + partial line without newline
    appendFileSync(codexFile, codexLine({ type: "user_message", message: "new turn about webhooks" }) + "\n");
    appendFileSync(codexFile, '{"timestamp":"2026-06-08T20:00:00Z","type":"event_msg","pa'); // torn write
    const r = sync(db, roots);
    expect(r.capsulesAdded).toBe(1);
    // the torn line is processed once completed
    appendFileSync(codexFile, 'yload":{"type":"agent_message","message":"completed torn line"}}\n');
    const r2 = sync(db, roots);
    expect(r2.capsulesAdded).toBe(1);
    expect(search(db, "completed torn line")[0]).toBeDefined();
  });

  it("search → peek → read stages resolve down to provenance", () => {
    sync(db, roots);
    const hits = search(db, "fable model");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.via).toBe("fts");

    const sk = peek(db, hits[0]!.sessionId);
    expect(sk).not.toBeNull();
    expect(sk!.capsuleCount).toBeGreaterThan(0);

    const full = read(db, hits[0]!.capsuleId);
    expect(full).not.toBeNull();
    expect(full!.rawRef).toMatch(/\.jsonl:\d+-\d+$/);
    expect(full!.raw).toContain("fable"); // raw stage resolves to the actual transcript line
  });

  it("typo-tolerant search via trigram", () => {
    sync(db, roots);
    // 'telegrm' (typo) still finds the telegram capsule
    const hits = search(db, "telegrm harness");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("file history attributes work to sessions", () => {
    sync(db, roots);
    const hist = fileHistory(db, "settings.json");
    expect(hist.length).toBe(1);
    expect(hist[0]!.sessionId).toBe(CLAUDE_UUID);
  });

  it("delta: watermark advances, file-filter applies, never repeats", () => {
    sync(db, roots);
    const all = delta(db, "consumer-1");
    expect(all.length).toBe(6);
    expect(delta(db, "consumer-1").length).toBe(0); // advanced — nothing repeats

    appendFileSync(
      codexFile,
      codexLine({ type: "function_call", name: "shell", arguments: '{"command":["touch","/repo/src/auth/token.ts"]}' }, "response_item") + "\n" +
        codexLine({ type: "user_message", message: "unrelated chatter" }) + "\n",
    );
    sync(db, roots);
    const filtered = delta(db, "consumer-1", { files: ["src/auth"] });
    expect(filtered.length).toBe(1); // only the auth-touching capsule survives the interest filter
    expect(filtered[0]!.files.join()).toContain("src/auth/token.ts");
  });

  it("schema drift quarantines the file without poisoning the db", () => {
    sync(db, roots);
    appendFileSync(codexFile, '{"no_envelope":true}\n');
    const r = sync(db, roots);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.error).toContain("schema drift");
    expect(r.capsulesAdded).toBe(0);
  });
});
