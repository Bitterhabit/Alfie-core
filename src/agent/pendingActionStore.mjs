import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function userKey(userId) {
  if (typeof userId !== "string" || !/^[a-zA-Z0-9._:@-]{1,128}$/.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

export class PendingActionStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => Date.now() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.queues = new Map();
  }

  fileFor(userId) { return path.join(this.dataDirectory, "users", userKey(userId), "pending-actions.json"); }

  async exclusive(userId, operation) {
    const key = this.fileFor(userId);
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
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.actions)) throw new Error("Pending action store failed integrity validation.");
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, ownerId: userId, actions: [] };
      throw error;
    }
  }

  async save(userId, store) {
    const file = this.fileFor(userId), dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(store), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  }

  async create(userId, action, ttlMs = 5 * 60 * 1000) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const now = this.now();
      store.actions = store.actions.filter((item) => item.expiresAt > now && ["pending", "approved"].includes(item.status));
      const pending = {
        id: randomUUID(), ownerId: userId, toolId: action.toolId, risk: action.risk || "write",
        arguments: action.arguments, argumentsHash: action.argumentsHash,
        preview: String(action.preview || "").slice(0, 500),
        approvalGuard: action.approvalGuard ?? null,
        reason: action.reason || "User approval required",
        createdAt: new Date(now).toISOString(), expiresAt: now + ttlMs,
        status: "pending"
      };
      store.actions.push(pending);
      await this.save(userId, store);
      return { ...pending };
    });
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId), now = this.now();
      store.actions = store.actions.filter((item) => item.expiresAt > now && item.status === "pending");
      await this.save(userId, store);
      return store.actions.map(({ arguments: args, ...item }) => ({ ...item, arguments: args }));
    });
  }

  async take(userId, actionId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.actions.findIndex((item) => item.id === actionId && item.ownerId === userId);
      if (index < 0) throw Object.assign(new Error("Pending action not found."), { status: 404 });
      const [action] = store.actions.splice(index, 1);
      if (action.expiresAt <= this.now() || action.status !== "pending") {
        await this.save(userId, store);
        throw Object.assign(new Error("Pending action expired or was already handled."), { status: 409 });
      }
      await this.save(userId, store);
      return action;
    });
  }

  async reject(userId, actionId) {
    const action = await this.take(userId, actionId);
    return { actionId: action.id, status: "rejected" };
  }
}
