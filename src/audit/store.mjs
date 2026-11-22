import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

export class AuditStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "audit.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const value = await readUserJsonDocument(this.dataDirectory, userId, "audit.json");
    if (!value) return { schemaVersion: 1, ownerId: userId, events: [] };
    if (value.schemaVersion !== 1 || value.ownerId !== userId || !Array.isArray(value.events)) {
      throw new Error("Audit store failed its integrity check.");
    }
    return value;
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
      await writeUserJsonDocument(this.dataDirectory, userId, "audit.json", store);
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
