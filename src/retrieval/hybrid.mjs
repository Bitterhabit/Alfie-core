import { searchUserWorkspace } from "../storage/userJsonStore.mjs";
import { extractSearchDocuments, KNOWN_COLLECTIONS, resolveStorageBackend } from "../storage/sqliteStore.mjs";
import { readUserJsonDocument } from "../storage/userJsonStore.mjs";

const EMBEDDING_DIM = 128;
const RRF_K = 60;
const WORKER_TIMEOUT_MS = 3500;

const SEARCHABLE_COLLECTIONS = Object.freeze([
  "memories.json",
  "projects.json",
  "ideas.json",
  "conversations.json",
  "context-capsules.json",
  "watchers.json",
  "workflow-profile.json"
]);

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pure deterministic local vector embedding using signed hashed token + character
 * trigram projections. Zero external dependencies, sub-millisecond, normalized L2.
 */
export function computeLocalEmbedding(text, dim = EMBEDDING_DIM) {
  const vec = new Float64Array(dim);
  const normalized = String(text || "").toLowerCase().trim();
  if (!normalized) return vec;

  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const token of tokens) {
    const h = fnv1a(`w:${token}`);
    const idx = h % dim;
    const sign = (h & 0x80000000) ? -1 : 1;
    vec[idx] += sign * 2.0;

    // Character trigrams give morphological & typo tolerance ("homelab" <-> "homelabs", "backup" <-> "backups")
    if (token.length >= 3) {
      const padded = `^${token}$`;
      for (let i = 0; i <= padded.length - 3; i += 1) {
        const gram = padded.slice(i, i + 3);
        const gh = fnv1a(`g:${gram}`);
        const gIdx = gh % dim;
        const gSign = (gh & 0x80000000) ? -1 : 1;
        vec[gIdx] += gSign * 0.65;
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < dim; i += 1) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  }
  return vec;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Number.isFinite(dot) ? dot : 0;
}

/**
 * Optional stateless Python worker client (when ALFIE_EMBEDDING_WORKER_URL is set).
 * Always fails closed to deterministic local embeddings so Core never breaks offline.
 */
async function tryPythonWorkerRerank({ workerUrl, query, documents, fetchImpl = fetch }) {
  if (!workerUrl || !documents.length) return null;
  let parsed;
  try {
    parsed = new URL(workerUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(new URL("/rerank", parsed), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: String(query || "").slice(0, 300),
        documents: documents.slice(0, 80).map((d) => ({
          id: d.docId,
          text: `${d.title} ${d.tags} ${d.body}`.slice(0, 1200)
        }))
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload?.scores)) return null;
    const map = new Map();
    for (const item of payload.scores) {
      if (item && typeof item.id === "string" && Number.isFinite(Number(item.score))) {
        map.set(item.id, Number(item.score));
      }
    }
    return map;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reciprocal Rank Fusion (RRF) combining lexical ranks and semantic ranks.
 */
export function fuseRankings(lexicalItems, semanticItems, { limit = 20 } = {}) {
  const byId = new Map();

  lexicalItems.forEach((item, idx) => {
    const score = 1 / (RRF_K + idx + 1);
    byId.set(item.docId, {
      ...item,
      lexicalRank: idx + 1,
      semanticRank: null,
      semanticScore: 0,
      rrfScore: score
    });
  });

  semanticItems.forEach((item, idx) => {
    const score = 1 / (RRF_K + idx + 1);
    const existing = byId.get(item.docId);
    if (existing) {
      existing.semanticRank = idx + 1;
      existing.semanticScore = item.semanticScore;
      existing.rrfScore += score;
    } else {
      byId.set(item.docId, {
        ...item,
        lexicalRank: null,
        semanticRank: idx + 1,
        rrfScore: score
      });
    }
  });

  return Array.from(byId.values())
    .sort((a, b) => b.rrfScore - a.rrfScore || b.semanticScore - a.semanticScore || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export async function hybridSearchWorkspace(
  dataDirectory,
  userId,
  {
    q = "",
    collection = "",
    entityType = "",
    limit = 20,
    mode = "hybrid",
    backend,
    workerUrl = process.env.ALFIE_EMBEDDING_WORKER_URL || "",
    fetchImpl = fetch
  } = {}
) {
  const rawQuery = String(q || "").trim().slice(0, 200);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  const cleanMode = String(mode || "hybrid").trim().toLowerCase() === "lexical" ? "lexical" : "hybrid";
  const resolvedBackend = resolveStorageBackend(backend);

  const lexicalRes = await searchUserWorkspace(dataDirectory, userId, {
    q: rawQuery,
    collection,
    entityType,
    limit: safeLimit,
    backend: resolvedBackend
  });

  if (!rawQuery || cleanMode === "lexical") {
    return {
      ...lexicalRes,
      mode: "lexical",
      semanticEngine: "disabled"
    };
  }

  // Gather candidate documents across the user's collections for semantic scoring
  const targetCollections = KNOWN_COLLECTIONS.includes(collection)
    ? [collection]
    : SEARCHABLE_COLLECTIONS;

  const docs = [];
  for (const col of targetCollections) {
    const payload = await readUserJsonDocument(dataDirectory, userId, col, { backend: resolvedBackend });
    if (!payload) continue;
    for (const doc of extractSearchDocuments(col, payload)) {
      if (entityType && doc.entityType !== String(entityType).toLowerCase()) continue;
      docs.push(doc);
    }
  }

  let semanticEngine = "local-hashed-trigram-v1";
  const workerScores = await tryPythonWorkerRerank({
    workerUrl,
    query: rawQuery,
    documents: docs,
    fetchImpl
  });

  let semanticHits = [];
  if (workerScores && workerScores.size > 0) {
    semanticEngine = "python-worker-v1";
    semanticHits = docs
      .map((doc) => ({
        docId: doc.docId,
        collection: doc.collection,
        entityType: doc.entityType,
        projectId: doc.projectId || null,
        trust: doc.trust || "user_authored",
        updatedAt: doc.updatedAt || "",
        title: doc.title,
        tags: doc.tags ? doc.tags.split(/\s+/).filter(Boolean) : [],
        snippet: doc.body.slice(0, 180),
        semanticScore: Number(workerScores.get(doc.docId) || 0)
      }))
      .filter((item) => item.semanticScore > 0.12)
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, safeLimit);
  } else {
    const queryVec = computeLocalEmbedding(rawQuery);
    semanticHits = docs
      .map((doc) => {
        const docVec = computeLocalEmbedding(`${doc.title} ${doc.tags} ${doc.body}`);
        const sim = cosineSimilarity(queryVec, docVec);
        return {
          docId: doc.docId,
          collection: doc.collection,
          entityType: doc.entityType,
          projectId: doc.projectId || null,
          trust: doc.trust || "user_authored",
          updatedAt: doc.updatedAt || "",
          title: doc.title,
          tags: doc.tags ? doc.tags.split(/\s+/).filter(Boolean) : [],
          snippet: doc.body.slice(0, 180),
          semanticScore: Number(sim.toFixed(4))
        };
      })
      .filter((item) => item.semanticScore >= 0.14)
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, safeLimit);
  }

  const fused = fuseRankings(lexicalRes.results || [], semanticHits, { limit: safeLimit });

  return {
    query: rawQuery,
    backend: lexicalRes.backend,
    mode: "hybrid",
    semanticEngine,
    ftsQuery: lexicalRes.ftsQuery || "",
    total: fused.length,
    results: fused
  };
}
