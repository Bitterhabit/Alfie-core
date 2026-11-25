import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

export class PendingActionStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => Date.now() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "pending-actions.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "pending-actions.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, actions: [], receipts: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.actions)) throw new Error("Pending action store failed integrity validation.");
    if (!Array.isArray(store.receipts)) store.receipts = [];
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "pending-actions.json", store, { pretty: false });
  }

  async create(userId, action, ttlMs = 15 * 60 * 1000) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const now = this.now();
      store.actions = store.actions.filter((item) => item.expiresAt > now && ["pending", "approved"].includes(item.status));
      const pending = {
        id: randomUUID(), ownerId: userId, toolId: action.toolId, risk: action.risk || "write",
        arguments: action.arguments, argumentsHash: action.argumentsHash,
        toolFingerprint: typeof action.toolFingerprint === "string" && action.toolFingerprint ? action.toolFingerprint : null,
        preview: String(action.preview || "").slice(0, 500),
        simulation: action.simulation && typeof action.simulation === "object" ? action.simulation : null,
        projectId: typeof action.projectId === "string" && action.projectId ? action.projectId : null,
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

  async recordReceipt(userId, receipt = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const status = receipt.status === "failed" ? "failed" : "completed";
      const validStates = new Set(["verified", "unverified", "verification_failed", "execution_failed"]);
      const fallbackState = status === "failed"
        ? "execution_failed"
        : (receipt.verified === true ? "verified" : "unverified");
      const verificationState = validStates.has(receipt.verificationState) ? receipt.verificationState : fallbackState;
      const entry = {
        id: randomUUID(),
        actionId: String(receipt.actionId || "").slice(0, 64),
        toolId: String(receipt.toolId || "").slice(0, 80),
        toolName: String(receipt.toolName || receipt.toolId || "").slice(0, 100),
        riskLevel: ["low", "medium", "high"].includes(receipt.riskLevel) ? receipt.riskLevel : "medium",
        status,
        summary: String(receipt.summary || "").slice(0, 300),
        affectedResource: String(receipt.affectedResource || "").slice(0, 160),
        rollbackPlan: String(receipt.rollbackPlan || "").slice(0, 260),
        verified: verificationState === "verified",
        verificationState,
        verificationDetail: String(receipt.verificationDetail || "").slice(0, 260),
        executedAt: new Date(this.now()).toISOString()
      };
      store.receipts = [entry, ...(Array.isArray(store.receipts) ? store.receipts : [])].slice(0, 100);
      await this.save(userId, store);
      return entry;
    });
  }

  async listReceipts(userId, { limit = 25 } = {}) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 25));
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return (Array.isArray(store.receipts) ? store.receipts : []).slice(0, cap);
    });
  }
}
