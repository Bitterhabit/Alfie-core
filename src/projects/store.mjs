import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
export const PROJECT_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_PROJECTS = 100;
const ALLOWED_COLORS = new Set(["purple", "blue", "cyan", "emerald", "amber", "rose"]);

function safeUserKey(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

function cleanName(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("A project name is required."), { status: 400, code: "PROJECT_NAME_INVALID" });
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > 80) {
    throw Object.assign(new Error("Project names must contain between 1 and 80 characters."), { status: 400, code: "PROJECT_NAME_INVALID" });
  }
  return trimmed;
}

function cleanDescription(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw Object.assign(new Error("Project description must be text."), { status: 400, code: "PROJECT_DESCRIPTION_INVALID" });
  }
  return value.replace(/\r\n/g, "\n").trim().slice(0, 600);
}

function cleanColor(value) {
  const normalized = String(value || "purple").trim().toLowerCase();
  return ALLOWED_COLORS.has(normalized) ? normalized : "purple";
}

export class ProjectStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.queues = new Map();
  }

  fileFor(userId) {
    const key = safeUserKey(userId);
    return path.join(this.dataDirectory, "users", key, "projects.json");
  }

  async exclusive(userId, operation) {
    const key = safeUserKey(userId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const queued = current.catch(() => {});
    this.queues.set(key, queued);
    try { return await current; }
    finally { if (this.queues.get(key) === queued) this.queues.delete(key); }
  }

  async load(userId) {
    const file = this.fileFor(userId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const store = JSON.parse(raw);
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.projects)) {
        throw new Error("Project store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, revision: 0, ownerId: userId, projects: [] };
      throw error;
    }
  }

  async save(userId, store) {
    const file = this.fileFor(userId);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `projects.${this.uuid()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      store.revision = Math.max(0, Number(store.revision) || 0) + 1;
      await handle.writeFile(JSON.stringify(store, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return store.projects
        .slice()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    });
  }

  async get(userId, projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const project = store.projects.find((item) => item.id === projectId);
      if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });
      return project;
    });
  }

  async create(userId, input = {}) {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const color = cleanColor(input.color);
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.projects.length >= MAX_PROJECTS) {
        throw Object.assign(new Error("This account has reached its project limit."), { status: 409 });
      }
      const duplicate = store.projects.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (duplicate) {
        throw Object.assign(new Error("A project with that name already exists."), { status: 409, code: "PROJECT_NAME_DUPLICATE" });
      }
      const now = this.now();
      const project = {
        id: this.uuid(),
        name,
        description,
        color,
        createdAt: now,
        updatedAt: now
      };
      store.projects.push(project);
      await this.save(userId, store);
      return project;
    });
  }

  async update(userId, projectId, input = {}) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    const patch = {};
    if (input.name !== undefined) patch.name = cleanName(input.name);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.color !== undefined) patch.color = cleanColor(input.color);
    if (!Object.keys(patch).length) {
      throw Object.assign(new Error("Provide at least one project field to update."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const project = store.projects.find((item) => item.id === projectId);
      if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });
      if (patch.name) {
        const duplicate = store.projects.find((item) => item.id !== projectId && item.name.toLowerCase() === patch.name.toLowerCase());
        if (duplicate) {
          throw Object.assign(new Error("A project with that name already exists."), { status: 409, code: "PROJECT_NAME_DUPLICATE" });
        }
      }
      Object.assign(project, patch, { updatedAt: this.now() });
      await this.save(userId, store);
      return project;
    });
  }

  async remove(userId, projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index < 0) throw Object.assign(new Error("Project not found."), { status: 404 });
      const [removed] = store.projects.splice(index, 1);
      await this.save(userId, store);
      return { deleted: true, project: removed };
    });
  }
}
