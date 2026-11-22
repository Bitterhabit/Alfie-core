import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeUserKey, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

const MAX_SNAPSHOTS = 60;

/**
 * Pure deterministic Life Continuity & Periodic Reflection generator (Phase 5).
 * Runs 100% locally over user-owned Core data with zero cloud calls.
 */
export function buildContinuityReflection(
  { projects = [], memories = [], ideas = [], watchers = [], watcherEvents = [], profile = null } = {},
  { period = "weekly", now = new Date() } = {}
) {
  const cleanPeriod = String(period || "weekly").toLowerCase() === "monthly" ? "monthly" : "weekly";
  const windowDays = cleanPeriod === "monthly" ? 30 : 7;
  const nowDate = now instanceof Date ? now : new Date(now);
  const cutoffMs = nowDate.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const isRecent = (iso) => {
    const parsed = Date.parse(String(iso || ""));
    return Number.isFinite(parsed) && parsed >= cutoffMs;
  };

  const activeProjects = projects.filter((p) => !["archived", "completed"].includes(p.status));
  const recentProjects = projects.filter((p) => isRecent(p.updatedAt || p.createdAt));
  const allDecisions = [];
  const openBlockers = [];
  const nextActions = [];

  for (const project of activeProjects) {
    if (Array.isArray(project.decisions)) {
      for (const dec of project.decisions.slice(-4)) {
        const text = typeof dec === "string" ? dec : dec?.text || dec?.summary || "";
        if (text) allDecisions.push({ projectId: project.id, projectName: project.name, text });
      }
    }
    if (Array.isArray(project.blockers)) {
      for (const blocker of project.blockers) {
        if (blocker) openBlockers.push({ projectId: project.id, projectName: project.name, text: String(blocker) });
      }
    }
    if (Array.isArray(project.nextActions) && project.nextActions[0]) {
      nextActions.push({ projectId: project.id, projectName: project.name, action: String(project.nextActions[0]) });
    }
  }

  const activeMemories = memories.filter((m) => !m.archived);
  const recentMemories = activeMemories.filter((m) => isRecent(m.updatedAt || m.createdAt));
  const lessonsLearned = activeMemories
    .filter((m) => (m.kind || m.type) === "lesson")
    .slice(0, 6)
    .map((m) => ({ id: m.id, title: m.title || m.text.slice(0, 90), updatedAt: m.updatedAt || m.createdAt }));

  const openIdeas = ideas.filter((i) => !["archived", "promoted"].includes(i.status));
  const recentIdeas = ideas.filter((i) => isRecent(i.updatedAt || i.createdAt));
  const highPriorityIdeas = openIdeas
    .filter((i) => i.priority === "high")
    .slice(0, 5)
    .map((i) => ({ id: i.id, title: i.title, status: i.status, tags: i.tags || [] }));

  const learningTopics = Array.isArray(profile?.learningTopics)
    ? profile.learningTopics.slice(0, 10).map((t) => ({
        topic: t.topic,
        confidence: t.confidence || "exploring"
      }))
    : [];

  const recentAlerts = watcherEvents
    .filter((e) => isRecent(e.at || e.createdAt))
    .slice(0, 8)
    .map((e) => ({
      id: e.id,
      tier: e.tier || "digest",
      title: e.title || e.watcherName || "Watcher finding",
      at: e.at || e.createdAt
    }));

  const highlights = [];
  highlights.push(
    `${activeProjects.length} active project${activeProjects.length === 1 ? "" : "s"} (${recentProjects.length} updated in the last ${windowDays} days).`
  );
  if (recentMemories.length) {
    highlights.push(`${recentMemories.length} new or refined memor${recentMemories.length === 1 ? "y" : "ies"} planted in The Garden.`);
  }
  if (recentIdeas.length) {
    highlights.push(`${recentIdeas.length} idea${recentIdeas.length === 1 ? "" : "s"} captured in the Ideas Vault (${openIdeas.length} open overall).`);
  }
  if (openBlockers.length) {
    highlights.push(`${openBlockers.length} open blocker${openBlockers.length === 1 ? "" : "s"} across active dossiers need attention.`);
  }
  if (learningTopics.length) {
    highlights.push(`Tracking ${learningTopics.length} learning topic${learningTopics.length === 1 ? "" : "s"} in your Workflow Profile.`);
  }

  return {
    id: randomUUID(),
    period: cleanPeriod,
    windowDays,
    generatedAt: nowDate.toISOString(),
    localOnly: true,
    metrics: {
      activeProjects: activeProjects.length,
      recentProjectUpdates: recentProjects.length,
      totalMemories: activeMemories.length,
      recentMemories: recentMemories.length,
      openIdeas: openIdeas.length,
      recentIdeas: recentIdeas.length,
      openBlockers: openBlockers.length,
      learningTopics: learningTopics.length,
      activeWatchers: watchers.filter((w) => w.enabled).length,
      recentAlerts: recentAlerts.length
    },
    highlights,
    nextActions: nextActions.slice(0, 6),
    openBlockers: openBlockers.slice(0, 6),
    recentDecisions: allDecisions.slice(0, 6),
    lessonsLearned,
    highPriorityIdeas,
    learningTopics,
    recentAlerts
  };
}

export class ReflectionStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.mutex = new UserMutex();
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "reflections.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, snapshots: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.snapshots)) {
      throw new Error("Reflections store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "reflections.json", store);
  }

  async list(userId, { limit = 20 } = {}) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const safeLimit = Math.max(1, Math.min(60, Math.floor(Number(limit) || 20)));
      return store.snapshots.slice(0, safeLimit);
    });
  }

  async saveSnapshot(userId, reflection) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const saved = {
        ...reflection,
        savedAt: this.now()
      };
      store.snapshots = [saved, ...store.snapshots].slice(0, MAX_SNAPSHOTS);
      await this.save(userId, store);
      return saved;
    });
  }
}
