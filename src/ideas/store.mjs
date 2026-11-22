import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

const UUID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_IDEAS = 500;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 4000;
const MAX_SOURCE_CONTEXT_LENGTH = 600;
const MAX_TAGS = 12;

export const IDEA_STATUSES = Object.freeze(["inbox", "active", "parked", "promoted", "archived"]);
export const IDEA_PRIORITIES = Object.freeze(["low", "medium", "high"]);

function cleanTitle(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
  if (!cleaned) {
    throw Object.assign(new Error("An idea title is required."), { status: 400, code: "IDEA_TITLE_REQUIRED" });
  }
  return cleaned;
}

function cleanBody(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY_LENGTH);
}

function cleanSourceContext(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_SOURCE_CONTEXT_LENGTH);
}

function cleanStatus(value, fallback = "inbox") {
  const candidate = String(value || "").trim().toLowerCase();
  return IDEA_STATUSES.includes(candidate) ? candidate : fallback;
}

function cleanPriority(value, fallback = "medium") {
  const candidate = String(value || "").trim().toLowerCase();
  return IDEA_PRIORITIES.includes(candidate) ? candidate : fallback;
}

function cleanProjectId(value) {
  if (value === undefined || value === null || value === "") return null;
  const candidate = String(value).trim();
  if (!UUID_PATTERN.test(candidate)) {
    throw Object.assign(new Error("Invalid project ID for idea."), { status: 400, code: "PROJECT_ID_INVALID" });
  }
  return candidate;
}

export function normaliseTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
}

const HEX_COLOR_OR_NUMERIC = /^(?:[0-9._-]+|fff|000|(?:(?=[0-9a-f]*[0-9])[0-9a-f]{3}|(?=[0-9a-f]*[0-9])[0-9a-f]{6}|(?=[0-9a-f]*[0-9])[0-9a-f]{8}))$/i;

export function extractHashtags(...texts) {
  const seen = new Set();
  const result = [];
  const pattern = /(^|[\s([{,"'])#([a-zA-Z0-9][a-zA-Z0-9._-]{0,31})/g;
  for (const input of texts) {
    if (typeof input !== "string" || !input.includes("#")) continue;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const candidate = normaliseTag(match[2]);
      if (!candidate || !/[a-z]/.test(candidate)) continue;
      if (HEX_COLOR_OR_NUMERIC.test(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
      if (result.length >= MAX_TAGS) return result;
    }
  }
  return result;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const tag = normaliseTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

function mergeTags(explicitTags, ...texts) {
  return cleanTags([...(Array.isArray(explicitTags) ? explicitTags : []), ...extractHashtags(...texts)]);
}

function normaliseIdea(raw, fallbackNow) {
  const title = String(raw.title || "Untitled idea").slice(0, MAX_TITLE_LENGTH);
  const body = cleanBody(raw.body);
  return {
    id: String(raw.id),
    title,
    body,
    status: cleanStatus(raw.status, "inbox"),
    priority: cleanPriority(raw.priority, "medium"),
    projectId: UUID_PATTERN.test(String(raw.projectId || "")) ? String(raw.projectId) : null,
    sourceContext: cleanSourceContext(raw.sourceContext),
    tags: mergeTags(raw.tags, title, body),
    trust: raw.trust === "external_untrusted" ? "external_untrusted" : "user_authored",
    createdAt: String(raw.createdAt || fallbackNow),
    updatedAt: String(raw.updatedAt || raw.createdAt || fallbackNow)
  };
}

export class IdeaStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "ideas.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "ideas.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, ideas: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.ideas)) {
      throw new Error("Idea store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "ideas.json", store, { uuid: this.uuid });
  }

  filterIdeas(rawIdeas, fallbackNow, { status = "", projectId = "", query = "", tag = "" } = {}) {
    const statusFilter = String(status || "").trim().toLowerCase();
    const queryFilter = String(query || "").trim().toLowerCase();
    const tagFilter = normaliseTag(tag);
    return rawIdeas
      .map((item) => normaliseIdea(item, fallbackNow))
      .filter((item) => {
        if (statusFilter && statusFilter !== "all" && item.status !== statusFilter) return false;
        if (projectId === "unassigned" && item.projectId !== null) return false;
        if (projectId && projectId !== "all" && projectId !== "unassigned" && item.projectId !== projectId) return false;
        if (tagFilter && !item.tags.includes(tagFilter)) return false;
        if (queryFilter) {
          const haystack = `${item.title} ${item.body} ${item.sourceContext} ${item.tags.map((t) => "#" + t).join(" ")}`.toLowerCase();
          if (!haystack.includes(queryFilter)) return false;
        }
        return true;
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async list(userId, { status = "", projectId = "", query = "", tag = "" } = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return this.filterIdeas(store.ideas, this.now(), { status, projectId, query, tag });
    });
  }

  async listTags(userId, { status = "", projectId = "", query = "" } = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const ideas = this.filterIdeas(store.ideas, this.now(), { status, projectId, query });
      const counts = new Map();
      for (const idea of ideas) {
        for (const tag of idea.tags) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
    });
  }

  async get(userId, ideaId) {
    if (!UUID_PATTERN.test(String(ideaId || ""))) {
      throw Object.assign(new Error("Idea not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idea = store.ideas.find((item) => item.id === ideaId);
      if (!idea) throw Object.assign(new Error("Idea not found."), { status: 404 });
      return normaliseIdea(idea, this.now());
    });
  }

  async create(userId, input = {}) {
    const title = cleanTitle(input.title);
    const body = cleanBody(input.body);
    const status = cleanStatus(input.status, "inbox");
    const priority = cleanPriority(input.priority, "medium");
    const projectId = cleanProjectId(input.projectId);
    const sourceContext = cleanSourceContext(input.sourceContext);
    const tags = mergeTags(input.tags, title, body);
    const trust = input.trust === "external_untrusted" ? "external_untrusted" : "user_authored";

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.ideas.length >= MAX_IDEAS) {
        throw Object.assign(new Error("This account has reached its Ideas Vault limit (500)."), { status: 409, code: "IDEA_LIMIT" });
      }
      const now = this.now();
      const idea = {
        id: this.uuid(),
        title,
        body,
        status,
        priority,
        projectId,
        sourceContext,
        tags,
        trust,
        createdAt: now,
        updatedAt: now
      };
      store.ideas.push(idea);
      await this.save(userId, store);
      return idea;
    });
  }

  async update(userId, ideaId, input = {}) {
    if (!UUID_PATTERN.test(String(ideaId || ""))) {
      throw Object.assign(new Error("Idea not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.ideas.findIndex((item) => item.id === ideaId);
      if (index < 0) throw Object.assign(new Error("Idea not found."), { status: 404 });
      const current = normaliseIdea(store.ideas[index], this.now());
      const nextTitle = input.title !== undefined ? cleanTitle(input.title) : current.title;
      const nextBody = input.body !== undefined ? cleanBody(input.body) : current.body;
      let nextTags = current.tags;
      if (input.tags !== undefined) {
        nextTags = mergeTags(input.tags, nextTitle, nextBody);
      } else if (input.title !== undefined || input.body !== undefined) {
        const previousExtracted = new Set(extractHashtags(current.title, current.body));
        const manualTags = current.tags.filter((tag) => !previousExtracted.has(tag));
        nextTags = mergeTags(manualTags, nextTitle, nextBody);
      }
      const updated = {
        ...current,
        title: nextTitle,
        body: nextBody,
        ...(input.status !== undefined ? { status: cleanStatus(input.status, current.status) } : {}),
        ...(input.priority !== undefined ? { priority: cleanPriority(input.priority, current.priority) } : {}),
        ...(input.projectId !== undefined ? { projectId: cleanProjectId(input.projectId) } : {}),
        ...(input.sourceContext !== undefined ? { sourceContext: cleanSourceContext(input.sourceContext) } : {}),
        tags: nextTags,
        updatedAt: this.now()
      };
      store.ideas[index] = updated;
      await this.save(userId, store);
      return updated;
    });
  }

  async clearProject(userId, projectId) {
    if (!UUID_PATTERN.test(String(projectId || ""))) return { cleared: 0 };
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      let cleared = 0;
      const now = this.now();
      for (const idea of store.ideas) {
        if (idea.projectId === projectId) {
          idea.projectId = null;
          idea.updatedAt = now;
          cleared += 1;
        }
      }
      if (cleared > 0) await this.save(userId, store);
      return { cleared };
    });
  }

  async remove(userId, ideaId) {
    if (!UUID_PATTERN.test(String(ideaId || ""))) {
      throw Object.assign(new Error("Idea not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const before = store.ideas.length;
      store.ideas = store.ideas.filter((item) => item.id !== ideaId);
      if (store.ideas.length === before) throw Object.assign(new Error("Idea not found."), { status: 404 });
      await this.save(userId, store);
      return { deleted: true, id: ideaId };
    });
  }
}
