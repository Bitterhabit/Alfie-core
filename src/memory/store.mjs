import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const MEMORY_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const ORIGINS = new Set(["user-seeded", "alfie-created", "integration-imported"]);
const RELATIONSHIP_TYPES = new Set(["similar", "supports", "contradicts", "caused_by", "follow_up", "references", "created"]);
const MAX_MEMORIES = 2000;
const MAX_TEXT_LENGTH = 20000;

function userKey(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

function cleanString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
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
    this.queues = new Map();
  }

  fileFor(userId) {
    return path.join(this.dataDirectory, "users", userKey(userId), "memories.json");
  }

  async exclusive(userId, operation) {
    const key = userKey(userId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const queued = current.catch(() => {});
    this.queues.set(key, queued);
    try { return await current; }
    finally { if (this.queues.get(key) === queued) this.queues.delete(key); }
  }

  async load(userId) {
    try {
      const store = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.memories)) {
        throw new Error("Memory store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, ownerId: userId, memories: [] };
      throw error;
    }
  }

  async save(userId, store) {
    const file = this.fileFor(userId);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `memories.${this.uuid()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(store, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  }

  async list(userId, options = {}) {
    const { origin, source, type, tag, minImportance = 0, query, q, limit = 100, sort = "newest" } = options;
    if (origin && !ORIGINS.has(origin)) throw Object.assign(new Error("Unknown memory provenance."), { status: 400 });
    const sourceFilter = cleanString(source, 80).toLowerCase();
    const typeFilter = cleanString(type, 80).toLowerCase();
    const tagFilter = cleanString(tag, 64).toLowerCase();
    const terms = String(query || q || "").toLowerCase().split(/\s+/).filter((term) => term.length > 1);
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memories = store.memories.filter((item) => {
        if (origin && item.origin !== origin) return false;
        if (sourceFilter && item.source !== sourceFilter) return false;
        if (typeFilter && item.type !== typeFilter) return false;
        if (tagFilter && !item.tags?.includes(tagFilter)) return false;
        if (Number(minImportance) > 0 && Number(item.importance) < Number(minImportance)) return false;
        if (terms.length) {
          const haystack = [item.title, item.text, item.source, item.type, ...(item.tags || [])].join(" ").toLowerCase();
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

  async search(userId, query, { limit = 8 } = {}) {
    const stopWords = new Set(["about", "after", "again", "also", "and", "are", "can", "could", "did", "does", "for", "from", "have", "how", "into", "just", "like", "memory", "memories", "me", "my", "not", "our", "please", "tell", "that", "the", "their", "them", "there", "this", "those", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your"]);
    const terms = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9_'-]+/g) || [])]
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .slice(0, 12);
    if (!terms.length) return [];
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return store.memories.map((memory) => {
        const title = String(memory.title || "").toLowerCase();
        const text = String(memory.text || "").toLowerCase();
        const tags = (memory.tags || []).join(" ").toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 4;
          if (text.includes(term)) score += 2;
          if (tags.includes(term)) score += 1;
        }
        if (String(memory.origin || "") === "user-seeded") score += 0.25;
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
      return store.memories.map((memory) => {
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
      const sources = {};
      const types = {};
      let relationships = 0;
      for (const memory of store.memories) {
        sources[memory.source] = (sources[memory.source] || 0) + 1;
        types[memory.type] = (types[memory.type] || 0) + 1;
        relationships += Array.isArray(memory.relationships) ? memory.relationships.length : 0;
      }
      return { total: store.memories.length, relationships, sources, types };
    });
  }

  async get(userId, memoryId) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      return memory;
    });
  }

  async create(userId, input = {}) {
    if (input.origin !== undefined && !ORIGINS.has(input.origin)) {
      throw Object.assign(new Error("Unknown memory provenance."), { status: 400 });
    }
    const source = cleanString(input.source || (input.origin === "alfie-created" ? "alfie" : input.origin === "integration-imported" ? "integration" : "user"), 80).toLowerCase();
    const origin = input.origin || deriveOrigin(source);
    const text = cleanString(input.text, MAX_TEXT_LENGTH);
    const title = cleanString(input.title, 240) || text;
    const type = cleanString(input.type, 80).toLowerCase() || "note";
    if (!source || !type || (!title && !text)) {
      throw Object.assign(new Error("A memory requires source, type, and either title or text."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const normalizedText = normaliseMemoryText(text);
      const duplicate = store.memories.find((item) => normaliseMemoryText(item.text) === normalizedText);
      if (normalizedText && duplicate) {
        throw Object.assign(new Error("An identical memory already exists. Review the existing Garden entry instead of creating a duplicate."), {
          status: 409, code: "MEMORY_DUPLICATE", duplicateId: duplicate.id
        });
      }
      if (store.memories.length >= MAX_MEMORIES) {
        throw Object.assign(new Error("This account has reached its memory limit."), { status: 409 });
      }
      const now = this.now();
      const memory = {
        id: this.uuid(), origin, source, type, title, text,
        tags: cleanTags(input.tags),
        createdAt: now, updatedAt: now,
        importance: cleanImportance(input.importance, 5),
        relationships: [],
        metadata: cleanMetadata(input.metadata),
        provenance: { source: origin, capturedBy: origin === "user-seeded" ? "user" : origin === "alfie-created" ? "alfie" : "integration" }
      };
      store.memories.push(memory);
      await this.save(userId, store);
      return memory;
    });
  }

  async update(userId, memoryId, changes = {}, expectedVersion = null) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw Object.assign(new Error("Memory not found."), { status: 404 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const memory = store.memories.find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Memory not found."), { status: 404 });
      if (expectedVersion && memoryVersion(memory) !== expectedVersion) {
        throw Object.assign(new Error("Memory changed after approval was requested. Review it again before retrying."), { status: 409, code: "STALE_APPROVAL" });
      }
      if (typeof changes.title === "string") memory.title = cleanString(changes.title, 240) || memory.title;
      if (typeof changes.text === "string") {
        const text = cleanString(changes.text, MAX_TEXT_LENGTH);
        if (!text) throw Object.assign(new Error("Memory text cannot be empty."), { status: 400 });
        memory.text = text;
      }
      if (typeof changes.type === "string") memory.type = cleanString(changes.type, 80).toLowerCase() || memory.type;
      if (Array.isArray(changes.tags)) memory.tags = cleanTags(changes.tags);
      if (changes.importance !== undefined) memory.importance = cleanImportance(changes.importance, 5);
      if (changes.metadata && typeof changes.metadata === "object" && !Array.isArray(changes.metadata)) {
        memory.metadata = { ...memory.metadata, ...changes.metadata };
      }
      memory.updatedAt = this.now();
      await this.save(userId, store);
      return memory;
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
        const relationships = (Array.isArray(item.relationships) ? item.relationships : []).map(cleanRelationship).filter(Boolean);
        store.memories.push({
          id: item.id, origin, source, type, title, text,
          tags: cleanTags(item.tags),
          createdAt: cleanString(item.createdAt, 40) || this.now(),
          updatedAt: cleanString(item.updatedAt, 40) || cleanString(item.createdAt, 40) || this.now(),
          importance: cleanImportance(item.importance, 5),
          relationships,
          metadata: cleanMetadata(item.metadata),
          provenance: { source: origin, capturedBy: origin === "user-seeded" ? "user" : origin === "alfie-created" ? "alfie" : "integration", migratedFrom: "petrio-memory-v2" }
        });
        existing.add(item.id);
        imported += 1;
      }
      if (imported) await this.save(userId, store);
      return { imported, skipped, total: store.memories.length };
    });
  }
}
