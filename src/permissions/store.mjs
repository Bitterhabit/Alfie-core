import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,120}$/;

export class PermissionStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data" } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.queues = new Map();
  }

  fileFor(userId) {
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
      throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
    }
    const key = createHash("sha256").update(userId).digest("hex");
    return path.join(this.dataDirectory, "users", key, "permissions.json");
  }

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
      const store = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.scopes)) {
        throw new Error("Permission store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, ownerId: userId, scopes: [], updatedAt: null };
      throw error;
    }
  }

  async save(userId, store) {
    const file = this.fileFor(userId);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(store, null, 2), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  }

  async list(userId) {
    return this.exclusive(userId, async () => (await this.load(userId)).scopes.slice().sort());
  }

  async grant(userId, scope) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error("Permission scope is invalid."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (!store.scopes.includes(scope)) store.scopes.push(scope);
      store.updatedAt = new Date().toISOString();
      await this.save(userId, store);
      return store.scopes.slice().sort();
    });
  }

  async revoke(userId, scope) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error("Permission scope is invalid."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      store.scopes = store.scopes.filter((item) => item !== scope);
      store.updatedAt = new Date().toISOString();
      await this.save(userId, store);
      return store.scopes.slice().sort();
    });
  }
}
