import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";
import { runWorkshopDelegation, SPECIALIST_ROLES } from "../agents/workshop.mjs";
import { buildContinuityReflection } from "../reflections/generator.mjs";

export const PLAYBOOK_TRIGGERS = Object.freeze([
  "manual_run",
  "watcher_alert",
  "project_stalled",
  "weekly_cadence"
]);

export const PLAYBOOK_ACTIONS = Object.freeze([
  "delegate_workshop",
  "generate_reflection",
  "park_idea",
  "emit_attention_digest"
]);

const TRIGGER_SET = new Set(PLAYBOOK_TRIGGERS);
const ACTION_SET = new Set(PLAYBOOK_ACTIONS);
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_PLAYBOOKS = 40;

function cleanString(value, maxLen = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * Deterministic Automation Rules & Safe Playbooks (Phase 6.4).
 * Zero shell execution, zero autonomous external writes — playbooks strictly
 * synthesize, delegate inside user capability ceilings, snapshot, or draft.
 */
export class PlaybookStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "playbooks.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, playbooks: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.playbooks)) {
      throw new Error("Playbook store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "playbooks.json", store, { uuid: this.uuid });
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return store.playbooks;
    });
  }

  async get(userId, playbookId) {
    if (!UUID_PATTERN.test(String(playbookId || ""))) {
      throw Object.assign(new Error("Playbook not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const found = store.playbooks.find((p) => p.id === playbookId);
      if (!found) throw Object.assign(new Error("Playbook not found."), { status: 404 });
      return found;
    });
  }

  validateConfig(action, rawConfig = {}) {
    const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (action === "delegate_workshop") {
      const roleId = cleanString(cfg.roleId || "auditor", 32).toLowerCase();
      if (!SPECIALIST_ROLES[roleId]) {
        throw Object.assign(new Error("Playbook specialist role must be researcher, auditor, planner, or developer."), { status: 400 });
      }
      const objective = cleanString(cfg.objective || "Synthesize current blockers, watchers, and pending items.", 400);
      return { roleId, objective };
    }
    if (action === "generate_reflection") {
      const period = ["weekly", "monthly", "yearly"].includes(cfg.period) ? cfg.period : "weekly";
      return { period };
    }
    if (action === "park_idea") {
      const title = cleanString(cfg.title || "Playbook follow-up review", 140);
      const notes = cleanString(cfg.notes || "Captured deterministically via Alfie Playbook.", 500);
      return { title, notes };
    }
    return {
      summary: cleanString(cfg.summary || "Deterministic calm digest checkpoint recorded.", 300)
    };
  }

  async create(userId, input = {}) {
    const name = cleanString(input.name, 100);
    if (!name) throw Object.assign(new Error("A playbook name is required."), { status: 400 });

    const trigger = cleanString(input.trigger || "manual_run", 40).toLowerCase();
    if (!TRIGGER_SET.has(trigger)) {
      throw Object.assign(new Error(`Invalid trigger. Use: ${PLAYBOOK_TRIGGERS.join(", ")}.`), { status: 400 });
    }

    const action = cleanString(input.action || "delegate_workshop", 40).toLowerCase();
    if (!ACTION_SET.has(action)) {
      throw Object.assign(new Error(`Invalid action. Use: ${PLAYBOOK_ACTIONS.join(", ")}.`), { status: 400 });
    }

    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw Object.assign(new Error("enabled must be a strict boolean (true or false)."), { status: 400 });
    }
    const enabled = input.enabled === undefined ? true : input.enabled;

    const cooldownMinutes = Math.max(0, Math.min(10080, Math.floor(Number(input.cooldownMinutes ?? 60))));
    const projectId = UUID_PATTERN.test(String(input.projectId || "")) ? String(input.projectId) : null;
    const config = this.validateConfig(action, input.config);

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.playbooks.length >= MAX_PLAYBOOKS) {
        throw Object.assign(new Error(`Maximum of ${MAX_PLAYBOOKS} playbooks reached.`), { status: 400 });
      }
      const nowIso = this.now();
      const playbook = {
        id: this.uuid(),
        ownerId: userId,
        name,
        trigger,
        action,
        projectId,
        config,
        enabled,
        cooldownMinutes,
        runCount: 0,
        lastRunAt: null,
        lastOutcome: null,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      store.playbooks = [playbook, ...store.playbooks];
      await this.save(userId, store);
      return playbook;
    });
  }

  async update(userId, playbookId, patch = {}) {
    if (!UUID_PATTERN.test(String(playbookId || ""))) {
      throw Object.assign(new Error("Playbook not found."), { status: 404 });
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw Object.assign(new Error("enabled must be a strict boolean (true or false)."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idx = store.playbooks.findIndex((p) => p.id === playbookId);
      if (idx === -1) throw Object.assign(new Error("Playbook not found."), { status: 404 });
      const current = store.playbooks[idx];

      const nextTrigger = patch.trigger !== undefined ? cleanString(patch.trigger, 40).toLowerCase() : current.trigger;
      if (!TRIGGER_SET.has(nextTrigger)) {
        throw Object.assign(new Error(`Invalid trigger. Use: ${PLAYBOOK_TRIGGERS.join(", ")}.`), { status: 400 });
      }
      const nextAction = patch.action !== undefined ? cleanString(patch.action, 40).toLowerCase() : current.action;
      if (!ACTION_SET.has(nextAction)) {
        throw Object.assign(new Error(`Invalid action. Use: ${PLAYBOOK_ACTIONS.join(", ")}.`), { status: 400 });
      }

      const next = {
        ...current,
        name: patch.name !== undefined ? cleanString(patch.name, 100) || current.name : current.name,
        trigger: nextTrigger,
        action: nextAction,
        enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
        cooldownMinutes: patch.cooldownMinutes !== undefined
          ? Math.max(0, Math.min(10080, Math.floor(Number(patch.cooldownMinutes))))
          : current.cooldownMinutes,
        config: patch.config !== undefined ? this.validateConfig(nextAction, patch.config) : current.config,
        updatedAt: this.now()
      };
      store.playbooks[idx] = next;
      await this.save(userId, store);
      return next;
    });
  }

  async recordRun(userId, playbookId, outcomeSummary) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idx = store.playbooks.findIndex((p) => p.id === playbookId);
      if (idx === -1) return null;
      const current = store.playbooks[idx];
      const nowIso = this.now();
      const updated = {
        ...current,
        runCount: (current.runCount || 0) + 1,
        lastRunAt: nowIso,
        lastOutcome: cleanString(outcomeSummary, 320),
        updatedAt: nowIso
      };
      store.playbooks[idx] = updated;
      await this.save(userId, store);
      return updated;
    });
  }

  async delete(userId, playbookId) {
    if (!UUID_PATTERN.test(String(playbookId || ""))) {
      throw Object.assign(new Error("Playbook not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const before = store.playbooks.length;
      store.playbooks = store.playbooks.filter((p) => p.id !== playbookId);
      if (store.playbooks.length === before) {
        throw Object.assign(new Error("Playbook not found."), { status: 404 });
      }
      await this.save(userId, store);
      return { deleted: true, id: playbookId };
    });
  }
}

/**
 * Executes (or dry-run previews) a deterministic Playbook safely inside Alfie Core.
 */
export async function runPlaybook({
  userId,
  playbookId,
  dryRun = false,
  stores,
  jobEngine,
  dataDirectory
}) {
  const playbook = await stores.playbookStore.get(userId, playbookId);

  const previewMap = {
    delegate_workshop: `Will delegate a bounded "${playbook.config?.roleId || "auditor"}" Workshop job inside your active capability ceiling.`,
    generate_reflection: `Will compute and archive a local "${playbook.config?.period || "weekly"}" continuity reflection snapshot in SQLite WAL.`,
    park_idea: `Will park a structured idea "${playbook.config?.title || "Playbook follow-up"}" tagged #playbook in Ideas Vault.`,
    emit_attention_digest: `Will record a calm digest note in the Audit Log without interrupting quiet hours.`
  };

  if (dryRun) {
    return {
      dryRun: true,
      playbook,
      preview: {
        action: playbook.action,
        trigger: playbook.trigger,
        externalSideEffects: false,
        autonomousWrites: false,
        summary: previewMap[playbook.action] || "Deterministic read/synthesize action."
      }
    };
  }

  let outcomeSummary = "";
  let artifact = null;

  if (playbook.action === "delegate_workshop") {
    const job = await runWorkshopDelegation({
      userId,
      roleId: playbook.config?.roleId || "auditor",
      objective: playbook.config?.objective || `Playbook "${playbook.name}" review`,
      projectId: playbook.projectId,
      stores,
      jobEngine,
      dataDirectory
    });
    outcomeSummary = `Delegated ${job.role} job (${job.status}): ${job.artifact?.summary || job.title}`;
    artifact = { jobId: job.id, status: job.status, summary: job.artifact?.summary || "" };
  } else if (playbook.action === "generate_reflection") {
    const period = playbook.config?.period || "weekly";
    const [projects, memories, ideas, watchers, watcherEvents, profile] = await Promise.all([
      stores.projectStore ? stores.projectStore.list(userId) : [],
      stores.memoryStore ? stores.memoryStore.list(userId, { limit: 200 }) : [],
      stores.ideaStore ? stores.ideaStore.list(userId) : [],
      stores.watcherStore ? stores.watcherStore.list(userId) : [],
      stores.watcherStore ? stores.watcherStore.listEvents(userId, { limit: 50 }) : [],
      stores.profileStore ? stores.profileStore.get(userId) : null
    ]);
    const reflection = buildContinuityReflection(
      { projects, memories, ideas, watchers, watcherEvents, profile },
      { period }
    );
    const snapshot = stores.reflectionStore
      ? await stores.reflectionStore.saveSnapshot(userId, reflection)
      : reflection;
    outcomeSummary = `Saved ${period} continuity snapshot (${reflection.metrics?.activeProjects ?? 0} projects, ${reflection.metrics?.recentMemories ?? 0} recent memories).`;
    artifact = { snapshotId: snapshot.id || null, period };
  } else if (playbook.action === "park_idea") {
    const idea = await stores.ideaStore.create(userId, {
      title: playbook.config?.title || `Follow-up: ${playbook.name}`,
      notes: `${playbook.config?.notes || "Captured by playbook"} #playbook`,
      projectId: playbook.projectId || "",
      priority: "medium"
    });
    outcomeSummary = `Parked idea "${idea.title}" in Ideas Vault.`;
    artifact = { ideaId: idea.id, title: idea.title };
  } else {
    outcomeSummary = playbook.config?.summary || `Calm digest logged for playbook "${playbook.name}".`;
    artifact = { digest: outcomeSummary };
  }

  const updatedPlaybook = await stores.playbookStore.recordRun(userId, playbook.id, outcomeSummary);

  if (stores.auditStore) {
    await stores.auditStore.record(userId, {
      event: "playbook.executed",
      actor: "alfie:playbook",
      risk: "low",
      status: "completed",
      detail: `Playbook "${playbook.name}" (${playbook.action}): ${outcomeSummary}`
    });
  }

  return {
    dryRun: false,
    playbook: updatedPlaybook,
    outcomeSummary,
    artifact
  };
}
