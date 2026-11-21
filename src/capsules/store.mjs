import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, atomicWriteJson } from "../storage/userJsonStore.mjs";
import { WORKING_MODES } from "../agent/workingModes.mjs";
import { LEARNING_MODES } from "../profile/store.mjs";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,120}$/;
const MAX_CAPSULES = 40;
const MAX_LEASE_TEMPLATES = 8;
const MAX_LEASE_TTL_MINUTES = 10080;

export const PRIVACY_POSTURES = Object.freeze([
  { id: "local_only", label: "Local only", description: "Keep all prompts and tools on local Alfie Core." },
  { id: "cloud_isolated", label: "Cloud (private data locked)", description: "Allow cloud coding agent with personal sections locked." },
  { id: "cloud_scoped", label: "Cloud (explicit sections)", description: "Use the configured cloud privacy section grants." }
]);

const WORKING_MODE_SET = new Set(WORKING_MODES.map((m) => m.id));
const LEARNING_MODE_SET = new Set(LEARNING_MODES.map((m) => m.id));
const PRIVACY_POSTURE_SET = new Set(PRIVACY_POSTURES.map((p) => p.id));

function cleanText(value, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanLeaseTemplate(list, allowedScopes = null) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list.slice(0, MAX_LEASE_TEMPLATES)) {
    const scope = cleanText(item?.scope, 120);
    if (!scope || !SCOPE_PATTERN.test(scope)) {
      throw Object.assign(new Error(`Invalid permission scope in capsule lease template: "${scope || "empty"}".`), { status: 400 });
    }
    if (allowedScopes && !allowedScopes.has(scope)) {
      throw Object.assign(new Error(`Unknown permission scope in capsule lease template: "${scope}".`), { status: 400 });
    }
    if (seen.has(scope)) continue;
    seen.add(scope);
    let ttlMinutes = null;
    if (item?.ttlMinutes !== undefined && item?.ttlMinutes !== null && item?.ttlMinutes !== "") {
      const minutes = Number(item.ttlMinutes);
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > MAX_LEASE_TTL_MINUTES) {
        throw Object.assign(new Error("Capsule lease TTL must be between 5 and 10,080 minutes."), { status: 400 });
      }
      ttlMinutes = Math.round(minutes);
    }
    out.push({ scope, ttlMinutes });
  }
  return out;
}

function normaliseCapsule(raw = {}, nowIso = new Date().toISOString()) {
  const workingMode = WORKING_MODE_SET.has(String(raw.workingMode || "").toLowerCase())
    ? String(raw.workingMode).toLowerCase()
    : "companion";
  const learningMode = LEARNING_MODE_SET.has(String(raw.learningMode || "").toLowerCase())
    ? String(raw.learningMode).toLowerCase()
    : "explain";
  const privacyPosture = PRIVACY_POSTURE_SET.has(String(raw.privacyPosture || "").toLowerCase())
    ? String(raw.privacyPosture).toLowerCase()
    : "local_only";
  const projectId = UUID_PATTERN.test(String(raw.projectId || "")) ? String(raw.projectId) : null;
  const leaseTemplate = Array.isArray(raw.leaseTemplate)
    ? raw.leaseTemplate
        .filter((l) => l && typeof l.scope === "string" && SCOPE_PATTERN.test(l.scope))
        .slice(0, MAX_LEASE_TEMPLATES)
        .map((l) => ({
          scope: l.scope,
          ttlMinutes: Number.isFinite(Number(l.ttlMinutes)) && Number(l.ttlMinutes) >= 5
            ? Math.min(MAX_LEASE_TTL_MINUTES, Math.round(Number(l.ttlMinutes)))
            : null
        }))
    : [];
  return {
    id: UUID_PATTERN.test(String(raw.id || "")) ? String(raw.id) : randomUUID(),
    name: cleanText(raw.name, 80) || "Untitled Capsule",
    description: cleanText(raw.description, 240),
    projectId,
    workingMode,
    learningMode,
    privacyPosture,
    leaseTemplate,
    createdAt: cleanText(raw.createdAt, 40) || nowIso,
    updatedAt: cleanText(raw.updatedAt, 40) || nowIso,
    lastActivatedAt: cleanText(raw.lastActivatedAt, 40) || null
  };
}

export class ContextCapsuleStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "context-capsules.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    try {
      const store = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.capsules)) {
        throw new Error("Context capsule store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") {
        return { schemaVersion: 1, ownerId: userId, activeCapsuleId: null, capsules: [] };
      }
      throw error;
    }
  }

  async save(userId, store) {
    await atomicWriteJson(this.fileFor(userId), store, { uuid: this.uuid });
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const capsules = store.capsules.map((c) => normaliseCapsule(c, nowIso));
      const activeCapsuleId = capsules.some((c) => c.id === store.activeCapsuleId) ? store.activeCapsuleId : null;
      return { activeCapsuleId, capsules };
    });
  }

  async get(userId, capsuleId) {
    if (!UUID_PATTERN.test(String(capsuleId || ""))) {
      throw Object.assign(new Error("Context capsule not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const found = store.capsules.find((c) => c.id === capsuleId);
      if (!found) throw Object.assign(new Error("Context capsule not found."), { status: 404 });
      return normaliseCapsule(found, this.now());
    });
  }

  async create(userId, input = {}, { allowedScopes = null } = {}) {
    const name = cleanText(input.name, 80);
    if (!name) throw Object.assign(new Error("Capsule name is required."), { status: 400 });
    const workingMode = input.workingMode !== undefined ? String(input.workingMode).toLowerCase() : "companion";
    if (!WORKING_MODE_SET.has(workingMode)) {
      throw Object.assign(new Error("Unsupported workingMode for context capsule."), { status: 400 });
    }
    const learningMode = input.learningMode !== undefined ? String(input.learningMode).toLowerCase() : "explain";
    if (!LEARNING_MODE_SET.has(learningMode)) {
      throw Object.assign(new Error("Unsupported learningMode for context capsule."), { status: 400 });
    }
    const privacyPosture = input.privacyPosture !== undefined ? String(input.privacyPosture).toLowerCase() : "local_only";
    if (!PRIVACY_POSTURE_SET.has(privacyPosture)) {
      throw Object.assign(new Error("Unsupported privacyPosture for context capsule."), { status: 400 });
    }
    let projectId = null;
    if (input.projectId !== undefined && input.projectId !== null && input.projectId !== "") {
      if (!UUID_PATTERN.test(String(input.projectId))) {
        throw Object.assign(new Error("Invalid projectId for context capsule."), { status: 400 });
      }
      projectId = String(input.projectId);
    }
    const leaseTemplate = cleanLeaseTemplate(input.leaseTemplate || [], allowedScopes);

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.capsules.length >= MAX_CAPSULES) {
        throw Object.assign(new Error("Context capsule limit reached (40)."), { status: 409 });
      }
      const nowIso = this.now();
      const capsule = normaliseCapsule({
        id: this.uuid(),
        name,
        description: cleanText(input.description, 240),
        projectId,
        workingMode,
        learningMode,
        privacyPosture,
        leaseTemplate,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastActivatedAt: null
      }, nowIso);
      store.capsules.unshift(capsule);
      await this.save(userId, store);
      return capsule;
    });
  }

  async update(userId, capsuleId, patch = {}, { allowedScopes = null } = {}) {
    if (!UUID_PATTERN.test(String(capsuleId || ""))) {
      throw Object.assign(new Error("Context capsule not found."), { status: 404 });
    }
    if (patch.workingMode !== undefined && !WORKING_MODE_SET.has(String(patch.workingMode).toLowerCase())) {
      throw Object.assign(new Error("Unsupported workingMode for context capsule."), { status: 400 });
    }
    if (patch.learningMode !== undefined && !LEARNING_MODE_SET.has(String(patch.learningMode).toLowerCase())) {
      throw Object.assign(new Error("Unsupported learningMode for context capsule."), { status: 400 });
    }
    if (patch.privacyPosture !== undefined && !PRIVACY_POSTURE_SET.has(String(patch.privacyPosture).toLowerCase())) {
      throw Object.assign(new Error("Unsupported privacyPosture for context capsule."), { status: 400 });
    }
    if (patch.projectId !== undefined && patch.projectId !== null && patch.projectId !== "" && !UUID_PATTERN.test(String(patch.projectId))) {
      throw Object.assign(new Error("Invalid projectId for context capsule."), { status: 400 });
    }
    const nextLeases = patch.leaseTemplate !== undefined ? cleanLeaseTemplate(patch.leaseTemplate, allowedScopes) : undefined;

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const existing = store.capsules.find((c) => c.id === capsuleId);
      if (!existing) throw Object.assign(new Error("Context capsule not found."), { status: 404 });
      const nowIso = this.now();
      if (typeof patch.name === "string" && patch.name.trim()) existing.name = cleanText(patch.name, 80);
      if (typeof patch.description === "string") existing.description = cleanText(patch.description, 240);
      if (patch.projectId !== undefined) existing.projectId = patch.projectId ? String(patch.projectId) : null;
      if (patch.workingMode !== undefined) existing.workingMode = String(patch.workingMode).toLowerCase();
      if (patch.learningMode !== undefined) existing.learningMode = String(patch.learningMode).toLowerCase();
      if (patch.privacyPosture !== undefined) existing.privacyPosture = String(patch.privacyPosture).toLowerCase();
      if (nextLeases !== undefined) existing.leaseTemplate = nextLeases;
      existing.updatedAt = nowIso;
      await this.save(userId, store);
      return normaliseCapsule(existing, nowIso);
    });
  }

  async markActivated(userId, capsuleId) {
    if (!UUID_PATTERN.test(String(capsuleId || ""))) {
      throw Object.assign(new Error("Context capsule not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const existing = store.capsules.find((c) => c.id === capsuleId);
      if (!existing) throw Object.assign(new Error("Context capsule not found."), { status: 404 });
      const nowIso = this.now();
      existing.lastActivatedAt = nowIso;
      existing.updatedAt = nowIso;
      store.activeCapsuleId = existing.id;
      await this.save(userId, store);
      return { activeCapsuleId: existing.id, capsule: normaliseCapsule(existing, nowIso) };
    });
  }

  async remove(userId, capsuleId) {
    if (!UUID_PATTERN.test(String(capsuleId || ""))) {
      throw Object.assign(new Error("Context capsule not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idx = store.capsules.findIndex((c) => c.id === capsuleId);
      if (idx < 0) throw Object.assign(new Error("Context capsule not found."), { status: 404 });
      const [removed] = store.capsules.splice(idx, 1);
      if (store.activeCapsuleId === capsuleId) store.activeCapsuleId = null;
      await this.save(userId, store);
      return { deleted: true, capsule: removed, activeCapsuleId: store.activeCapsuleId };
    });
  }
}
