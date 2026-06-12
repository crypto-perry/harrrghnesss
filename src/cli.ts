#!/usr/bin/env node
import { Api } from "grammy";
import { openDb } from "./substrate/db.js";
import { sync, defaultRoots } from "./substrate/sync.js";
import { search, peek, read, recent, fileHistory, delta } from "./substrate/search.js";
import { findCollisions } from "./substrate/collisions.js";
import { Registry } from "./core/registry.js";
import { DB_PATH, PROJECTS_ROOT, WORKSPACES_ROOT, loadEnv } from "./core/paths.js";
import { cloneProject, cloneRepoInto } from "./git/repos.js";
import { mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

loadEnv();

const fmtTs = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = openDb(DB_PATH);

  // every command is lazy-sync-first: cheap when nothing changed
  const report = sync(db, defaultRoots());

  switch (cmd) {
    case "sync": {
      out(report);
      return;
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) return fail("usage: harness search <query>");
      for (const h of search(db, q)) {
        console.log(
          `#${h.capsuleId} [${h.via}] ${fmtTs(h.ts)} ${h.vendor}/${h.kind} (${h.sessionId.slice(0, 8)})\n   ${h.preview}${h.files.length ? `\n   files: ${h.files.slice(0, 4).join(", ")}` : ""}`,
        );
      }
      return;
    }
    case "peek": {
      const sid = rest[0];
      if (!sid) return fail("usage: harness peek <sessionId>");
      const sk = peek(db, sid);
      if (!sk) return fail(`unknown session ${sid}`);
      console.log(`${sk.vendor} session ${sk.sessionId}  cwd=${sk.cwd ?? "?"}  capsules=${sk.capsuleCount}`);
      for (const c of sk.capsules) console.log(`  #${c.capsuleId} ${fmtTs(c.ts)} ${c.kind}: ${c.preview}`);
      return;
    }
    case "read": {
      const id = Number(rest[0]);
      if (!id) return fail("usage: harness read <capsuleId>");
      const r = read(db, id);
      if (!r) return fail(`unknown capsule ${id}`);
      out(r);
      return;
    }
    case "recent": {
      for (const c of recent(db, { minutes: Number(rest[0]) || 240 })) {
        console.log(`#${c.id} ${fmtTs(c.ts)} ${c.vendor}/${c.kind}: ${c.summary.slice(0, 120)}`);
      }
      return;
    }
    case "files": {
      const frag = rest[0];
      if (!frag) return fail("usage: harness files <path-fragment>");
      for (const c of fileHistory(db, frag)) {
        console.log(`#${c.id} ${fmtTs(c.ts)} ${c.vendor}/${c.kind} (${c.sessionId.slice(0, 8)}): ${c.summary.slice(0, 110)}`);
      }
      return;
    }
    case "delta": {
      const consumer = rest[0];
      if (!consumer) return fail("usage: harness delta <consumerId> [fileFilter...]");
      out(delta(db, consumer, { files: rest.slice(1) }));
      return;
    }
    case "collisions": {
      const cols = findCollisions(PROJECTS_ROOT, WORKSPACES_ROOT);
      if (cols.length === 0) console.log("no collisions");
      for (const c of cols) console.log(`⚠ ${c.file} dirty in ${c.sites.length} checkouts of ${c.repo}\n   ${c.sites.join("\n   ")}`);
      return;
    }
    // ── control-plane ops (used by the orchestrator agent — keep output JSON) ──
    case "clone": {
      const [url, name] = rest;
      if (!url) return fail("usage: harness clone <git-url> [name]");
      const registry = new Registry(db);
      const p = cloneProject(url, PROJECTS_ROOT, name);
      registry.addProject({ name: p.name, repoUrl: url, path: p.path, defaultBranch: p.defaultBranch });
      out({ ok: true, project: p.name, defaultBranch: p.defaultBranch, path: p.path });
      return;
    }
    case "session-new": {
      const registry = new Registry(db);
      const args = [...rest];
      const flag = (name: string): string | undefined => {
        const i = args.indexOf(`--${name}`);
        if (i === -1) return undefined;
        const v = args[i + 1];
        args.splice(i, 2);
        return v;
      };
      const chatId = flag("chat");
      const topicFlag = flag("topic");
      const title = flag("title") ?? "untitled task";
      const vendor = flag("vendor") ?? "codex";
      const forkOf = flag("fork");
      const projectName = flag("project") ?? args[0]; // positional kept for back-compat
      if (!["codex", "claude"].includes(vendor)) return fail(`unknown vendor '${vendor}' (codex|claude)`);

      const parent = forkOf ? registry.getSession(forkOf) : null;
      if (forkOf && !parent) return fail(`unknown parent session '${forkOf}'`);
      const project = projectName ? registry.getProject(projectName) : parent?.project ? registry.getProject(parent.project) : null;
      if (projectName && !project) return fail(`unknown project '${projectName}' — run: harness clone <url> first`);

      // session first (its id names the workspace and branch), home folder second
      const session = registry.createSession({
        project: project?.name ?? "",
        title: parent ? `${title} (fork of ${parent.id})` : title,
        worktreePath: "pending",
        branch: "",
        vendor,
        parentId: parent?.id ?? null,
      });
      const workspaceDir = join(WORKSPACES_ROOT, session.id);
      mkdirSync(workspaceDir, { recursive: true });

      let branch = "";
      if (parent && parent.branch) {
        // fork: clone the parent's repo at the parent's branch state (committed work carries over)
        const parentRepo = existsSync(join(parent.worktreePath, ".git"))
          ? parent.worktreePath
          : join(parent.worktreePath, project?.name ?? "");
        branch = `harness/${session.id}`;
        cloneRepoInto(parentRepo, project?.repoUrl ?? null, workspaceDir, basename(parentRepo), branch, parent.branch);
      } else if (project) {
        branch = `harness/${session.id}`;
        cloneRepoInto(project.path, project.repoUrl, workspaceDir, project.name, branch, project.defaultBranch);
      }
      // no project, no parent → the workspace starts empty: sessions just exist
      registry.setWorktree(session.id, workspaceDir, branch);

      let topicId = topicFlag;
      const token = process.env["TELEGRAM_BOT_TOKEN"];
      if (chatId && token) {
        const api = new Api(token);
        if (!topicId) {
          const label = project ? `${project.name}: ${title}` : title;
          const topic = await api.createForumTopic(Number(chatId), label.slice(0, 100)).catch(() => null);
          if (topic) topicId = String(topic.message_thread_id);
        }
        if (topicId) {
          registry.bind(chatId, topicId, session.id);
          await api
            .sendMessage(
              Number(chatId),
              `session ${session.id} (${vendor}) ready — "${title}"${branch ? `\nbranch ${branch}` : ""}\ntalk to the agent here.`,
              { message_thread_id: Number(topicId) },
            )
            .catch(() => {});
        }
      }
      out({ ok: true, sessionId: session.id, vendor, workspace: workspaceDir, branch: branch || null, topicId: topicId ?? null, parent: parent?.id ?? null });
      return;
    }
    case "sessions": {
      const registry = new Registry(db);
      out(registry.listSessions());
      return;
    }
    case "bind": {
      const [chatId, topicId, sessionId] = rest;
      if (!chatId || !topicId || !sessionId) return fail("usage: harness bind <chatId> <topicId> <sessionId>");
      const registry = new Registry(db);
      if (!registry.getSession(sessionId)) return fail(`unknown session ${sessionId}`);
      registry.bind(chatId, topicId, sessionId);
      out({ ok: true });
      return;
    }
    case "stats": {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      out({
        sessions: n("SELECT COUNT(*) AS n FROM sessions"),
        capsules: n("SELECT COUNT(*) AS n FROM capsules"),
        byVendor: db.prepare("SELECT vendor, COUNT(*) AS n FROM capsules GROUP BY vendor").all(),
        byKind: db.prepare("SELECT kind, COUNT(*) AS n FROM capsules GROUP BY kind").all(),
        lastSync: report,
      });
      return;
    }
    default:
      fail(
        "harness <command>\n" +
          "  sync                      ingest new session activity (runs implicitly before every command)\n" +
          "  search <query>            trigram search over all agent activity → refs + previews\n" +
          "  peek <sessionId>          one session's skeleton\n" +
          "  read <capsuleId>          full capsule + raw source lines\n" +
          "  recent [minutes]          latest activity across all agents\n" +
          "  files <path-fragment>     who touched this file, when, in which session\n" +
          "  delta <consumerId> [f..]  new-since-last-call, relevance-filtered (advances watermark)\n" +
          "  collisions                files dirty in >1 checkout of the same repo\n" +
          "  stats                     substrate totals",
      );
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

await main();
