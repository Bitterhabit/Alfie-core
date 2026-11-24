import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

const MEMORY_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const ORIGINS = new Set(["user-seeded", "alfie-created", "conversation-captured", "integration-imported"]);
const RELATIONSHIP_TYPES = new Set(["similar", "supports", "contradicts", "caused_by", "follow_up", "references", "created"]);
export const MEMORY_KINDS = Object.freeze(["fact", "decision", "preference", "temporary", "lesson", "note"]);
export const MEMORY_TRUST_LEVELS = Object.freeze(["user_authored", "system_verified", "external_untrusted"]);
const MEMORY_KIND_SET = new Set(MEMORY_KINDS);
const MEMORY_TRUST_SET = new Set(MEMORY_TRUST_LEVELS);
const MAX_MEMORIES = 2000;
const MAX_TEXT_LENGTH = 20000;

function cleanString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanKind(value, fallbackType = "note") {
  const candidate = cleanString(value, 40).toLowerCase();
  if (MEMORY_KIND_SET.has(candidate)) return candidate;
  const fromType = cleanString(fallbackType, 40).toLowerCase();
  if (MEMORY_KIND_SET.has(fromType)) return fromType;
  return "note";
}

function deriveTrust(origin, requestedTrust) {
  // ADR-003 invariant: integration-imported records can never be silently marked trusted.
  if (origin === "integration-imported") return "external_untrusted";
  const candidate = cleanString(requestedTrust, 40).toLowerCase();
  if (MEMORY_TRUST_SET.has(candidate)) return candidate;
  if (origin === "user-seeded" || origin === "conversation-captured") return "user_authored";
  return "system_verified";
}

function cleanExpiresAt(value, ttlHours, nowIso) {
  if (value === null || value === "") return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (!Number.isFinite(parsed)) {
      throw Object.assign(new Error("Memory expiry must be a valid ISO-8601 timestamp."), { status: 400 });
    }
    return new Date(parsed).toISOString();
  }
  if (ttlHours !== undefined && ttlHours !== null && ttlHours !== "") {
    const hours = Number(ttlHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
      throw Object.assign(new Error("Memory TTL must be between 1 and 8,760 hours."), { status: 400 });
    }
    const baseMs = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
    return new Date(baseMs + Math.round(hours * 3600 * 1000)).toISOString();
  }
  return null;
}

function isMemoryExpired(memory, nowIso) {
  if (!memory?.expiresAt) return false;
  const expiryMs = Date.parse(memory.expiresAt);
  if (!Number.isFinite(expiryMs)) return false;
  const nowMs = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
  return expiryMs <= nowMs;
}

function normaliseMemory(memory, nowIso) {
  const origin = ORIGINS.has(memory.origin) ? memory.origin : deriveOrigin(memory.source);
  const kind = cleanKind(memory.kind, memory.type);
  const trust = deriveTrust(origin, memory.trust || memory.provenance?.trust);
  const expiresAt = typeof memory.expiresAt === "string" && Number.isFinite(Date.parse(memory.expiresAt))
    ? new Date(Date.parse(memory.expiresAt)).toISOString()
    : null;
  const archived = Boolean(memory.archived);
  const supersededBy = MEMORY_ID_PATTERN.test(String(memory.supersededBy || "")) ? String(memory.supersededBy) : null;
  const expired = isMemoryExpired({ expiresAt }, nowIso);
  return {
    ...memory,
    origin,
    kind,
    trust,
    expiresAt,
    expired,
    archived,
    supersededBy,
    provenance: {
      ...(memory.provenance && typeof memory.provenance === "object" ? memory.provenance : {}),
      source: origin,
      capturedBy: memory.provenance?.capturedBy || (origin === "user-seeded" ? "user" : origin === "alfie-created" ? "alfie" : origin === "conversation-captured" ? "conversation" : "integration"),
      trust
    }
  };
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => cleanString(String(tag), 64).toLowerCase()).filter(Boolean))].slice(0, 30);
}

function normaliseMemoryText(value) {
  return String(value || "").toLowerCase().normalize("NFKC")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function memorySimilarity(left, right) {
  const a = new Set(normaliseMemoryText(left).split(" ").filter((word) => word.length > 2));
  const b = new Set(normaliseMemoryText(right).split(" ").filter((word) => word.length > 2));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export function memoryVersion(memory) {
  return createHash("sha256").update(JSON.stringify({
    id: memory.id, updatedAt: memory.updatedAt, origin: memory.origin,
    title: memory.title, text: memory.text, type: memory.type,
    kind: memory.kind || cleanKind(memory.kind, memory.type),
    trust: memory.trust || deriveTrust(memory.origin, memory.provenance?.trust),
    expiresAt: memory.expiresAt || null,
    archived: Boolean(memory.archived),
    tags: memory.tags, importance: memory.importance, metadata: memory.metadata
  })).digest("hex");
}

function cleanImportance(value, fallback = 5) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(10, Math.round(number))) : fallback;
}

function cleanMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function deriveOrigin(source) {
  if (source === "alfie") return "alfie-created";
  if (source === "user" || source === "garden") return "user-seeded";
  return "integration-imported";
}

function cleanRelationship(input = {}) {
  const type = cleanString(input.type, 40).toLowerCase();
  const target = cleanString(input.target, 100);
  if (!MEMORY_ID_PATTERN.test(target) || !RELATIONSHIP_TYPES.has(type)) return null;
  return {
    id: MEMORY_ID_PATTERN.test(String(input.id || "")) ? input.id : randomUUID(),
    target,
    type,
    createdBy: cleanString(input.createdBy, 40).toLowerCase() || "user",
    confidence: Number.isFinite(Number(input.confidence ?? 1)) ? Math.max(0, Math.min(1, Number(input.confidence ?? 1))) : 1,
    status: cleanString(input.status, 30).toLowerCase() || "confirmed",
    createdAt: cleanString(input.createdAt, 40) || new Date().toISOString()
  };
}

export class MemoryStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "memories.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "memories.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, memories: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.memories)) {
      throw new Error("Memory store failed its integrity check.");
    }
    // Reclassify legacy auto-captured chat statements. Older versions stored
    // these as Alfie-created/system-verified even though the source was the user.
    let migrated = false;
    for (const memory of store.memories) {
      const isLegacyAutoCapture = memory?.origin === "alfie-created"
        && (memory?.metadata?.autoCaptured === true || memory?.source === "auto-memory");
      if (!isLegacyAutoCapture) continue;
      memory.origin = "conversation-captured";
      memory.trust = "user_authored";
      memory.provenance = {
        ...(memory.provenance && typeof memory.provenance === "object" ? memory.provenance : {}),
        source: "conversation-captured",
        capturedBy: "conversation",
        trust: "user_authored"
      };
      migrated = true;
    }
    if (migrated) await this.save(userId, store);
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "memories.json", store, { uuid: this.uuid });
  }

  async list(userId, options = {}) {
    const {
      origin, source, type, kind, trust, tag,
      minImportance = 0, query, q, limit = 100, sort = "newest",
      includeArchived = false, includeExpired = false
    } = options;
    if (origin && !ORIGINS.has(origin)) throw Object.assign(new Error("Unknown memory provenance."), { status: 400 });
    const kindFilter = cleanString(kind, 40).toLowerCase();
    if (kindFilter && kindFilter !== "all" && !MEMORY_KIND_SET.has(kindFilter)) {
      throw Object.assign(new Error("Unknown memory kind."), { status: 400 });
    }
    const trustFilter = cleanString(trust, 40).toLowerCase();
    if (trustFilter && trustFilter !== "all" && !MEMORY_TRUST_SET.has(trustFilter)) {
      throw Object.assign(new Error("Unknown memory trust tier."), { status: 400 });
    }
    const sourceFilter = cleanString(source, 80).toLowerCase();
    const typeFilter = cleanString(type, 80).toLowerCase();
    const tagFilter = cleanString(tag, 64).toLowerCase();
    const terms = String(query || q || "").toLowerCase().split(/\s+/).filter((term) => term.length > 1);
    const allowArchived = includeArchived === true || includeArchived === "true" || includeArchived === "1";
    const allowExpired = includeExpired === true || includeExpired === "true" || includeExpired === "1";
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const memories = store.memories
        .map((raw) => normaliseMemory(raw, nowIso))
        .filter((item) => {
          if (!allowArchived && item.archived) return false;
          if (!allowExpired && item.expired) return false;
          if (origin && item.origin !== origin) return false;
          if (sourceFilter && item.source !== sourceFilter) return false;
          if (typeFilter && item.type !== typeFilter) return false;
          if (kindFilter && kindFilter !== "all" && item.kind !== kindFilter) return false;
          if (trustFilter && trustFilter !== "all" && item.trust !== trustFilter) return false;
          if (tagFilter && !item.tags?.includes(tagFilter)) return false;
          if (Number(minImportance) > 0 && Number(item.importance) < Number(minImportance)) return false;
          if (terms.length) {
            const haystack = [item.title, item.text, item.source, item.type, item.kind, item.trust, ...(item.tags || [])].join(" ").toLowerCase();
            if (!terms.every((term) => haystack.includes(term))) return false;
          }
          return true;
        });
      memories.sort((a, b) => sort === "oldest"
        ? String(a.createdAt).localeCompare(String(b.createdAt))
        : sort === "importance"
          ? Number(b.importance || 0) - Number(a.importance || 0) || String(b.createdAt).localeCompare(String(a.createdAt))
          : String(b.createdAt).localeCompare(String(a.createdAt)));
      return memories.slice(0, Math.max(1, Math.min(MAX_MEMORIES, Number(limit) || 100)));
    });
  }

  async search(userId, query, { limit = 8, includeArchived = false, includeExpired = false } = {}) {
    const stopWords = new Set(["about", "after", "again", "also", "and", "are", "can", "could", "did", "does", "for", "from", "have", "how", "into", "just", "like", "memory", "memories", "me", "my", "not", "our", "please", "tell", "that", "the", "their", "them", "there", "this", "those", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your"]);
    const terms = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9_'-]+/g) || [])]
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .slice(0, 12);
    if (!terms.length) return [];
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      return store.memories
        .map((raw) => normaliseMemory(raw, nowIso))
        .filter((memory) => (includeArchived || !memory.archived) && (includeExpired || !memory.expired))
        .map((memory) => {
          const title = String(memory.title || "").toLowerCase();
          const text = String(memory.text || "").toLowerCase();
          const tags = (memory.tags || []).join(" ").toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (title.includes(term)) score += 4;
            if (text.includes(term)) score += 2;
            if (tags.includes(term)) score += 1;
          }
          if (score > 0) {
            if (String(memory.origin || "") === "user-seeded") score += 0.25;
            if (memory.kind === "decision") score += 0.2;
          }
          return { memory, score };
        }).filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score
          || Number(b.memory.importance || 0) - Number(a.memory.importance || 0)
          || String(b.memory.updatedAt || b.memory.createdAt).localeCompare(String(a.memory.updatedAt || a.memory.createdAt)))
        .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
        .map((item) => item.memory);
    });
  }

  async findSimilar(userId, text, { limit = 5, threshold = 0.55 } = {}) {
    const query = normaliseMemoryText(text);
    if (!query) return [];
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      return store.memories
        .map((raw) => normaliseMemory(raw, nowIso))
        .filter((memory) => !memory.archived && !memory.expired)
        .map((memory) => {
          const candidate = normaliseMemoryText([memory.title, memory.text].filter(Boolean).join(" "));
          const exact = candidate === query || normaliseMemoryText(memory.text) === query;
          return { memory, score: exact ? 1 : memorySimilarity(query, candidate), exact };
        }).filter((item) => item.exact || item.score >= threshold)
        .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
        .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)))
        .map(({ memory, score, exact }) => ({ memory, score: Number(score.toFixed(3)), exact }));
    });
  }

  async stats(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const sources = {};
      const types = {};
      const kinds = {};
      const trusts = {};
      let relationships = 0;
      let archived = 0;
      let expired = 0;
      for (const raw of store.memories) {
        const memory = normaliseMemory(raw, nowIso);
        sources[memory.source] = (sources[memory.source] || 0) + 1;
        types[memory.type] = (types[memory.type] || 0) + 1;
        kinds[memory.kind] = (kinds[memory.kind] || 0) + 1;
        trusts[memory.trust] = (trusts[memory.trust] || 0) + 1;
        if (memory.archived) archived += 1;
        if (memory.expired) expired += 1;
        relationships += Array.isArray(memory.relationships) ? memory.relationships.length : 0;
      }
      const active = store.memories.filter((raw) => {
        const m = normaliseMemory(raw, nowIso);
        return !m.archived && !m.expired;
      }).length;
      return { total: store.memories.length, active, archived, expired, relationships, sources, types, kinds, trusts };
    });
  }

  async get(userId, memoryId) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      return normaliseMemory(memory, this.now());
    });
  }

  async create(userId, input = {}) {
    if (input.origin !== undefined && !ORIGINS.has(input.origin)) {
      throw Object.assign(new Error("Unknown memory provenance."), { status: 400 });
    }
    if (input.kind !== undefined && input.kind !== "" && !MEMORY_KIND_SET.has(cleanString(input.kind, 40).toLowerCase())) {
      throw Object.assign(new Error("Unknown memory kind."), { status: 400 });
    }
    if (input.trust !== undefined && input.trust !== "" && !MEMORY_TRUST_SET.has(cleanString(input.trust, 40).toLowerCase())) {
      throw Object.assign(new Error("Unknown memory trust tier."), { status: 400 });
    }
    const source = cleanString(input.source || (input.origin === "alfie-created" ? "alfie" : input.origin === "integration-imported" ? "integration" : "user"), 80).toLowerCase();
    const origin = input.origin || deriveOrigin(source);
    const text = cleanString(input.text, MAX_TEXT_LENGTH);
    const title = cleanString(input.title, 240) || text;
    const kind = cleanKind(input.kind, input.type || "note");
    const type = cleanString(input.type, 80).toLowerCase() || (kind === "note" ? "note" : kind);
    const trust = deriveTrust(origin, input.trust);
    if (!source || !type || (!title && !text)) {
      throw Object.assign(new Error("A memory requires source, type, and either title or text."), { status: 400 });
    }
    const now = this.now();
    const expiresAt = cleanExpiresAt(input.expiresAt, input.ttlHours, now);
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const normalizedText = normaliseMemoryText(text);
      const duplicate = store.memories.find((item) => !item.archived && normaliseMemoryText(item.text) === normalizedText);
      if (normalizedText && duplicate) {
        throw Object.assign(new Error("An identical memory already exists. Review the existing Garden entry instead of creating a duplicate."), {
          status: 409, code: "MEMORY_DUPLICATE", duplicateId: duplicate.id
        });
      }
      if (store.memories.length >= MAX_MEMORIES) {
        throw Object.assign(new Error("This account has reached its memory limit."), { status: 409 });
      }
      const memory = {
        id: this.uuid(), origin, source, type, kind, trust, title, text,
        tags: cleanTags(input.tags),
        createdAt: now, updatedAt: now,
        expiresAt,
        archived: false,
        supersededBy: null,
        importance: cleanImportance(input.importance, 5),
        relationships: [],
        metadata: cleanMetadata(input.metadata),
        provenance: {
          source: origin,
          capturedBy: origin === "user-seeded" ? "user" : origin === "alfie-created" ? "alfie" : origin === "conversation-captured" ? "conversation" : "integration",
          trust
        }
      };
      store.memories.push(memory);
      await this.save(userId, store);
      return normaliseMemory(memory, now);
    });
  }

  async update(userId, memoryId, changes = {}, expectedVersion = null) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    if (changes.kind !== undefined && changes.kind !== "" && !MEMORY_KIND_SET.has(cleanString(changes.kind, 40).toLowerCase())) {
      throw Object.assign(new Error("Unknown memory kind."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      if (expectedVersion && memoryVersion(memory) !== expectedVersion) {
        throw Object.assign(new Error("Memory changed after approval was requested. Review it again before retrying."), { status: 409, code: "STALE_APPROVAL" });
      }
      const now = this.now();
      if (typeof changes.title === "string") memory.title = cleanString(changes.title, 240) || memory.title;
      if (typeof changes.text === "string") {
        const text = cleanString(changes.text, MAX_TEXT_LENGTH);
        if (!text) throw Object.assign(new Error("Memory text cannot be empty."), { status: 400 });
        memory.text = text;
      }
      if (typeof changes.kind === "string" && changes.kind.trim()) {
        memory.kind = cleanKind(changes.kind, memory.type);
      }
      if (typeof changes.type === "string") memory.type = cleanString(changes.type, 80).toLowerCase() || memory.type;
      if (Array.isArray(changes.tags)) memory.tags = cleanTags(changes.tags);
      if (changes.importance !== undefined) memory.importance = cleanImportance(changes.importance, 5);
      if (changes.expiresAt !== undefined || changes.ttlHours !== undefined) {
        memory.expiresAt = cleanExpiresAt(changes.expiresAt, changes.ttlHours, now);
      }
      if (typeof changes.archived === "boolean") {
        memory.archived = changes.archived;
      }
      if (changes.supersededBy !== undefined) {
        if (changes.supersededBy === null || changes.supersededBy === "") {
          memory.supersededBy = null;
        } else if (MEMORY_ID_PATTERN.test(String(changes.supersededBy))) {
          memory.supersededBy = String(changes.supersededBy);
        } else {
          throw Object.assign(new Error("Invalid superseding memory ID."), { status: 400 });
        }
      }
      if (changes.metadata && typeof changes.metadata === "object" && !Array.isArray(changes.metadata)) {
        memory.metadata = { ...memory.metadata, ...changes.metadata };
      }
      // Preserve ADR-003 trust provenance invariant across edits.
      memory.trust = deriveTrust(memory.origin, memory.trust || memory.provenance?.trust);
      memory.updatedAt = now;
      await this.save(userId, store);
      return normaliseMemory(memory, now);
    });
  }

  async addRelationship(userId, memoryId, input = {}) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    const type = cleanString(input.type, 40).toLowerCase();
    const target = cleanString(input.target, 100);
    if (!target || target === memoryId) throw Object.assign(new Error("Choose a different target memory."), { status: 400 });
    if (!RELATIONSHIP_TYPES.has(type)) throw Object.assign(new Error("Unsupported relationship type."), { status: 400 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      if (!store.memories.some((item) => item.id === target)) throw Object.assign(new Error("Target memory not found."), { status: 404 });
      memory.relationships = Array.isArray(memory.relationships) ? memory.relationships : [];
      if (memory.relationships.some((item) => item.target === target && item.type === type)) {
        throw Object.assign(new Error("That relationship already exists."), { status: 409 });
      }
      const relationship = cleanRelationship({ ...input, target, type, id: this.uuid(), createdAt: this.now() });
      memory.relationships.push(relationship);
      memory.updatedAt = relationship.createdAt;
      await this.save(userId, store);
      return { memory, relationship };
    });
  }


  async related(userId, memoryId) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      const byId = new Map(store.memories.map((item) => [item.id, item]));
      const outgoing = (memory.relationships || [])
        .map((relationship) => ({ direction: "outgoing", relationship, memory: byId.get(relationship.target) }))
        .filter((item) => item.memory);
      const incoming = store.memories.flatMap((source) =>
        (source.relationships || [])
          .filter((relationship) => relationship.target === memoryId)
          .map((relationship) => ({ direction: "incoming", relationship, memory: source })));
      return [...outgoing, ...incoming];
    });
  }

  async removeRelationship(userId, memoryId, relationshipId) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || "")) || !MEMORY_ID_PATTERN.test(String(relationshipId || ""))) {
      throw Object.assign(new Error("Relationship not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      const index = (memory.relationships || []).findIndex((item) => item.id === relationshipId);
      if (index < 0) throw Object.assign(new Error("Relationship not found."), { status: 404 });
      const [relationship] = memory.relationships.splice(index, 1);
      memory.updatedAt = this.now();
      await this.save(userId, store);
      return { memory, relationship };
    });
  }

  async remove(userId, memoryId, expectedVersion = null) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.memories.findIndex((item) => item.id === memoryId);
      if (index < 0) throw Object.assign(new Error("Memory not found."), { status: 404 });
      if (expectedVersion && memoryVersion(store.memories[index]) !== expectedVersion) {
        throw Object.assign(new Error("Memory changed after approval was requested. Review it again before retrying."), { status: 409, code: "STALE_APPROVAL" });
      }
      const [removed] = store.memories.splice(index, 1);
      store.memories.forEach((memory) => {
        memory.relationships = (memory.relationships || []).filter((item) => item.target !== removed.id);
      });
      await this.save(userId, store);
      return { deleted: true, memory: removed };
    });
  }

  async importLegacy(userId, legacyMemories = []) {
    if (!Array.isArray(legacyMemories) || legacyMemories.length > MAX_MEMORIES) {
      throw Object.assign(new Error("Legacy memory import must be an array of at most 2,000 memories."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const existing = new Set(store.memories.map((item) => item.id));
      let imported = 0;
      let skipped = 0;
      for (const item of legacyMemories) {
        if (!MEMORY_ID_PATTERN.test(String(item?.id || ""))) {
          throw Object.assign(new Error("Every imported memory must have a valid existing ID."), { status: 400 });
        }
        if (existing.has(item.id)) { skipped += 1; continue; }
        const source = cleanString(item.source, 80).toLowerCase();
        const type = cleanString(item.type, 80).toLowerCase();
        const text = cleanString(item.text, MAX_TEXT_LENGTH);
        const title = cleanString(item.title, 240) || text;
        if (!source || !type || (!title && !text)) {
          throw Object.assign(new Error("Imported memories must retain source, type and title or text."), { status: 400 });
        }
        if (store.memories.length >= MAX_MEMORIES) throw Object.assign(new Error("This account has reached its memory limit."), { status: 409 });
        const origin = ORIGINS.has(item.origin) ? item.origin : deriveOrigin(source);
        const kind = cleanKind(item.kind, type);
        const trust = deriveTrust(origin, item.trust);
        const relationships = (Array.isArray(item.relationships) ? item.relationships : []).map(cleanRelationship).filter(Boolean);
        store.memories.push({
          id: item.id, origin, source, type, kind, trust, title, text,
          tags: cleanTags(item.tags),
          createdAt: cleanString(item.createdAt, 40) || this.now(),
          updatedAt: cleanString(item.updatedAt, 40) || cleanString(item.createdAt, 40) || this.now(),
          expiresAt: null,
          archived: Boolean(item.archived),
          supersededBy: null,
          importance: cleanImportance(item.importance, 5),
          relationships,
          metadata: cleanMetadata(item.metadata),
          provenance: { source: origin, capturedBy: origin === "user-seeded" ? "user" : origin === "alfie-created" ? "alfie" : "integration", trust, migratedFrom: "petrio-memory-v2" }
        });
        existing.add(item.id);
        imported += 1;
      }
      if (imported) await this.save(userId, store);
      return { imported, skipped, total: store.memories.length };
    });
  }
}
