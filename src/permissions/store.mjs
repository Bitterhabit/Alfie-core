import fs from "node:fs/promises";
import path from "node:path";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

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

function leaseKey(scope, projectId) {
  return `${scope}::${projectId || "*"}`;
}

function sortLeases(leases) {
  return leases.sort((a, b) => {
    const scopeCmp = a.scope.localeCompare(b.scope);
    if (scopeCmp !== 0) return scopeCmp;
    return String(a.projectId || "").localeCompare(String(b.projectId || ""));
  });
}

function uniqueSortedScopes(leases) {
  return [...new Set(leases.map((lease) => lease.scope))].sort();
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
  const hasLeasesArray = Array.isArray(store.leases);
  const existing = hasLeasesArray ? store.leases : [];
  const byKey = new Map();
  const coveredScopes = new Set();

  for (const lease of existing) {
    if (!lease || typeof lease.scope !== "string" || !SCOPE_PATTERN.test(lease.scope)) continue;
    const projectId = UUID_PATTERN.test(String(lease.projectId || "")) ? String(lease.projectId) : null;
    const key = leaseKey(lease.scope, projectId);
    coveredScopes.add(lease.scope);
    byKey.set(key, {
      scope: lease.scope,
      grantedAt: typeof lease.grantedAt === "string" ? lease.grantedAt : (store.updatedAt || null),
      expiresAt: typeof lease.expiresAt === "string" && Number.isFinite(Date.parse(lease.expiresAt))
        ? new Date(Date.parse(lease.expiresAt)).toISOString()
        : null,
      projectId,
      note: typeof lease.note === "string" ? lease.note.trim().slice(0, 200) : ""
    });
  }

  // Legacy migration: ONLY migrate store.scopes into global leases for legacy files
  // that predate the `leases` array. Modern stores treat `leases` as authoritative
  // so project-scoped or expired leases can never be widened into global grants.
  if (!hasLeasesArray) {
    for (const scope of (store.scopes || [])) {
      if (typeof scope === "string" && SCOPE_PATTERN.test(scope) && !coveredScopes.has(scope)) {
        coveredScopes.add(scope);
        byKey.set(leaseKey(scope, null), {
          scope,
          grantedAt: store.updatedAt || null,
          expiresAt: null,
          projectId: null,
          note: ""
        });
      }
    }
  }

  return sortLeases([...byKey.values()]);
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
    const store = await readUserJsonDocument(this.dataDirectory, userId, "permissions.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, scopes: [], leases: [], updatedAt: null };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.scopes)) {
      throw new Error("Permission store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "permissions.json", store);
  }

  async pruneAndLoad(userId) {
    const store = await this.load(userId);
    const nowMs = this.now();
    const leases = normaliseStoreLeases(store);
    const active = leases.filter((lease) => !lease.expiresAt || Date.parse(lease.expiresAt) > nowMs);
    const expiredCount = leases.length - active.length;
    if (expiredCount > 0) {
      store.leases = active;
      store.scopes = uniqueSortedScopes(active);
      store.updatedAt = new Date(nowMs).toISOString();
      await this.save(userId, store);
    }
    return { store, active };
  }

  async list(userId, { projectId = null } = {}) {
    return this.exclusive(userId, async () => {
      const { active } = await this.pruneAndLoad(userId);
      const targetProject = projectId ? String(projectId) : null;
      const matching = active.filter((lease) => !lease.projectId || (targetProject && lease.projectId === targetProject));
      return uniqueSortedScopes(matching);
    });
  }

  async listDetailed(userId) {
    return this.exclusive(userId, async () => {
      const { active } = await this.pruneAndLoad(userId);
      return {
        scopes: uniqueSortedScopes(active),
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
      // Identity is (scope, projectId): preserve global and other projects' leases for the same scope.
      const targetKey = leaseKey(scope, projectId);
      const filtered = active.filter((item) => leaseKey(item.scope, item.projectId) !== targetKey);
      filtered.push(nextLease);
      sortLeases(filtered);
      store.leases = filtered;
      store.scopes = uniqueSortedScopes(filtered);
      store.updatedAt = new Date(nowMs).toISOString();
      await this.save(userId, store);
      return store.scopes.slice();
    });
  }

  /**
   * Revokes capability lease(s) for a scope:
   * - revoke(userId, scope) [no projectId option]: revokes ALL leases for `scope` (global + all projects).
   * - revoke(userId, scope, { projectId: "<uuid>" }): revokes ONLY the lease for that specific project.
   * - revoke(userId, scope, { projectId: null }): revokes ONLY the global lease for `scope`.
   */
  async revoke(userId, scope, options = {}) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error("Permission scope is invalid."), { status: 400 });
    }
    const hasExplicitProject = Boolean(
      options &&
      typeof options === "object" &&
      Object.prototype.hasOwnProperty.call(options, "projectId") &&
      options.projectId !== undefined
    );
    const targetProjectId = hasExplicitProject ? cleanProjectId(options.projectId) : undefined;

    return this.exclusive(userId, async () => {
      const { store, active } = await this.pruneAndLoad(userId);
      const filtered = hasExplicitProject
        ? active.filter((item) => !(item.scope === scope && (item.projectId || null) === targetProjectId))
        : active.filter((item) => item.scope !== scope);
      store.leases = filtered;
      store.scopes = uniqueSortedScopes(filtered);
      store.updatedAt = new Date(this.now()).toISOString();
      await this.save(userId, store);
      return store.scopes.slice();
    });
  }
}
