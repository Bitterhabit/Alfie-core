import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { safeUserKey, userDataFile } from "./userJsonStore.mjs";

export const STORAGE_SCHEMA_VERSION = 3;

export const KNOWN_COLLECTIONS = Object.freeze([
  "memories.json",
  "projects.json",
  "ideas.json",
  "conversations.json",
  "permissions.json",
  "pending-actions.json",
  "audit.json",
  "watchers.json",
  "watcher-events.json",
  "workflow-profile.json",
  "context-capsules.json",
  "jobs.json",
  "reflections.json",
  "peer-tokens.json",
  "playbooks.json"
]);

const COLLECTION_SET = new Set(KNOWN_COLLECTIONS);
const ENTITY_TYPE_SET = new Set([
  "memory",
  "project",
  "decision",
  "idea",
  "conversation",
  "capsule",
  "watcher",
  "topic"
]);

export function resolveStorageBackend(override) {
  const candidate = String(override || process.env.ALFIE_STORAGE_BACKEND || "sqlite").trim().toLowerCase();
  return candidate === "json" ? "json" : "sqlite";
}

export function userSqliteFile(dataDirectory, userId) {
  return userDataFile(dataDirectory, userId, "alfie.sqlite");
}

function cleanText(value, maxLen = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * Sanitizes an untrusted user query string into a safe FTS5 MATCH expression.
 * Strips all FTS5 operator syntax (AND, OR, NOT, NEAR, col:, quotes, parens)
 * and emits quoted prefix terms so malformed input can never throw or inject.
 */
export function buildSafeFtsQuery(rawQuery) {
  const cleaned = String(rawQuery || "").trim().slice(0, 200);
  if (!cleaned) return "";
  const rawTokens = cleaned.match(/[\p{L}\p{N}_-]+/gu) || [];
  const terms = [];
  const seen = new Set();
  for (const raw of rawTokens) {
    const token = raw.replace(/^[-_]+|[-_]+$/g, "").toLowerCase().slice(0, 48);
    if (!token || token.length < 1) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(`"${token}"*`);
    if (terms.length >= 10) break;
  }
  return terms.join(" ");
}

/**
 * Extracts flat FTS5-indexable records from a user collection document.
 * Pure & deterministic — no I/O or external calls.
 */
export function extractSearchDocuments(collection, payload) {
  if (!payload || typeof payload !== "object") return [];
  const docs = [];

  if (collection === "memories.json" && Array.isArray(payload.memories)) {
    for (const m of payload.memories) {
      if (!m || typeof m !== "object" || m.archived) continue;
      const id = cleanText(m.id, 80);
      if (!id) continue;
      docs.push({
        docId: `memory:${id}`,
        collection,
        entityType: "memory",
        projectId: "",
        title: cleanText(m.title || m.text, 180),
        body: cleanText(m.text, 2400),
        tags: Array.isArray(m.tags) ? m.tags.map((t) => cleanText(t, 40)).filter(Boolean).join(" ") : "",
        trust: cleanText(m.trust || m.provenance?.trust || "user_authored", 40),
        updatedAt: cleanText(m.updatedAt || m.createdAt || "", 40)
      });
    }
  } else if (collection === "projects.json" && Array.isArray(payload.projects)) {
    for (const p of payload.projects) {
      if (!p || typeof p !== "object") continue;
      const id = cleanText(p.id, 80);
      if (!id) continue;
      const bodyParts = [
        p.vision,
        p.description,
        p.architecture,
        ...(Array.isArray(p.nextActions) ? p.nextActions : []),
        ...(Array.isArray(p.blockers) ? p.blockers : []),
        ...(Array.isArray(p.postponed) ? p.postponed : [])
      ].filter(Boolean);
      docs.push({
        docId: `project:${id}`,
        collection,
        entityType: "project",
        projectId: id,
        title: cleanText(p.name, 180),
        body: cleanText(bodyParts.join(" · "), 2400),
        tags: cleanText(p.status || "active", 40),
        trust: "user_authored",
        updatedAt: cleanText(p.updatedAt || p.createdAt || "", 40)
      });
      if (Array.isArray(p.decisions)) {
        p.decisions.forEach((dec, idx) => {
          const text = typeof dec === "string"
            ? dec
            : [dec?.summary || dec?.decision || dec?.text || "", dec?.rationale || ""].filter(Boolean).join(" — ");
          if (!text) return;
          docs.push({
            docId: `decision:${id}:${idx}`,
            collection,
            entityType: "decision",
            projectId: id,
            title: cleanText(text.split(/\s+[—–-]\s+/)[0] || text, 180),
            body: cleanText(`${p.name || "Project"}: ${text}`, 1200),
            tags: "decision",
            trust: "user_authored",
            updatedAt: cleanText(p.updatedAt || p.createdAt || "", 40)
          });
        });
      }
    }
  } else if (collection === "ideas.json" && Array.isArray(payload.ideas)) {
    for (const idea of payload.ideas) {
      if (!idea || typeof idea !== "object" || idea.status === "archived") continue;
      const id = cleanText(idea.id, 80);
      if (!id) continue;
      docs.push({
        docId: `idea:${id}`,
        collection,
        entityType: "idea",
        projectId: cleanText(idea.projectId || "", 80),
        title: cleanText(idea.title, 180),
        body: cleanText([idea.body, idea.sourceContext].filter(Boolean).join(" · "), 2400),
        tags: Array.isArray(idea.tags) ? idea.tags.map((t) => cleanText(t, 40)).filter(Boolean).join(" ") : "",
        trust: "user_authored",
        updatedAt: cleanText(idea.updatedAt || idea.createdAt || "", 40)
      });
    }
  } else if (collection === "conversations.json" && Array.isArray(payload.conversations)) {
    for (const conv of payload.conversations) {
      if (!conv || typeof conv !== "object") continue;
      const id = cleanText(conv.id, 80);
      if (!id) continue;
      const recentMsgs = Array.isArray(conv.messages)
        ? conv.messages.slice(-8).map((m) => cleanText(m?.content || "", 320)).filter(Boolean).join(" ")
        : "";
      docs.push({
        docId: `conversation:${id}`,
        collection,
        entityType: "conversation",
        projectId: cleanText(conv.projectId || "", 80),
        title: cleanText(conv.title || "Untitled conversation", 180),
        body: cleanText(recentMsgs, 2400),
        tags: cleanText(conv.workingMode || "", 40),
        trust: "user_authored",
        updatedAt: cleanText(conv.updatedAt || conv.createdAt || "", 40)
      });
    }
  } else if (collection === "context-capsules.json" && Array.isArray(payload.capsules)) {
    for (const cap of payload.capsules) {
      if (!cap || typeof cap !== "object") continue;
      const id = cleanText(cap.id, 80);
      if (!id) continue;
      docs.push({
        docId: `capsule:${id}`,
        collection,
        entityType: "capsule",
        projectId: cleanText(cap.projectId || "", 80),
        title: cleanText(cap.name, 180),
        body: cleanText([cap.description, cap.workingMode, cap.learningMode, cap.privacyPosture].filter(Boolean).join(" · "), 1200),
        tags: cleanText([cap.workingMode, cap.privacyPosture].filter(Boolean).join(" "), 120),
        trust: "user_authored",
        updatedAt: cleanText(cap.updatedAt || cap.createdAt || "", 40)
      });
    }
  } else if (collection === "watchers.json" && Array.isArray(payload.watchers)) {
    for (const w of payload.watchers) {
      if (!w || typeof w !== "object") continue;
      const id = cleanText(w.id, 80);
      if (!id) continue;
      docs.push({
        docId: `watcher:${id}`,
        collection,
        entityType: "watcher",
        projectId: cleanText(w.projectId || "", 80),
        title: cleanText(w.name, 180),
        body: cleanText([w.kind, w.tier, w.config?.url, w.config?.metricName].filter(Boolean).join(" · "), 1200),
        tags: cleanText([w.kind, w.tier].filter(Boolean).join(" "), 80),
        trust: w.kind === "http_probe" ? "external_untrusted" : "system_verified",
        updatedAt: cleanText(w.updatedAt || w.createdAt || "", 40)
      });
    }
  } else if (collection === "workflow-profile.json" && payload.profile && Array.isArray(payload.profile.learningTopics)) {
    for (const topic of payload.profile.learningTopics) {
      if (!topic || typeof topic !== "object") continue;
      const id = cleanText(topic.id || topic.topic, 80);
      if (!id) continue;
      docs.push({
        docId: `topic:${id}`,
        collection,
        entityType: "topic",
        projectId: "",
        title: cleanText(topic.topic, 180),
        body: cleanText([topic.confidence, topic.notes].filter(Boolean).join(" · "), 1200),
        tags: cleanText(topic.confidence || "exploring", 60),
        trust: "user_authored",
        updatedAt: cleanText(topic.updatedAt || payload.profile.updatedAt || "", 40)
      });
    }
  }

  return docs;
}

/**
 * Extracts deterministic structural graph edges for a collection so the
 * `graph_edges` SQLite index stays synced on every write.
 */
export function extractCollectionGraphEdges(collection, payload) {
  if (!payload || typeof payload !== "object") return [];
  const edges = [];

  if (collection === "projects.json" && Array.isArray(payload.projects)) {
    for (const p of payload.projects) {
      if (!p?.id) continue;
      if (Array.isArray(p.decisions)) {
        p.decisions.forEach((dec, idx) => {
          if (dec) edges.push({ sourceId: `project:${p.id}`, targetId: `decision:${p.id}:${idx}`, kind: "recorded_decision" });
        });
      }
    }
  } else if (collection === "ideas.json" && Array.isArray(payload.ideas)) {
    for (const idea of payload.ideas) {
      if (!idea?.id) continue;
      if (idea.projectId) {
        edges.push({ sourceId: `idea:${idea.id}`, targetId: `project:${idea.projectId}`, kind: "linked_project" });
      }
      if (Array.isArray(idea.tags)) {
        for (const tag of idea.tags) {
          const clean = cleanText(tag, 40).toLowerCase();
          if (clean) edges.push({ sourceId: `idea:${idea.id}`, targetId: `tag:${clean}`, kind: "tagged_with" });
        }
      }
    }
  } else if (collection === "memories.json" && Array.isArray(payload.memories)) {
    for (const m of payload.memories) {
      if (!m?.id || m.archived) continue;
      if (Array.isArray(m.tags)) {
        for (const tag of m.tags) {
          const clean = cleanText(tag, 40).toLowerCase();
          if (clean) edges.push({ sourceId: `memory:${m.id}`, targetId: `tag:${clean}`, kind: "tagged_with" });
        }
      }
    }
  } else if (collection === "context-capsules.json" && Array.isArray(payload.capsules)) {
    for (const cap of payload.capsules) {
      if (cap?.id && cap.projectId) {
        edges.push({ sourceId: `capsule:${cap.id}`, targetId: `project:${cap.projectId}`, kind: "binds_project" });
      }
    }
  } else if (collection === "watchers.json" && Array.isArray(payload.watchers)) {
    for (const w of payload.watchers) {
      if (w?.id && w.projectId) {
        edges.push({ sourceId: `watcher:${w.id}`, targetId: `project:${w.projectId}`, kind: "monitors_project" });
      }
    }
  }

  return edges;
}

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "001_user_documents",
    sql: `
      CREATE TABLE IF NOT EXISTS user_documents (
        collection TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        migrated_from TEXT,
        legacy_mtime_ms REAL
      );
    `
  },
  {
    version: 2,
    name: "002_fts5_search_index",
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        doc_id UNINDEXED,
        collection UNINDEXED,
        entity_type UNINDEXED,
        project_id UNINDEXED,
        trust UNINDEXED,
        updated_at UNINDEXED,
        title,
        body,
        tags,
        tokenize = 'unicode61'
      );
    `
  },
  {
    version: 3,
    name: "003_graph_edges",
    sql: `
      CREATE TABLE IF NOT EXISTS graph_edges (
        collection TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, source_id, target_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
    `
  }
]);

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all();
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

async function openUserDb(dataDirectory, userId) {
  const dbPath = userSqliteFile(dataDirectory, userId);
  const directory = path.dirname(dbPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA temp_store = MEMORY;");
    applyMigrations(db);
    await fs.chmod(dbPath, 0o600).catch(() => {});
    return { db, dbPath };
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function indexCollectionTx(db, collection, payload, updatedAt) {
  const docs = extractSearchDocuments(collection, payload);
  db.prepare("DELETE FROM search_index WHERE collection = ?").run(collection);
  if (docs.length) {
    const insertDoc = db.prepare(
      `INSERT INTO search_index (doc_id, collection, entity_type, project_id, trust, updated_at, title, body, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const doc of docs) {
      insertDoc.run(
        doc.docId,
        doc.collection,
        doc.entityType,
        doc.projectId,
        doc.trust,
        doc.updatedAt || updatedAt,
        doc.title,
        doc.body,
        doc.tags
      );
    }
  }

  const edges = extractCollectionGraphEdges(collection, payload);
  db.prepare("DELETE FROM graph_edges WHERE collection = ?").run(collection);
  if (edges.length) {
    const insertEdge = db.prepare(
      `INSERT OR REPLACE INTO graph_edges (collection, source_id, target_id, kind, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const edge of edges) {
      insertEdge.run(collection, edge.sourceId, edge.targetId, edge.kind, updatedAt);
    }
  }

  return docs.length;
}

function countCollectionRecords(collection, payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (collection === "memories.json" && Array.isArray(payload.memories)) return payload.memories.length;
  if (collection === "projects.json" && Array.isArray(payload.projects)) return payload.projects.length;
  if (collection === "ideas.json" && Array.isArray(payload.ideas)) return payload.ideas.length;
  if (collection === "conversations.json" && Array.isArray(payload.conversations)) return payload.conversations.length;
  if (collection === "permissions.json" && Array.isArray(payload.leases)) return payload.leases.length;
  if (collection === "permissions.json" && Array.isArray(payload.scopes)) return payload.scopes.length;
  if (collection === "pending-actions.json" && Array.isArray(payload.actions)) return payload.actions.length;
  if (collection === "audit.json" && Array.isArray(payload.events)) return payload.events.length;
  if (collection === "watchers.json" && Array.isArray(payload.watchers)) return payload.watchers.length;
  if (collection === "watcher-events.json" && Array.isArray(payload.events)) return payload.events.length;
  if (collection === "context-capsules.json" && Array.isArray(payload.capsules)) return payload.capsules.length;
  if (collection === "workflow-profile.json" && payload.profile) {
    return 1 + (Array.isArray(payload.profile.learningTopics) ? payload.profile.learningTopics.length : 0);
  }
  return 1;
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readUserSqliteDocument(dataDirectory, userId, collection) {
  safeUserKey(userId);
  const dbPath = userSqliteFile(dataDirectory, userId);
  const legacyPath = userDataFile(dataDirectory, userId, collection);
  const dbStat = await statOrNull(dbPath);

  if (dbStat) {
    const { db } = await openUserDb(dataDirectory, userId);
    try {
      const row = db.prepare("SELECT payload_json FROM user_documents WHERE collection = ?").get(collection);
      if (row && typeof row.payload_json === "string") {
        return JSON.parse(row.payload_json);
      }
    } finally {
      db.close();
    }
  }

  // Not yet in SQLite: check for legacy flat JSON file and transparently migrate once
  const legacyStat = await statOrNull(legacyPath);
  if (!legacyStat) return null;

  const raw = await fs.readFile(legacyPath, "utf8");
  const parsed = JSON.parse(raw);

  const { db } = await openUserDb(dataDirectory, userId);
  try {
    const updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(parsed);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO user_documents (collection, payload_json, revision, updated_at, migrated_from, legacy_mtime_ms)
         VALUES (?, ?, 1, ?, 'legacy-json', ?)
         ON CONFLICT(collection) DO NOTHING`
      ).run(collection, serialized, updatedAt, legacyStat.mtimeMs);
      indexCollectionTx(db, collection, parsed, updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    db.close();
  }

  return parsed;
}

export async function writeUserSqliteDocument(dataDirectory, userId, collection, payload) {
  safeUserKey(userId);
  const { db } = await openUserDb(dataDirectory, userId);
  const updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(payload);
  try {
    let indexedRows = 0;
    let revision = 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO user_documents (collection, payload_json, revision, updated_at, migrated_from, legacy_mtime_ms)
         VALUES (?, ?, 1, ?, NULL, NULL)
         ON CONFLICT(collection) DO UPDATE SET
           payload_json = excluded.payload_json,
           revision = user_documents.revision + 1,
           updated_at = excluded.updated_at`
      ).run(collection, serialized, updatedAt);
      const revRow = db.prepare("SELECT revision FROM user_documents WHERE collection = ?").get(collection);
      revision = Number(revRow?.revision || 1);
      indexedRows = indexCollectionTx(db, collection, payload, updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { revision, updatedAt, indexedRows };
  } finally {
    db.close();
  }
}

export async function migrateUserStorageToSqlite(dataDirectory, userId) {
  safeUserKey(userId);
  const migratedCollections = [];
  const alreadyInSqlite = [];

  const { db } = await openUserDb(dataDirectory, userId);
  try {
    const existingRows = db.prepare("SELECT collection, payload_json FROM user_documents").all();
    const existingMap = new Map(existingRows.map((row) => [row.collection, row.payload_json]));

    for (const collection of KNOWN_COLLECTIONS) {
      if (existingMap.has(collection)) {
        alreadyInSqlite.push(collection);
        continue;
      }
      const legacyPath = userDataFile(dataDirectory, userId, collection);
      const legacyStat = await statOrNull(legacyPath);
      if (!legacyStat) continue;

      const raw = await fs.readFile(legacyPath, "utf8");
      const parsed = JSON.parse(raw);
      const updatedAt = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO user_documents (collection, payload_json, revision, updated_at, migrated_from, legacy_mtime_ms)
           VALUES (?, ?, 1, ?, 'legacy-json', ?)
           ON CONFLICT(collection) DO NOTHING`
        ).run(collection, JSON.stringify(parsed), updatedAt, legacyStat.mtimeMs);
        indexCollectionTx(db, collection, parsed, updatedAt);
        db.exec("COMMIT");
        migratedCollections.push(collection);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }

    // Re-verify / rebuild FTS5 + graph_edges for all collections currently stored in SQLite
    const allRows = db.prepare("SELECT collection, payload_json, updated_at FROM user_documents").all();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of allRows) {
        try {
          const parsed = JSON.parse(row.payload_json);
          indexCollectionTx(db, row.collection, parsed, row.updated_at || new Date().toISOString());
        } catch {
          // Skip unparseable non-domain payloads safely
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }

    try { db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM search_index").get();
    const ftsIndexedRows = Number(countRow?.count || 0);
    return { migratedCollections, alreadyInSqlite, ftsIndexedRows };
  } finally {
    db.close();
  }
}

export async function getUserStorageStatus(dataDirectory, userId, { backend } = {}) {
  safeUserKey(userId);
  const resolvedBackend = resolveStorageBackend(backend);
  const dbPath = userSqliteFile(dataDirectory, userId);

  const legacyPresence = new Map();
  for (const collection of KNOWN_COLLECTIONS) {
    const st = await statOrNull(userDataFile(dataDirectory, userId, collection));
    legacyPresence.set(collection, Boolean(st));
  }

  if (resolvedBackend === "json") {
    const collections = [];
    for (const collection of KNOWN_COLLECTIONS) {
      const legacyPresent = legacyPresence.get(collection);
      let recordCount = 0;
      if (legacyPresent) {
        try {
          const parsed = JSON.parse(await fs.readFile(userDataFile(dataDirectory, userId, collection), "utf8"));
          recordCount = countCollectionRecords(collection, parsed);
        } catch {}
      }
      if (legacyPresent) {
        collections.push({
          collection,
          inSqlite: false,
          revision: 0,
          updatedAt: null,
          migratedFrom: null,
          legacyJsonPresent: true,
          recordCount
        });
      }
    }
    return {
      backend: "json",
      journalMode: null,
      schemaVersion: 0,
      migrations: [],
      integrityOk: true,
      dbSizeBytes: 0,
      ftsIndexedRows: 0,
      graphIndexedEdges: 0,
      collections,
      pendingLegacyMigrations: collections.length
    };
  }

  // Ensure the per-user SQLite DB is initialized so WAL status & migrations are inspectable
  const { db } = await openUserDb(dataDirectory, userId);
  let journalMode = "wal";
  let migrations = [];
  let integrityOk = false;
  let ftsIndexedRows = 0;
  let graphIndexedEdges = 0;
  let docRows = [];

  try {
    const jmRow = db.prepare("PRAGMA journal_mode").get();
    journalMode = String(jmRow?.journal_mode || "wal").toLowerCase();

    const qcRow = db.prepare("PRAGMA quick_check").get();
    integrityOk = String(qcRow?.quick_check || "").toLowerCase() === "ok";

    migrations = db.prepare("SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version ASC").all()
      .map((row) => ({ version: Number(row.version), name: String(row.name), appliedAt: String(row.appliedAt) }));

    ftsIndexedRows = Number(db.prepare("SELECT COUNT(*) AS count FROM search_index").get()?.count || 0);
    graphIndexedEdges = Number(db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get()?.count || 0);
    docRows = db.prepare("SELECT collection, payload_json, revision, updated_at, migrated_from FROM user_documents ORDER BY collection ASC").all();
  } finally {
    db.close();
  }

  const [mainStat, walStat, shmStat] = await Promise.all([
    statOrNull(dbPath),
    statOrNull(`${dbPath}-wal`),
    statOrNull(`${dbPath}-shm`)
  ]);
  const dbSizeBytes = (mainStat?.size || 0) + (walStat?.size || 0) + (shmStat?.size || 0);

  const sqliteMap = new Map();
  for (const row of docRows) {
    let recordCount = 0;
    try {
      recordCount = countCollectionRecords(row.collection, JSON.parse(row.payload_json));
    } catch {}
    sqliteMap.set(row.collection, {
      collection: String(row.collection),
      inSqlite: true,
      revision: Number(row.revision || 1),
      updatedAt: String(row.updated_at || ""),
      migratedFrom: row.migrated_from ? String(row.migrated_from) : null,
      legacyJsonPresent: Boolean(legacyPresence.get(row.collection)),
      recordCount
    });
  }

  const collections = [];
  let pendingLegacyMigrations = 0;
  for (const collection of KNOWN_COLLECTIONS) {
    if (sqliteMap.has(collection)) {
      collections.push(sqliteMap.get(collection));
    } else if (legacyPresence.get(collection)) {
      pendingLegacyMigrations += 1;
      collections.push({
        collection,
        inSqlite: false,
        revision: 0,
        updatedAt: null,
        migratedFrom: null,
        legacyJsonPresent: true,
        recordCount: 0
      });
    }
  }

  return {
    backend: "sqlite",
    journalMode,
    schemaVersion: migrations.length ? migrations[migrations.length - 1].version : STORAGE_SCHEMA_VERSION,
    migrations,
    integrityOk,
    dbSizeBytes,
    ftsIndexedRows,
    graphIndexedEdges,
    collections,
    pendingLegacyMigrations
  };
}

export async function searchUserSqlite(dataDirectory, userId, { q = "", collection = "", entityType = "", limit = 20 } = {}) {
  safeUserKey(userId);
  const rawQuery = String(q || "").trim().slice(0, 200);
  const ftsQuery = buildSafeFtsQuery(rawQuery);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  const cleanCollection = COLLECTION_SET.has(String(collection || "").trim()) ? String(collection).trim() : "";
  const cleanEntityType = ENTITY_TYPE_SET.has(String(entityType || "").trim().toLowerCase())
    ? String(entityType).trim().toLowerCase()
    : "";

  if (!ftsQuery) {
    return { query: rawQuery, backend: "sqlite", ftsQuery: "", total: 0, results: [] };
  }

  // Ensure any unmigrated legacy JSON files are indexed before searching
  const dbPath = userSqliteFile(dataDirectory, userId);
  const dbStat = await statOrNull(dbPath);
  if (!dbStat) {
    await migrateUserStorageToSqlite(dataDirectory, userId);
  }

  const { db } = await openUserDb(dataDirectory, userId);
  try {
    const clauses = ["search_index MATCH ?"];
    const params = [ftsQuery];
    if (cleanCollection) {
      clauses.push("collection = ?");
      params.push(cleanCollection);
    }
    if (cleanEntityType) {
      clauses.push("entity_type = ?");
      params.push(cleanEntityType);
    }
    params.push(safeLimit);

    const sql = `
      SELECT
        doc_id AS docId,
        collection,
        entity_type AS entityType,
        project_id AS projectId,
        trust,
        updated_at AS updatedAt,
        title,
        tags,
        snippet(search_index, 7, '', '', '…', 20) AS snippet,
        bm25(search_index, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 1.0, 2.0) AS rank
      FROM search_index
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC, updated_at DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(...params);
    const results = rows.map((row) => ({
      docId: String(row.docId),
      collection: String(row.collection),
      entityType: String(row.entityType),
      projectId: row.projectId ? String(row.projectId) : null,
      trust: String(row.trust || "user_authored"),
      updatedAt: String(row.updatedAt || ""),
      title: String(row.title || ""),
      tags: String(row.tags || "").split(/\s+/).filter(Boolean),
      snippet: String(row.snippet || ""),
      rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0
    }));

    return {
      query: rawQuery,
      backend: "sqlite",
      ftsQuery,
      total: results.length,
      results
    };
  } finally {
    db.close();
  }
}

export async function searchUserJsonFallback(dataDirectory, userId, { q = "", collection = "", entityType = "", limit = 20 } = {}) {
  safeUserKey(userId);
  const rawQuery = String(q || "").trim().slice(0, 200);
  const tokens = (rawQuery.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).slice(0, 10);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  if (!tokens.length) {
    return { query: rawQuery, backend: "json", ftsQuery: "", total: 0, results: [] };
  }

  const targetCollections = COLLECTION_SET.has(String(collection || "").trim())
    ? [String(collection).trim()]
    : ["memories.json", "projects.json", "ideas.json", "conversations.json", "context-capsules.json", "watchers.json", "workflow-profile.json"];
  const cleanEntityType = ENTITY_TYPE_SET.has(String(entityType || "").trim().toLowerCase())
    ? String(entityType).trim().toLowerCase()
    : "";

  const hits = [];
  for (const col of targetCollections) {
    const file = userDataFile(dataDirectory, userId, col);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      const docs = extractSearchDocuments(col, parsed);
      for (const doc of docs) {
        if (cleanEntityType && doc.entityType !== cleanEntityType) continue;
        const titleLower = doc.title.toLowerCase();
        const bodyLower = doc.body.toLowerCase();
        const tagsLower = doc.tags.toLowerCase();
        let score = 0;
        let matchedAll = true;
        for (const token of tokens) {
          let termScore = 0;
          if (titleLower.includes(token)) termScore += 3;
          if (tagsLower.includes(token)) termScore += 2;
          if (bodyLower.includes(token)) termScore += 1;
          if (!termScore) {
            matchedAll = false;
            break;
          }
          score += termScore;
        }
        if (matchedAll && score > 0) {
          hits.push({
            docId: doc.docId,
            collection: doc.collection,
            entityType: doc.entityType,
            projectId: doc.projectId || null,
            trust: doc.trust || "user_authored",
            updatedAt: doc.updatedAt || "",
            title: doc.title,
            tags: doc.tags.split(/\s+/).filter(Boolean),
            snippet: doc.body.slice(0, 180),
            rank: -score
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  hits.sort((a, b) => a.rank - b.rank || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const results = hits.slice(0, safeLimit);
  return {
    query: rawQuery,
    backend: "json",
    ftsQuery: "",
    total: results.length,
    results
  };
}
