import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

export const PROJECT_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_PROJECTS = 100;
const ALLOWED_COLORS = new Set(["purple", "blue", "cyan", "emerald", "amber", "rose"]);
export const PROJECT_STATUSES = Object.freeze(["active", "planning", "paused", "completed", "archived"]);
const ALLOWED_STATUSES = new Set(PROJECT_STATUSES);
const MAX_LIST_ITEMS = 20;
const MAX_DECISIONS = 20;

function cleanName(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("A project name is required."), { status: 400, code: "PROJECT_NAME_INVALID" });
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > 80) {
    throw Object.assign(new Error("Project names must contain between 1 and 80 characters."), { status: 400, code: "PROJECT_NAME_INVALID" });
  }
  return trimmed;
}

function cleanTextField(value, maxLen, fieldLabel) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${fieldLabel} must be text.`), { status: 400, code: "PROJECT_DESCRIPTION_INVALID" });
  }
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLen);
}

function cleanDescription(value) {
  return cleanTextField(value, 600, "Project description");
}

function cleanColor(value) {
  const normalized = String(value || "purple").trim().toLowerCase();
  return ALLOWED_COLORS.has(normalized) ? normalized : "purple";
}

function cleanStatus(value, fallback = "active") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ALLOWED_STATUSES.has(normalized) ? normalized : fallback;
}

function cleanStringList(value, maxItemLen = 240) {
  if (value === undefined || value === null) return [];
  const rawList = typeof value === "string"
    ? value.split(/\r?\n/)
    : (Array.isArray(value) ? value : []);
  const seen = new Set();
  const result = [];
  for (const entry of rawList) {
    const cleaned = String(entry || "").replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim().slice(0, maxItemLen);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    result.push(cleaned);
    if (result.length >= MAX_LIST_ITEMS) break;
  }
  return result;
}

function cleanDecisions(value, fallbackNow) {
  if (value === undefined || value === null) return [];
  const rawList = typeof value === "string"
    ? value.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const parts = line.split(/\s+[—–-]{1,2}\s+|\s*\|\s*/);
        return { summary: parts[0] || "", rationale: parts.slice(1).join(" — ") };
      })
    : (Array.isArray(value) ? value : []);
  const result = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const summary = String(item.summary || item.decision || "").replace(/\s+/g, " ").trim().slice(0, 220);
    if (!summary) continue;
    const rationale = String(item.rationale || "").replace(/\s+/g, " ").trim().slice(0, 400);
    result.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : randomUUID(),
      summary,
      rationale,
      createdAt: String(item.createdAt || fallbackNow).slice(0, 40)
    });
    if (result.length >= MAX_DECISIONS) break;
  }
  return result;
}

function normaliseProject(project, fallbackNow) {
  return {
    id: String(project.id),
    name: String(project.name || "Untitled project").slice(0, 80),
    description: cleanDescription(project.description || ""),
    color: cleanColor(project.color),
    status: cleanStatus(project.status, "active"),
    vision: cleanTextField(project.vision || "", 600, "Project vision"),
    architecture: cleanTextField(project.architecture || "", 1200, "Project architecture"),
    decisions: cleanDecisions(project.decisions, project.createdAt || fallbackNow),
    blockers: cleanStringList(project.blockers, 240),
    nextActions: cleanStringList(project.nextActions, 240),
    postponed: cleanStringList(project.postponed, 240),
    createdAt: String(project.createdAt || fallbackNow),
    updatedAt: String(project.updatedAt || project.createdAt || fallbackNow)
  };
}

export function formatProjectDossier(project, { maxChars = 1800 } = {}) {
  if (!project || typeof project !== "object") return "";
  const lines = [`Project: ${project.name} (status: ${project.status || "active"})`];
  if (project.vision) lines.push(`Vision: ${project.vision}`);
  if (project.description) lines.push(`Notes: ${project.description}`);
  if (project.architecture) lines.push(`Architecture: ${project.architecture}`);
  if (Array.isArray(project.nextActions) && project.nextActions.length) {
    lines.push(`Next actions: ${project.nextActions.slice(0, 6).map((item) => `- ${item}`).join(" ")}`);
  }
  if (Array.isArray(project.blockers) && project.blockers.length) {
    lines.push(`Blockers: ${project.blockers.slice(0, 6).map((item) => `- ${item}`).join(" ")}`);
  }
  if (Array.isArray(project.decisions) && project.decisions.length) {
    const decisionText = project.decisions.slice(-5).map((d) =>
      d.rationale ? `${d.summary} (${d.rationale})` : d.summary
    ).join("; ");
    lines.push(`Key decisions: ${decisionText}`);
  }
  if (Array.isArray(project.postponed) && project.postponed.length) {
    lines.push(`Postponed: ${project.postponed.slice(0, 4).join("; ")}`);
  }
  const combined = lines.join("\n");
  return combined.length > maxChars ? combined.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…" : combined;
}

export class ProjectStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "projects.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "projects.json");
    if (!store) return { schemaVersion: 1, revision: 0, ownerId: userId, projects: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.projects)) {
      throw new Error("Project store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    store.revision = Math.max(0, Number(store.revision) || 0) + 1;
    await writeUserJsonDocument(this.dataDirectory, userId, "projects.json", store, { uuid: this.uuid });
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const fallbackNow = this.now();
      return store.projects
        .map((item) => normaliseProject(item, fallbackNow))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    });
  }

  async get(userId, projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const project = store.projects.find((item) => item.id === projectId);
      if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });
      return normaliseProject(project, this.now());
    });
  }

  async create(userId, input = {}) {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const color = cleanColor(input.color);
    const status = cleanStatus(input.status, "active");
    const vision = cleanTextField(input.vision, 600, "Project vision");
    const architecture = cleanTextField(input.architecture, 1200, "Project architecture");
    const blockers = cleanStringList(input.blockers, 240);
    const nextActions = cleanStringList(input.nextActions, 240);
    const postponed = cleanStringList(input.postponed, 240);

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.projects.length >= MAX_PROJECTS) {
        throw Object.assign(new Error("This account has reached its project limit."), { status: 409 });
      }
      const duplicate = store.projects.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (duplicate) {
        throw Object.assign(new Error("A project with that name already exists."), { status: 409, code: "PROJECT_NAME_DUPLICATE" });
      }
      const now = this.now();
      const decisions = cleanDecisions(input.decisions, now);
      const project = {
        id: this.uuid(),
        name,
        description,
        color,
        status,
        vision,
        architecture,
        decisions,
        blockers,
        nextActions,
        postponed,
        createdAt: now,
        updatedAt: now
      };
      store.projects.push(project);
      await this.save(userId, store);
      return project;
    });
  }

  async update(userId, projectId, input = {}) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    const now = this.now();
    const patch = {};
    if (input.name !== undefined) patch.name = cleanName(input.name);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.color !== undefined) patch.color = cleanColor(input.color);
    if (input.status !== undefined) patch.status = cleanStatus(input.status, "active");
    if (input.vision !== undefined) patch.vision = cleanTextField(input.vision, 600, "Project vision");
    if (input.architecture !== undefined) patch.architecture = cleanTextField(input.architecture, 1200, "Project architecture");
    if (input.decisions !== undefined) patch.decisions = cleanDecisions(input.decisions, now);
    if (input.blockers !== undefined) patch.blockers = cleanStringList(input.blockers, 240);
    if (input.nextActions !== undefined) patch.nextActions = cleanStringList(input.nextActions, 240);
    if (input.postponed !== undefined) patch.postponed = cleanStringList(input.postponed, 240);

    if (!Object.keys(patch).length) {
      throw Object.assign(new Error("Provide at least one project field to update."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index < 0) throw Object.assign(new Error("Project not found."), { status: 404 });
      const current = normaliseProject(store.projects[index], now);
      if (patch.name) {
        const duplicate = store.projects.find((item) => item.id !== projectId && item.name.toLowerCase() === patch.name.toLowerCase());
        if (duplicate) {
          throw Object.assign(new Error("A project with that name already exists."), { status: 409, code: "PROJECT_NAME_DUPLICATE" });
        }
      }
      const updated = { ...current, ...patch, updatedAt: this.now() };
      store.projects[index] = updated;
      await this.save(userId, store);
      return updated;
    });
  }

  async remove(userId, projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index < 0) throw Object.assign(new Error("Project not found."), { status: 404 });
      const [removed] = store.projects.splice(index, 1);
      await this.save(userId, store);
      return { deleted: true, project: normaliseProject(removed, this.now()) };
    });
  }
}
