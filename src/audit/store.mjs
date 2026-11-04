import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function userKey(userId) {
  if (typeof userId !== "string" || !/^[a-zA-Z0-9._:@-]{1,128}$/.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

export class AuditStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.queues = new Map();
  }

  fileFor(userId) { return path.join(this.dataDirectory, "users", userKey(userId), "audit.json"); }

  async exclusive(userId, operation) {
    const file = this.fileFor(userId);
    const previous = this.queues.get(file) || Promise.resolve();
    const current = previous.then(operation, operation);
    const queued = current.catch(() => {});
    this.queues.set(file, queued);
    try { return await current; }
    finally { if (this.queues.get(file) === queued) this.queues.delete(file); }
  }

  async load(userId) {
    try {
      const value = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (value.schemaVersion !== 1 || value.ownerId !== userId || !Array.isArray(value.events)) {
        throw new Error("Audit store failed its integrity check.");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, ownerId: userId, events: [] };
      throw error;
    }
  }

  async record(userId, event = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const entry = {
        id: randomUUID(),
        at: this.now(),
        event: String(event.event || "tool.event").slice(0, 80),
        actor: String(event.actor || "system").slice(0, 40),
        toolId: String(event.toolId || "").slice(0, 80),
        actionId: String(event.actionId || "").slice(0, 64),
        risk: String(event.risk || "").slice(0, 16),
        status: String(event.status || "").slice(0, 40),
        argumentsHash: /^[a-f0-9]{64}$/i.test(String(event.argumentsHash || "")) ? event.argumentsHash : null,
        detail: String(event.detail || "").slice(0, 240)
      };
      store.events.push(entry);
      store.events = store.events.slice(-500);
      const file = this.fileFor(userId), directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(store, null, 2), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
      return entry;
    });
  }

  async list(userId, { limit = 100 } = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const requested = Number(limit);
      const safeLimit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
      return store.events.slice(-safeLimit).reverse();
    });
  }
}
