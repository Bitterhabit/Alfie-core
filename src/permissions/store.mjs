import fs from "node:fs/promises";
import path from "node:path";
import { safeUserKey, userDataFile, UserMutex, atomicWriteJson } from "../storage/userJsonStore.mjs";

const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,120}$/;
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

function cleanProjectId(value) {
  if (value === undefined || value === null || value === "") return null;
  const candidate = String(value).trim();
  if (!UUID_PATTERN.test(candidate)) {
    throw Object.assign(new Error("Capability lease projectId must be a valid project UUID."), { status: 400 });
  }
  return candidate;
}

function cleanLeaseExpiry(expiresAt, ttlMinutes, nowMs) {
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== "") {
    const parsed = Date.parse(String(expiresAt));
    if (!Number.isFinite(parsed) || parsed <= nowMs) {
      throw Object.assign(new Error("Capability lease expiry must be a valid future ISO-8601 timestamp."), { status: 400 });
    }
    return new Date(parsed).toISOString();
  }
  if (ttlMinutes !== undefined && ttlMinutes !== null && ttlMinutes !== "") {
    const minutes = Number(ttlMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) {
      throw Object.assign(new Error("Capability lease duration must be between 1 minute and 30 days."), { status: 400 });
    }
    return new Date(nowMs + Math.round(minutes * 60 * 1000)).toISOString();
  }
  return null;
}

function normaliseStoreLeases(store) {
  const existing = Array.isArray(store.leases) ? store.leases : [];
  const byScope = new Map();
  for (const lease of existing) {
    if (!lease || typeof lease.scope !== "string" || !SCOPE_PATTERN.test(lease.scope)) continue;
    byScope.set(lease.scope, {
      scope: lease.scope,
      grantedAt: typeof lease.grantedAt === "string" ? lease.grantedAt : (store.updatedAt || null),
      expiresAt: typeof lease.expiresAt === "string" && Number.isFinite(Date.parse(lease.expiresAt))
        ? new Date(Date.parse(lease.expiresAt)).toISOString()
        : null,
      projectId: UUID_PATTERN.test(String(lease.projectId || "")) ? String(lease.projectId) : null,
      note: typeof lease.note === "string" ? lease.note.trim().slice(0, 200) : ""
    });
  }
  for (const scope of (store.scopes || [])) {
    if (typeof scope === "string" && SCOPE_PATTERN.test(scope) && !byScope.has(scope)) {
      byScope.set(scope, {
        scope,
        grantedAt: store.updatedAt || null,
        expiresAt: null,
        projectId: null,
        note: ""
      });
    }
  }
  return [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}

export class PermissionStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => Date.now() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "permissions.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    try {
      const store = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.scopes)) {
        throw new Error("Permission store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, ownerId: userId, scopes: [], leases: [], updatedAt: null };
      throw error;
    }
  }

  async save(userId, store) {
    await atomicWriteJson(this.fileFor(userId), store);
  }

  async pruneAndLoad(userId) {
    const store = await this.load(userId);
    const nowMs = this.now();
    const leases = normaliseStoreLeases(store);
    const active = leases.filter((lease) => !lease.expiresAt || Date.parse(lease.expiresAt) > nowMs);
    const expiredCount = leases.length - active.length;
    if (expiredCount > 0) {
      store.leases = active;
      store.scopes = active.map((lease) => lease.scope);
      store.updatedAt = new Date(nowMs).toISOString();
      await this.save(userId, store);
    }
    return { store, active };
  }

  async list(userId, { projectId = null } = {}) {
    return this.exclusive(userId, async () => {
      const { active } = await this.pruneAndLoad(userId);
      const targetProject = projectId ? String(projectId) : null;
      return active
        .filter((lease) => !lease.projectId || (targetProject && lease.projectId === targetProject))
        .map((lease) => lease.scope)
        .sort();
    });
  }

  async listDetailed(userId) {
    return this.exclusive(userId, async () => {
      const { active } = await this.pruneAndLoad(userId);
      return {
        scopes: active.map((lease) => lease.scope).sort(),
        leases: active
      };
    });
  }

  async grant(userId, scope, options = {}) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error("Permission scope is invalid."), { status: 400 });
    }
    const nowMs = this.now();
    const expiresAt = cleanLeaseExpiry(options?.expiresAt, options?.ttlMinutes, nowMs);
    const projectId = cleanProjectId(options?.projectId);
    const note = typeof options?.note === "string" ? options.note.trim().slice(0, 200) : "";
    return this.exclusive(userId, async () => {
      const { store, active } = await this.pruneAndLoad(userId);
      const nextLease = {
        scope,
        grantedAt: new Date(nowMs).toISOString(),
        expiresAt,
        projectId,
        note
      };
      const filtered = active.filter((item) => item.scope !== scope);
      filtered.push(nextLease);
      filtered.sort((a, b) => a.scope.localeCompare(b.scope));
      store.leases = filtered;
      store.scopes = filtered.map((item) => item.scope);
      store.updatedAt = new Date(nowMs).toISOString();
      await this.save(userId, store);
      return store.scopes.slice();
    });
  }

  async revoke(userId, scope) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error("Permission scope is invalid."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const { store, active } = await this.pruneAndLoad(userId);
      const filtered = active.filter((item) => item.scope !== scope);
      store.leases = filtered;
      store.scopes = filtered.map((item) => item.scope);
      store.updatedAt = new Date(this.now()).toISOString();
      await this.save(userId, store);
      return store.scopes.slice();
    });
  }
}
