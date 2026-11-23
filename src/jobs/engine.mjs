import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

export const JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_JOBS = 120;
export const MAX_JOB_DURATION_MS = 30 * 60 * 1000;
export const DEFAULT_JOB_DURATION_MS = 30 * 60 * 1000;
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

function cleanString(value, maxLen = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * Durable per-user Async Job Store backed by SQLite WAL (`jobs.json` collection).
 * Implements ADR-004 state machine: queued -> running -> awaiting_approval -> completed | failed | cancelled.
 */
export class AsyncJobStore {
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
    const store = await readUserJsonDocument(this.dataDirectory, userId, "jobs.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, jobs: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.jobs)) {
      throw new Error("Async job store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "jobs.json", store, { uuid: this.uuid });
  }

  async list(userId, { status = "", limit = 40 } = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const statusFilter = cleanString(status, 32).toLowerCase();
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
      return store.jobs
        .filter((job) => (!statusFilter || statusFilter === "all" ? true : job.status === statusFilter))
        .slice(0, safeLimit);
    });
  }

  async get(userId, jobId) {
    if (!UUID_PATTERN.test(String(jobId || ""))) {
      throw Object.assign(new Error("Job not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const job = store.jobs.find((item) => item.id === jobId);
      if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
      return job;
    });
  }

  async create(userId, input = {}) {
    const title = cleanString(input.title, 140);
    if (!title) throw Object.assign(new Error("A job title is required."), { status: 400 });
    const kind = cleanString(input.kind || "workflow", 48).toLowerCase();
    const maxSteps = Math.max(1, Math.min(20, Math.floor(Number(input.maxSteps) || 6)));
    const maxDurationMs = Math.max(5000, Math.min(MAX_JOB_DURATION_MS, Math.floor(Number(input.maxDurationMs) || DEFAULT_JOB_DURATION_MS)));
    const tokenBudget = Math.max(500, Math.min(32000, Math.floor(Number(input.tokenBudget) || 4000)));
    const conversationId = UUID_PATTERN.test(String(input.conversationId || "")) ? String(input.conversationId) : null;
    const turnId = UUID_PATTERN.test(String(input.turnId || "")) ? String(input.turnId) : null;
    const idempotencyKey = cleanString(input.idempotencyKey || "", 80) || null;
    let payload = null;
    if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
      try { payload = JSON.parse(JSON.stringify(input.payload)); } catch { throw Object.assign(new Error("Task payload must be JSON serializable."), { status: 400 }); }
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 256 * 1024) throw Object.assign(new Error("Task payload exceeds the 256 KB limit."), { status: 413 });
    }

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (idempotencyKey) {
        const existing = store.jobs.find((item) => item.idempotencyKey === idempotencyKey);
        if (existing) {
          const sameTask = existing.kind === kind && existing.conversationId === conversationId && existing.turnId === turnId
            && JSON.stringify(existing.payload || null) === JSON.stringify(payload || null);
          if (!sameTask) throw Object.assign(new Error("This idempotency key was already used for a different task."), { status: 409, code: "JOB_IDEMPOTENCY_CONFLICT" });
          return existing;
        }
      }
      const nowIso = this.now();
      const job = {
        id: this.uuid(),
        ownerId: userId,
        kind,
        conversationId,
        turnId,
        idempotencyKey,
        payload,
        role: cleanString(input.role || "", 40) || null,
        title,
        objective: cleanString(input.objective || "", 1200),
        projectId: UUID_PATTERN.test(String(input.projectId || "")) ? String(input.projectId) : null,
        status: "queued",
        progress: 0,
        stepsCompleted: 0,
        budget: { maxSteps, maxDurationMs, tokenBudget },
        capabilityCeiling: Array.isArray(input.capabilityCeiling) ? input.capabilityCeiling.slice(0, 12) : [],
        lowestTrustTouched: "user_authored",
        tainted: false,
        pendingActionId: null,
        checkpoints: [
          {
            at: nowIso,
            step: 0,
            status: "queued",
            summary: "Job queued with explicit step, duration, and capability ceilings."
          }
        ],
        artifact: null,
        error: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        completedAt: null
      };
      store.jobs = [job, ...store.jobs].slice(0, MAX_JOBS);
      await this.save(userId, store);
      return job;
    });
  }

  async update(userId, jobId, mutator) {
    if (!UUID_PATTERN.test(String(jobId || ""))) {
      throw Object.assign(new Error("Job not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.jobs.findIndex((item) => item.id === jobId);
      if (index === -1) throw Object.assign(new Error("Job not found."), { status: 404 });
      const current = store.jobs[index];
      const next = typeof mutator === "function" ? mutator(current, this.now()) : { ...current, ...mutator };
      next.updatedAt = this.now();
      if (TERMINAL_STATUSES.has(next.status) && !next.completedAt) {
        next.completedAt = next.updatedAt;
      }
      store.jobs[index] = next;
      await this.save(userId, store);
      return next;
    });
  }

  async cancel(userId, jobId, reason = "Cancelled by user") {
    return this.update(userId, jobId, (job, nowIso) => {
      if (TERMINAL_STATUSES.has(job.status)) {
        throw Object.assign(new Error(`Cannot cancel a job that is already ${job.status}.`), { status: 409 });
      }
      return {
        ...job,
        status: "cancelled",
        error: cleanString(reason, 200),
        checkpoints: [
          ...job.checkpoints.slice(-24),
          { at: nowIso, step: job.stepsCompleted, status: "cancelled", summary: cleanString(reason, 200) }
        ]
      };
    });
  }
}

export class AsyncJobEngine {
  constructor({ jobStore, vramMonitor = null, auditStore = null } = {}) {
    this.jobStore = jobStore;
    this.vramMonitor = vramMonitor;
    this.auditStore = auditStore;
    this.activeControllers = new Map();
    this.handlers = new Map();
    this.pending = [];
    this.activeJobs = new Set();
    this.maxConcurrency = 1;
    this.pumping = false;
  }

  registerHandler(kind, handler) {
    const key = cleanString(kind, 48).toLowerCase();
    if (!key || typeof handler !== "function") throw new TypeError("A task kind and handler are required.");
    if (this.handlers.has(key)) throw new Error(`A handler is already registered for task kind "${key}".`);
    this.handlers.set(key, handler);
  }

  enqueue(userId, job) {
    const key = safeUserKey(userId) + ":" + job.id;
    if (this.activeJobs.has(key)) return job;
    const handler = this.handlers.get(job.kind);
    if (!handler) throw Object.assign(new Error(`No background handler is registered for job kind "${job.kind}".`), { status: 400, code: "UNSUPPORTED_JOB_KIND" });
    if (job.status !== "queued") throw Object.assign(new Error("Only queued jobs can be submitted to the worker."), { status: 409, code: "JOB_NOT_QUEUED" });
    this.activeJobs.add(key);
    this.pending.push({ userId, job, key, handler });
    this.pump();
    return job;
  }

  pump() {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(async () => {
      try {
        while (this.pending.length && this.activeControllers.size < this.maxConcurrency) {
          const item = this.pending.shift();
          try {
            const latest = await this.jobStore.get(item.userId, item.job.id);
            if (latest.status !== "queued") continue;
            const steps = await item.handler({ userId: item.userId, job: latest });
            if (!Array.isArray(steps)) throw new Error("Background task handler did not return a step list.");
            await this.execute(item.userId, latest, steps);
          } catch (error) {
            try {
              await this.jobStore.update(item.userId, item.job.id, (current, nowIso) => {
                if (TERMINAL_STATUSES.has(current.status)) return current;
                return { ...current, status: "failed", error: cleanString(error?.message || "Background task failed.", 240), checkpoints: [...current.checkpoints.slice(-24), { at: nowIso, step: current.stepsCompleted, status: "failed", summary: cleanString(error?.message || "Background task failed.", 240) }] };
              });
            } catch {}
          } finally {
            this.activeJobs.delete(item.key);
          }
        }
      } finally {
        this.pumping = false;
        if (this.pending.length && this.activeControllers.size < this.maxConcurrency) this.pump();
      }
    });
  }

  async reportProgress(userId, jobId, progress, summary = "Working") {
    const safeProgress = Math.max(0, Math.min(99, Math.floor(Number(progress) || 0)));
    const safeSummary = cleanString(summary, 240) || "Working";
    return this.jobStore.update(userId, jobId, (job, nowIso) => {
      if (job.status !== "running") return job;
      return {
        ...job,
        progress: Math.max(job.progress || 0, safeProgress),
        checkpoints: [...job.checkpoints.slice(-24), { at: nowIso, step: job.stepsCompleted, status: "running", summary: safeSummary }]
      };
    });
  }

  async recoverUser(userId) {
    const jobs = await this.jobStore.list(userId, { status: "all", limit: 100 });
    for (const job of jobs) {
      const key = safeUserKey(userId) + ":" + job.id;
      const controllerKey = safeUserKey(userId) + ":" + job.id;
      if (job.status === "running" && !this.activeJobs.has(key) && !this.activeControllers.has(controllerKey)) {
        await this.jobStore.update(userId, job.id, (current, nowIso) => current.status !== "running" ? current : ({
          ...current, status: "interrupted", error: "Core restarted while this task was running. It was not replayed automatically because its last operation may not be safe to repeat.",
          checkpoints: [...current.checkpoints.slice(-24), { at: nowIso, step: current.stepsCompleted, status: "interrupted", summary: "Execution interrupted by Core restart; manual review required before retry." }]
        }));
      } else if (job.status === "queued" && this.handlers.has(job.kind)) {
        this.enqueue(userId, job);
      }
    }
  }

  /**
   * Executes a multi-step async workflow job with VRAM-aware pre-check,
   * checkpoint persistence, pause-for-approval support, and cancellation.
   */
  async execute(userId, job, steps = []) {
    const controller = new AbortController();
    const controllerKey = safeUserKey(userId) + ":" + job.id;
    this.activeControllers.set(controllerKey, controller);

    const startedMs = Date.now();
    const maxSteps = job.budget?.maxSteps || 6;
    const maxDurationMs = Math.min(MAX_JOB_DURATION_MS, Math.max(5000, Number(job.budget?.maxDurationMs) || DEFAULT_JOB_DURATION_MS));

    // VRAM-aware scheduling gate (ADR-004 #3)
    if (this.vramMonitor && typeof this.vramMonitor.inspect === "function") {
      try {
        const vram = await this.vramMonitor.inspect();
        if (vram?.warning && Number(vram?.usagePercent || 0) >= 92) {
          const paused = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
            if (cur.status === "cancelled") return cur;
            return {
            ...cur,
            status: "queued",
            checkpoints: [
              ...cur.checkpoints.slice(-24),
              { at: nowIso, step: cur.stepsCompleted, status: "queued", summary: `Deferred due to high GPU VRAM (${Math.round(vram.usagePercent)}%).` }
            ]
            };
          });
          this.activeControllers.delete(controllerKey);
          return paused;
        }
      } catch {}
    }

    let current = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
      if (cur.status === "cancelled") return cur;
      return {
      ...cur,
      status: "running",
      checkpoints: [
        ...cur.checkpoints.slice(-24),
        { at: nowIso, step: cur.stepsCompleted, status: "running", summary: "Started execution within configured budgets." }
      ]
      };
    });
    if (controller.signal.aborted || current.status === "cancelled") return current;

    const context = {
      lowestTrustTouched: "user_authored",
      tainted: false,
      findings: [],
      recommendations: [],
      metadata: {}
    };

    const TRUST_ORDER = { user_authored: 2, system_verified: 1, external_untrusted: 0 };
    const recordTrust = (tier) => {
      const clean = TRUST_ORDER[tier] !== undefined ? tier : "user_authored";
      if (TRUST_ORDER[clean] < TRUST_ORDER[context.lowestTrustTouched]) {
        context.lowestTrustTouched = clean;
      }
      if (clean === "external_untrusted") context.tainted = true;
    };

    try {
      const boundedSteps = steps.slice(0, maxSteps);
      for (let i = 0; i < boundedSteps.length; i += 1) {
        if (controller.signal.aborted) {
          current = await this.jobStore.get(userId, job.id);
          return current;
        }
        if (Date.now() - startedMs > maxDurationMs) {
          throw Object.assign(new Error("Job exceeded its configured wall-clock budget."), { code: "JOB_TIMEOUT" });
        }

        const stepDef = boundedSteps[i];
        const stepResult = await stepDef.run({
          userId,
          job: current,
          context,
          recordTrust,
          signal: controller.signal
        });

        // A step may finish after cancellation even if it does not honour AbortSignal.
        // Never let its late result overwrite the persisted cancelled state.
        if (controller.signal.aborted) {
          current = await this.jobStore.get(userId, job.id);
          return current;
        }

        if (stepResult?.awaitingApproval) {
          current = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
            if (cur.status === "cancelled") return cur;
            return {
            ...cur,
            status: "awaiting_approval",
            pendingActionId: stepResult.pendingActionId || null,
            artifact: stepResult.artifact || cur.artifact,
            stepsCompleted: i + 1,
            progress: Math.round(((i + 1) / Math.max(1, boundedSteps.length)) * 100),
            lowestTrustTouched: context.lowestTrustTouched,
            tainted: context.tainted,
            checkpoints: [
              ...cur.checkpoints.slice(-24),
              {
                at: nowIso,
                step: i + 1,
                status: "awaiting_approval",
                summary: cleanString(stepResult.summary || "Paused awaiting user approval.", 240)
              }
            ]
            };
          });
          if (controller.signal.aborted || current.status === "cancelled") return current;
          if (this.auditStore) {
            await this.auditStore.record(userId, {
              event: "job.awaiting_approval",
              actor: "alfie",
              actionId: stepResult.pendingActionId || "",
              risk: "write",
              status: "awaiting_approval",
              detail: `Job "${current.title}" paused for explicit user approval.`
            });
          }
          return current;
        }

        current = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
          if (cur.status === "cancelled") return cur;
          return {
          ...cur,
          stepsCompleted: i + 1,
          progress: Math.round(((i + 1) / Math.max(1, boundedSteps.length)) * 100),
          lowestTrustTouched: context.lowestTrustTouched,
          tainted: context.tainted,
          checkpoints: [
            ...cur.checkpoints.slice(-24),
            {
              at: nowIso,
              step: i + 1,
              status: "running",
              summary: cleanString(stepResult?.summary || stepDef.name || `Completed step ${i + 1}`, 240)
            }
          ]
          };
        });
        if (controller.signal.aborted || current.status === "cancelled") return current;
      }

      if (controller.signal.aborted) {
        current = await this.jobStore.get(userId, job.id);
        return current;
      }

      const artifact = {
        summary: cleanString(context.summary || `Completed "${current.title}" across ${current.stepsCompleted} bounded steps.`, 600),
        findings: context.findings.slice(0, 20),
        recommendations: context.recommendations.slice(0, 12),
        lowestTrustTouched: context.lowestTrustTouched,
        tainted: context.tainted,
        metadata: context.metadata
      };

      current = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
        if (cur.status === "cancelled") return cur;
        return {
        ...cur,
        status: "completed",
        progress: 100,
        lowestTrustTouched: context.lowestTrustTouched,
        tainted: context.tainted,
        artifact,
        checkpoints: [
          ...cur.checkpoints.slice(-24),
          { at: nowIso, step: cur.stepsCompleted, status: "completed", summary: "Job finished and returned structured artifact for Alfie review." }
        ]
        };
      });
      if (current.status !== "completed") return current;

      if (this.auditStore) {
        await this.auditStore.record(userId, {
          event: "job.completed",
          actor: current.role ? `subagent:${current.role}` : "alfie",
          risk: "low",
          status: "completed",
          detail: `Completed "${current.title}" (trust=${context.lowestTrustTouched}, tainted=${context.tainted}).`
        });
      }
      return current;
    } catch (error) {
      if (controller.signal.aborted) {
        current = await this.jobStore.get(userId, job.id);
        return current;
      }
      current = await this.jobStore.update(userId, job.id, (cur, nowIso) => {
        if (cur.status === "cancelled" || TERMINAL_STATUSES.has(cur.status)) return cur;
        return {
        ...cur,
        status: "failed",
        error: cleanString(error?.message || "Job execution failed.", 240),
        lowestTrustTouched: context.lowestTrustTouched,
        tainted: context.tainted,
        checkpoints: [
          ...cur.checkpoints.slice(-24),
          { at: nowIso, step: cur.stepsCompleted, status: "failed", summary: cleanString(error?.message || "Job execution failed.", 240) }
        ]
        };
      });
      return current;
    } finally {
      this.activeControllers.delete(controllerKey);
    }
  }

  async cancel(userId, jobId, reason = "Cancelled by user") {
    // Confirm ownership before touching an in-memory controller; otherwise a caller
    // with another user's job ID could abort that user's running work.
    await this.jobStore.get(userId, jobId);
    const controllerKey = safeUserKey(userId) + ":" + jobId;
    const controller = this.activeControllers.get(controllerKey);
    if (controller) controller.abort();
    const cancelled = await this.jobStore.cancel(userId, jobId, reason);
    if (this.auditStore) {
      await this.auditStore.record(userId, {
        event: "job.cancelled",
        actor: "user",
        risk: "low",
        status: "cancelled",
        detail: `Cancelled job "${cancelled.title}".`
      });
    }
    return cancelled;
  }
}
