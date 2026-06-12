#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../substrate/db.js";
import { sync, defaultRoots } from "../substrate/sync.js";
import { search, peek, read, recent, fileHistory, delta } from "../substrate/search.js";
import { findCollisions } from "../substrate/collisions.js";

/**
 * MCP server over the harness substrate. Staged retrieval: search → peek → read.
 * Every tool lazy-syncs first, so results always reflect session files as of this call.
 *
 * Tool descriptions carry explicit trigger conditions — models under-reach for tools
 * unless told *when* to call them, not just what they do.
 */

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env["HARNESS_DB"] ?? join(HARNESS_ROOT, ".harness", "substrate.db");
const PROJECTS_ROOT = process.env["HARNESS_PROJECTS"] ?? join(HARNESS_ROOT, "projects");

const db = openDb(DB_PATH);
const fresh = () => sync(db, defaultRoots());
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "harness-substrate", version: "0.1.0" });

server.registerTool(
  "substrate_search",
  {
    description:
      "Search ALL agent activity in this workspace (every Claude/Codex session, past and parallel). " +
      "Call this BEFORE starting work on a file or topic another agent might have touched, and whenever the user " +
      "references past work ('we discussed', 'another session', 'before'). Returns capsule refs + one-line previews " +
      "(cheap). Follow up with substrate_peek/substrate_read for detail — do not guess from previews.",
    inputSchema: {
      query: z.string().describe("topic, file name, identifier, or phrase (typo-tolerant trigram match)"),
      limit: z.number().optional(),
      sessionId: z.string().optional().describe("restrict to one session"),
    },
  },
  async ({ query, limit, sessionId }) => {
    fresh();
    return json(search(db, query, { limit, sessionId }));
  },
);

server.registerTool(
  "substrate_peek",
  {
    description:
      "Skeleton of one agent session: metadata + its capsules (kind, time, preview, files). " +
      "Call after substrate_search to scope which part of a session matters before paying for substrate_read.",
    inputSchema: { sessionId: z.string(), limit: z.number().optional() },
  },
  async ({ sessionId, limit }) => {
    fresh();
    return json(peek(db, sessionId, { limit }));
  },
);

server.registerTool(
  "substrate_read",
  {
    description:
      "Full detail of one capsule, including the raw session-transcript lines it was distilled from (capped at 4KB). " +
      "The most expensive stage — call only on capsules already identified via substrate_search/substrate_peek.",
    inputSchema: { capsuleId: z.number() },
  },
  async ({ capsuleId }) => {
    fresh();
    return json(read(db, capsuleId));
  },
);

server.registerTool(
  "substrate_recent",
  {
    description:
      "Latest activity across ALL agents and sessions in this workspace. Call at the start of a task to learn what " +
      "happened since you last looked, and after long gaps (user stepped away, you resumed a session).",
    inputSchema: { minutes: z.number().optional().describe("look-back window, default 240"), limit: z.number().optional() },
  },
  async ({ minutes, limit }) => {
    fresh();
    return json(recent(db, { minutes, limit }));
  },
);

server.registerTool(
  "substrate_file_history",
  {
    description:
      "Who touched a file, when, in which session — across every agent. Call BEFORE editing any file you have not " +
      "read in this session, to avoid acting on stale assumptions about it.",
    inputSchema: { path: z.string().describe("path or fragment, e.g. src/auth"), limit: z.number().optional() },
  },
  async ({ path, limit }) => {
    fresh();
    return json(fileHistory(db, path, { limit }));
  },
);

server.registerTool(
  "substrate_collisions",
  {
    description:
      "Files currently dirty in MORE THAN ONE checkout/worktree of the same repo — i.e. parallel work on a merge " +
      "collision course. Call before starting edits in any repo under projects/ and before committing.",
    inputSchema: {},
  },
  async () => json(findCollisions(PROJECTS_ROOT)),
);

server.registerTool(
  "substrate_delta",
  {
    description:
      "Everything new since YOUR last call, filtered to files you care about (plus global-scope events). " +
      "Advances your watermark — results never repeat. Call at the start of each work burst with a stable consumerId " +
      "(e.g. your session id) and the files you are working on.",
    inputSchema: {
      consumerId: z.string().describe("stable id for this consumer, e.g. your session id"),
      files: z.array(z.string()).optional().describe("interest filter; omit for unfiltered"),
      limit: z.number().optional(),
    },
  },
  async ({ consumerId, files, limit }) => {
    fresh();
    return json(delta(db, consumerId, { files, limit }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
