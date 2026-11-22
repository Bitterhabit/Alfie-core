import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";
import {
  WATCHER_KINDS,
  ATTENTION_TIERS,
  METRIC_OPERATORS,
  DEFAULT_QUIET_HOURS_TIMEZONE,
  validateWatcherUrl,
  validateTimeZone,
  routeAttentionTier,
  evaluateWatcher,
  evaluatePushMetricReading,
  sanitiseSummary
} from "./engine.mjs";

const UUID_PATTERN = /^[a-f0-9-]{36}$/i;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WATCHERS = 64;
const MAX_EVENTS = 200;

function cleanBoolean(value, fieldName = "enabled") {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${fieldName} must be a strict boolean (true or false).`), { status: 400 });
  }
  return value;
}

function cleanName(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!cleaned) throw Object.assign(new Error("Watcher name is required."), { status: 400 });
  return cleaned;
}

function cleanKind(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!WATCHER_KINDS.includes(candidate)) {
    throw Object.assign(new Error(`Watcher kind must be one of: ${WATCHER_KINDS.join(", ")}.`), { status: 400 });
  }
  return candidate;
}

function cleanTier(value, fallback = "notify") {
  const candidate = String(value || fallback).trim().toLowerCase();
  if (!ATTENTION_TIERS.includes(candidate)) {
    throw Object.assign(new Error(`Attention tier must be one of: ${ATTENTION_TIERS.join(", ")}.`), { status: 400 });
  }
  return candidate;
}

function cleanCooldown(value, fallback = 30) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1440) {
    throw Object.assign(new Error("Cooldown minutes must be between 0 and 1,440."), { status: 400 });
  }
  return Math.round(num);
}

function cleanClockValue(value, fallback, fieldName) {
  if (value === undefined) return fallback;
  const candidate = String(value ?? "").trim();
  if (!CLOCK_PATTERN.test(candidate)) {
    throw Object.assign(new Error(`${fieldName} must use 24-hour HH:MM format (00:00–23:59).`), { status: 400 });
  }
  return candidate;
}

function cleanQuietHours(input, existing = null) {
  const base = existing && typeof existing === "object"
    ? {
        enabled: typeof existing.enabled === "boolean" ? existing.enabled : false,
        start: CLOCK_PATTERN.test(String(existing.start || "")) ? String(existing.start) : "22:00",
        end: CLOCK_PATTERN.test(String(existing.end || "")) ? String(existing.end) : "07:00",
        timezone: validateTimeZone(existing.timezone).valid ? existing.timezone : DEFAULT_QUIET_HOURS_TIMEZONE
      }
    : {
        enabled: false,
        start: "22:00",
        end: "07:00",
        timezone: DEFAULT_QUIET_HOURS_TIMEZONE
      };

  if (input === undefined) return base;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("quietHours must be an object."), { status: 400 });
  }

  const enabled = input.enabled !== undefined
    ? cleanBoolean(input.enabled, "quietHours.enabled")
    : base.enabled;
  const start = cleanClockValue(input.start, base.start, "quietHours.start");
  const end = cleanClockValue(input.end, base.end, "quietHours.end");

  let timezone = base.timezone;
  if (input.timezone !== undefined) {
    const check = validateTimeZone(input.timezone);
    if (!check.valid) {
      throw Object.assign(new Error(check.error), { status: 400, code: "INVALID_TIMEZONE" });
    }
    timezone = check.timeZone;
  }

  return { enabled, start, end, timezone };
}

function normaliseStoredWatcher(watcher) {
  if (!watcher || typeof watcher !== "object") return watcher;
  const qh = watcher.quietHours && typeof watcher.quietHours === "object" ? watcher.quietHours : {};
  const tzCheck = validateTimeZone(qh.timezone);
  return {
    ...watcher,
    quietHours: {
      enabled: Boolean(qh.enabled),
      start: CLOCK_PATTERN.test(String(qh.start || "")) ? String(qh.start) : "22:00",
      end: CLOCK_PATTERN.test(String(qh.end || "")) ? String(qh.end) : "07:00",
      timezone: tzCheck.valid ? tzCheck.timeZone : DEFAULT_QUIET_HOURS_TIMEZONE
    }
  };
}

function cleanConfig(kind, raw = {}) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (kind === "http_probe") {
    const check = validateWatcherUrl(input.url);
    if (!check.valid) throw Object.assign(new Error(check.error), { status: 400, code: "WATCHER_URL_BLOCKED" });
    const expectedStatus = Math.max(100, Math.min(599, Number(input.expectedStatus) || 200));
    const maxLatencyMs = Math.max(100, Math.min(10000, Number(input.maxLatencyMs) || 3000));
    return { url: check.url, expectedStatus, maxLatencyMs };
  }
  if (kind === "project_stall") {
    const staleDays = Math.max(1, Math.min(90, Math.round(Number(input.staleDays) || 7)));
    const projectId = input.projectId ? String(input.projectId).trim() : null;
    if (projectId && !UUID_PATTERN.test(projectId)) {
      throw Object.assign(new Error("Invalid projectId for project_stall watcher."), { status: 400 });
    }
    return { staleDays, projectId };
  }
  if (kind === "vram_threshold") {
    const thresholdPercent = Math.max(50, Math.min(99, Math.round(Number(input.thresholdPercent) || 80)));
    return { thresholdPercent };
  }
  if (kind === "push_metric") {
    const metricName = sanitiseSummary(input.metricName || "metric", 64);
    const operator = METRIC_OPERATORS.includes(String(input.operator || "").toLowerCase())
      ? String(input.operator).toLowerCase()
      : "gte";
    const threshold = Number(input.threshold);
    if (!Number.isFinite(threshold)) {
      throw Object.assign(new Error("Push metric watcher requires a numeric threshold."), { status: 400 });
    }
    const unit = sanitiseSummary(input.unit || "", 16);
    return { metricName, operator, threshold, unit };
  }
  return {};
}

export class WatcherStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => Date.now(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
    this.checkLocks = new Map();
  }

  watchersFile(userId) {
    return userDataFile(this.dataDirectory, userId, "watchers.json");
  }

  eventsFile(userId) {
    return userDataFile(this.dataDirectory, userId, "watcher-events.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async withWatcherCheckLock(userId, watcherId, operation) {
    const key = `${safeUserKey(userId)}:${watcherId}`;
    const previous = this.checkLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.checkLocks.set(key, gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.checkLocks.get(key) === gate) this.checkLocks.delete(key);
    }
  }

  async loadWatchers(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "watchers.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, watchers: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.watchers)) {
      throw new Error("Watcher store failed its integrity check.");
    }
    store.watchers = store.watchers.map(normaliseStoredWatcher);
    return store;
  }

  async saveWatchers(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "watchers.json", store, { uuid: this.uuid });
  }

  async loadEvents(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "watcher-events.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, events: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.events)) {
      throw new Error("Watcher event store failed its integrity check.");
    }
    return store;
  }

  async saveEvents(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "watcher-events.json", store, { uuid: this.uuid });
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      return store.watchers.slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    });
  }

  async get(userId, watcherId) {
    if (!UUID_PATTERN.test(String(watcherId || ""))) {
      throw Object.assign(new Error("Watcher not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      const found = store.watchers.find((item) => item.id === watcherId);
      if (!found) throw Object.assign(new Error("Watcher not found."), { status: 404 });
      return found;
    });
  }

  async create(userId, input = {}) {
    const name = cleanName(input.name);
    const kind = cleanKind(input.kind);
    const tier = cleanTier(input.tier, "notify");
    const cooldownMinutes = cleanCooldown(input.cooldownMinutes, 30);
    const quietHours = cleanQuietHours(input.quietHours);
    const config = cleanConfig(kind, input.config);
    const enabled = input.enabled !== undefined ? cleanBoolean(input.enabled, "enabled") : true;

    return this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      if (store.watchers.length >= MAX_WATCHERS) {
        throw Object.assign(new Error("This account has reached the maximum number of watchers (64)."), { status: 409 });
      }
      const nowIso = new Date(this.now()).toISOString();
      const watcher = {
        id: this.uuid(),
        name,
        kind,
        enabled,
        tier,
        cooldownMinutes,
        quietHours,
        config,
        lastCheckedAt: null,
        lastStatus: "pending",
        lastSummary: "",
        lastTrust: kind === "http_probe" || kind === "push_metric" ? "external_untrusted" : "system_verified",
        lastFingerprint: null,
        lastNotifiedAt: null,
        lastMetrics: null,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      store.watchers.push(watcher);
      await this.saveWatchers(userId, store);
      return watcher;
    });
  }

  async update(userId, watcherId, input = {}) {
    if (!UUID_PATTERN.test(String(watcherId || ""))) {
      throw Object.assign(new Error("Watcher not found."), { status: 404 });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("Watcher update payload must be an object."), { status: 400 });
    }
    return this.withWatcherCheckLock(userId, watcherId, async () => this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      const index = store.watchers.findIndex((item) => item.id === watcherId);
      if (index < 0) throw Object.assign(new Error("Watcher not found."), { status: 404 });
      const current = store.watchers[index];
      const next = {
        ...current,
        ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
        ...(input.enabled !== undefined ? { enabled: cleanBoolean(input.enabled, "enabled") } : {}),
        ...(input.tier !== undefined ? { tier: cleanTier(input.tier, current.tier) } : {}),
        ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: cleanCooldown(input.cooldownMinutes, current.cooldownMinutes) } : {}),
        ...(input.quietHours !== undefined ? { quietHours: cleanQuietHours(input.quietHours, current.quietHours) } : {}),
        ...(input.config !== undefined ? { config: cleanConfig(current.kind, { ...current.config, ...input.config }) } : {}),
        updatedAt: new Date(this.now()).toISOString()
      };
      store.watchers[index] = next;
      await this.saveWatchers(userId, store);
      return next;
    }));
  }

  async remove(userId, watcherId) {
    if (!UUID_PATTERN.test(String(watcherId || ""))) {
      throw Object.assign(new Error("Watcher not found."), { status: 404 });
    }
    return this.withWatcherCheckLock(userId, watcherId, async () => this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      const before = store.watchers.length;
      store.watchers = store.watchers.filter((item) => item.id !== watcherId);
      if (store.watchers.length === before) {
        throw Object.assign(new Error("Watcher not found."), { status: 404 });
      }
      await this.saveWatchers(userId, store);
      return { deleted: true, id: watcherId };
    }));
  }

  async recordEvaluation(userId, watcherId, evaluation) {
    return this.exclusive(userId, async () => {
      const store = await this.loadWatchers(userId);
      const index = store.watchers.findIndex((item) => item.id === watcherId);
      if (index < 0) throw Object.assign(new Error("Watcher not found."), { status: 404 });
      const watcher = store.watchers[index];
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();

      const sameFingerprint = Boolean(evaluation.fingerprint && watcher.lastFingerprint === evaluation.fingerprint);
      const routing = routeAttentionTier({
        baseTier: watcher.tier,
        severity: evaluation.severity,
        quietHours: watcher.quietHours,
        nowMs,
        lastNotifiedAt: watcher.lastNotifiedAt,
        cooldownMinutes: watcher.cooldownMinutes,
        sameFingerprint
      });

      const event = {
        id: this.uuid(),
        watcherId: watcher.id,
        watcherName: watcher.name,
        kind: watcher.kind,
        severity: evaluation.severity,
        tier: routing.tier,
        configuredTier: watcher.tier,
        suppressed: routing.suppressed,
        routingReason: routing.reason,
        trust: evaluation.trust === "system_verified" ? "system_verified" : "external_untrusted",
        summary: sanitiseSummary(evaluation.summary),
        metrics: evaluation.metrics || {},
        acknowledged: routing.tier === "quiet_log",
        createdAt: nowIso
      };

      const nextWatcher = {
        ...watcher,
        lastCheckedAt: nowIso,
        lastStatus: evaluation.severity,
        lastSummary: event.summary,
        lastTrust: event.trust,
        lastFingerprint: evaluation.fingerprint || null,
        lastNotifiedAt: (evaluation.severity === "alert" && !routing.suppressed) ? nowIso : watcher.lastNotifiedAt,
        lastMetrics: evaluation.metrics || null,
        updatedAt: nowIso
      };
      store.watchers[index] = nextWatcher;
      await this.saveWatchers(userId, store);

      const eventStore = await this.loadEvents(userId);
      eventStore.events.unshift(event);
      if (eventStore.events.length > MAX_EVENTS) {
        eventStore.events = eventStore.events.slice(0, MAX_EVENTS);
      }
      await this.saveEvents(userId, eventStore);

      return { watcher: nextWatcher, event };
    });
  }

  async runCheck(userId, watcherId, dependencies = {}) {
    return this.withWatcherCheckLock(userId, watcherId, async () => {
      const watcher = await this.get(userId, watcherId);
      const evaluation = await evaluateWatcher(watcher, {
        userId,
        projectStore: dependencies.projectStore || null,
        vramMonitor: dependencies.vramMonitor || null,
        endpoints: dependencies.endpoints || [],
        ...(dependencies.dnsLookup ? { dnsLookup: dependencies.dnsLookup } : {}),
        ...(dependencies.requestImpl ? { requestImpl: dependencies.requestImpl } : {}),
        ...(dependencies.tlsOptions ? { tlsOptions: dependencies.tlsOptions } : {}),
        now: this.now
      });
      return this.recordEvaluation(userId, watcherId, evaluation);
    });
  }

  async ingestMetric(userId, watcherId, reading = {}) {
    return this.withWatcherCheckLock(userId, watcherId, async () => {
      const watcher = await this.get(userId, watcherId);
      if (watcher.kind !== "push_metric") {
        throw Object.assign(new Error("Only push_metric watchers accept pushed metric readings."), { status: 400 });
      }
      const evaluation = evaluatePushMetricReading(watcher, reading);
      return this.recordEvaluation(userId, watcherId, evaluation);
    });
  }

  async listEvents(userId, { tier = "", unacknowledged = false, limit = 50 } = {}) {
    const tierFilter = String(tier || "").trim().toLowerCase();
    const onlyUnack = unacknowledged === true || unacknowledged === "true" || unacknowledged === "1";
    const maxItems = Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 50));
    return this.exclusive(userId, async () => {
      const store = await this.loadEvents(userId);
      return store.events
        .filter((event) => {
          if (tierFilter && tierFilter !== "all" && event.tier !== tierFilter) return false;
          if (onlyUnack && event.acknowledged) return false;
          return true;
        })
        .slice(0, maxItems);
    });
  }

  async acknowledgeEvent(userId, eventId) {
    if (!UUID_PATTERN.test(String(eventId || ""))) {
      throw Object.assign(new Error("Watcher event not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.loadEvents(userId);
      const event = store.events.find((item) => item.id === eventId);
      if (!event) throw Object.assign(new Error("Watcher event not found."), { status: 404 });
      event.acknowledged = true;
      event.acknowledgedAt = new Date(this.now()).toISOString();
      await this.saveEvents(userId, store);
      return event;
    });
  }
}
