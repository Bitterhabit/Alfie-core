import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  STORAGE_SCHEMA_VERSION,
  buildSafeFtsQuery,
  extractSearchDocuments,
  userSqliteFile,
  getUserStorageStatus,
  migrateUserStorageToSqlite,
  searchUserSqlite
} from "../src/storage/sqliteStore.mjs";
import { userDataFile, searchUserWorkspace } from "../src/storage/userJsonStore.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { IdeaStore } from "../src/ideas/store.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { WorkflowProfileStore } from "../src/profile/store.mjs";
import { AuditStore } from "../src/audit/store.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";

test("buildSafeFtsQuery neutralizes FTS5 operators, injection attempts, and punctuation", () => {
  assert.equal(buildSafeFtsQuery(""), "");
  assert.equal(buildSafeFtsQuery("   *** !!! "), "");
  assert.equal(buildSafeFtsQuery("Homelab Proxmox"), '"homelab"* "proxmox"*');
  assert.equal(
    buildSafeFtsQuery('title:secret OR "admin" NEAR/2 (drop; --)'),
    '"title"* "secret"* "or"* "admin"* "near"* "2"* "drop"*'
  );
  // Deduplicates and caps at 10 terms
  const many = buildSafeFtsQuery("a b c d e f g h i j k l m");
  assert.equal(many.split(" ").length, 10);
});

test("extractSearchDocuments extracts memories, projects, decisions, ideas, and skips archived records", () => {
  const memDocs = extractSearchDocuments("memories.json", {
    memories: [
      { id: "m1", title: "ZFS Pool", text: "Mirror vdevs on Proxmox", tags: ["homelab"], trust: "user_authored" },
      { id: "m2", title: "Old Note", text: "Archived content", archived: true }
    ]
  });
  assert.equal(memDocs.length, 1);
  assert.equal(memDocs[0].docId, "memory:m1");
  assert.equal(memDocs[0].entityType, "memory");

  const projDocs = extractSearchDocuments("projects.json", {
    projects: [
      {
        id: "p1",
        name: "Alfie Core",
        vision: "Local-first companion",
        decisions: ["Adopt SQLite WAL — Zero external DB dependency"]
      }
    ]
  });
  assert.equal(projDocs.length, 2);
  assert.ok(projDocs.some((d) => d.entityType === "project" && d.docId === "project:p1"));
  assert.ok(projDocs.some((d) => d.entityType === "decision" && d.title.includes("Adopt SQLite WAL")));
});

test("SQLite WAL stores persist per-user isolated DBs with WAL mode, schema_migrations, and FTS5 cross-entity search", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-sqlite-wal-"));
  try {
    const memoryStore = new MemoryStore({ dataDirectory: dir });
    const projectStore = new ProjectStore({ dataDirectory: dir });
    const ideaStore = new IdeaStore({ dataDirectory: dir });
    const profileStore = new WorkflowProfileStore({ dataDirectory: dir });

    const proj = await projectStore.create("alice", {
      name: "Proxmox Cluster Refresh",
      vision: "Migrate NVMe nodes to ZFS mirrored pools",
      decisions: [{ summary: "Use SQLite WAL", rationale: "ACID local persistence for ZFS metadata" }]
    });
    await memoryStore.create("alice", {
      title: "ZFS ARC limit",
      text: "Cap ZFS ARC memory to 8GB on node-01",
      kind: "fact",
      importance: 8
    });
    await ideaStore.create("alice", {
      title: "Automated ZFS scrub digest #homelab #storage",
      body: "Emit weekly scrub health into Attention Budget digest",
      projectId: proj.id
    });
    await profileStore.addTopic("alice", { topic: "ZFS tuning", confidence: "practicing" });

    // Create unrelated user "bob" to prove strict per-user SQLite isolation
    await memoryStore.create("bob", {
      title: "Bob ZFS secret",
      text: "Bob private ZFS credentials",
      kind: "note"
    });

    const aliceDbPath = userSqliteFile(dir, "alice");
    const bobDbPath = userSqliteFile(dir, "bob");
    assert.notEqual(aliceDbPath, bobDbPath);

    const aliceStat = await fs.stat(aliceDbPath);
    assert.equal(aliceStat.mode & 0o777, 0o600);

    // Inspect WAL mode and schema_migrations directly
    const db = new DatabaseSync(aliceDbPath);
    try {
      const jm = db.prepare("PRAGMA journal_mode").get();
      assert.equal(String(jm.journal_mode).toLowerCase(), "wal");
      const migs = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
      assert.equal(migs.length, STORAGE_SCHEMA_VERSION);
      assert.equal(migs[0].name, "001_user_documents");
      assert.equal(migs[1].name, "002_fts5_search_index");
      assert.equal(migs[2].name, "003_graph_edges");
    } finally {
      db.close();
    }

    // Cross-entity FTS5 search for Alice returns project, memory, idea, topic — never Bob's record
    const res = await searchUserSqlite(dir, "alice", { q: "ZFS", limit: 20 });
    assert.equal(res.backend, "sqlite");
    assert.ok(res.results.length >= 4);
    assert.ok(res.results.some((r) => r.entityType === "project"));
    assert.ok(res.results.some((r) => r.entityType === "memory"));
    assert.ok(res.results.some((r) => r.entityType === "idea"));
    assert.ok(res.results.some((r) => r.entityType === "topic"));
    assert.ok(!res.results.some((r) => r.title.includes("Bob")));

    // Entity type filter narrows cleanly
    const onlyIdeas = await searchUserSqlite(dir, "alice", { q: "ZFS", entityType: "idea" });
    assert.equal(onlyIdeas.results.length, 1);
    assert.equal(onlyIdeas.results[0].entityType, "idea");

    // Storage status reports WAL, integrity OK, indexed FTS5 rows, and graph edges
    const status = await getUserStorageStatus(dir, "alice");
    assert.equal(status.backend, "sqlite");
    assert.equal(status.journalMode, "wal");
    assert.equal(status.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(status.integrityOk, true);
    assert.ok(status.ftsIndexedRows >= 5);
    assert.ok(status.graphIndexedEdges >= 3);
    assert.ok(status.dbSizeBytes > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Transparent legacy JSON-to-SQLite auto-migration and explicit migrateUserStorageToSqlite preserve data losslessly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-sqlite-migrate-"));
  try {
    // Seed legacy flat JSON files directly as if upgrading from v0.3.0
    const memFile = userDataFile(dir, "carol", "memories.json");
    const watcherFile = userDataFile(dir, "carol", "watchers.json");
    await fs.mkdir(path.dirname(memFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(memFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "carol",
      memories: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          origin: "user-seeded",
          source: "garden",
          type: "note",
          kind: "fact",
          trust: "user_authored",
          title: "Legacy NAS IP",
          text: "TrueNAS sits on VLAN 30 with snapshots enabled",
          importance: 7,
          tags: ["nas"],
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    }), "utf8");
    await fs.writeFile(watcherFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "carol",
      watchers: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Legacy Backup Watch",
          kind: "push_metric",
          tier: "digest",
          enabled: true,
          config: { metricName: "backup_age_hours", operator: "gt", threshold: 24 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    }), "utf8");

    // First read via MemoryStore transparently migrates memories.json into SQLite WAL
    const memoryStore = new MemoryStore({ dataDirectory: dir });
    const memories = await memoryStore.list("carol");
    assert.equal(memories.length, 1);
    assert.equal(memories[0].title, "Legacy NAS IP");

    // Legacy file remains untouched for safe rollback
    const legacyStillThere = JSON.parse(await fs.readFile(memFile, "utf8"));
    assert.equal(legacyStillThere.memories.length, 1);

    // Status sees 1 pending legacy collection (watchers.json)
    const beforeMigrate = await getUserStorageStatus(dir, "carol");
    assert.equal(beforeMigrate.pendingLegacyMigrations, 1);

    // Explicit migration imports remaining watchers.json and rebuilds FTS5
    const migration = await migrateUserStorageToSqlite(dir, "carol");
    assert.deepEqual(migration.migratedCollections, ["watchers.json"]);
    assert.ok(migration.alreadyInSqlite.includes("memories.json"));
    assert.ok(migration.ftsIndexedRows >= 2);

    // Re-running migration is idempotent
    const secondRun = await migrateUserStorageToSqlite(dir, "carol");
    assert.deepEqual(secondRun.migratedCollections, []);

    // WatcherStore reads the migrated watcher with default UTC quiet hours
    const watcherStore = new WatcherStore({ dataDirectory: dir });
    const watchers = await watcherStore.list("carol");
    assert.equal(watchers.length, 1);
    assert.equal(watchers[0].name, "Legacy Backup Watch");
    assert.equal(watchers[0].quietHours.timezone, "UTC");

    // FTS5 search finds both migrated records
    const hit = await searchUserWorkspace(dir, "carol", { q: "TrueNAS" });
    assert.equal(hit.results.length, 1);
    assert.equal(hit.results[0].title, "Legacy NAS IP");

    // Explicit JSON fallback mode still works cleanly
    const jsonHit = await searchUserWorkspace(dir, "carol", { q: "TrueNAS", backend: "json" });
    assert.equal(jsonHit.backend, "json");
    assert.equal(jsonHit.results.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP /v1/storage/status, /v1/storage/migrate, and /v1/search enforce per-user isolation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-sqlite-http-"));
  const serviceToken = "service-token-12345678901234567890123456789012";
  const identitySecret = "identity-secret-123456789012345678901234567890";
  const identityAuth = createSignedIdentityAuth({ secret: identitySecret, providerId: "petrio" });
  const server = createAlfieCoreServer({
    serviceToken,
    identityAuth,
    memoryStore: new MemoryStore({ dataDirectory: dir }),
    projectStore: new ProjectStore({ dataDirectory: dir }),
    ideaStore: new IdeaStore({ dataDirectory: dir }),
    watcherStore: new WatcherStore({ dataDirectory: dir }),
    profileStore: new WorkflowProfileStore({ dataDirectory: dir }),
    auditStore: new AuditStore({ dataDirectory: dir })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = createAlfieCoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
    serviceToken,
    identityAuth
  });

  try {
    await client.createMemory("alice", { title: "Kubernetes Ingress", text: "Traefik terminates TLS on homelab", kind: "fact", importance: 7 });
    await client.createMemory("bob", { title: "Bob Traefik Note", text: "Bob private Traefik secret", kind: "note", importance: 5 });

    const aliceStatus = await client.getStorageStatus("alice");
    assert.equal(aliceStatus.storage.backend, "sqlite");
    assert.equal(aliceStatus.storage.journalMode, "wal");
    assert.equal(aliceStatus.storage.integrityOk, true);

    const aliceSearch = await client.searchWorkspace("alice", "q=Traefik");
    assert.equal(aliceSearch.search.total, 1);
    assert.equal(aliceSearch.search.results[0].title, "Kubernetes Ingress");

    const migrateRes = await client.migrateStorage("alice");
    assert.equal(migrateRes.ok, true);
    assert.equal(migrateRes.storage.integrityOk, true);

    // Status endpoint advertises sqlite-wal-storage and fts5-workspace-search
    const statusRes = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: `Bearer ${serviceToken}` }
    });
    const statusBody = await statusRes.json();
    assert.ok(statusBody.implemented.includes("sqlite-wal-storage"));
    assert.ok(statusBody.implemented.includes("fts5-workspace-search"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
