import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

const TOPIC_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_TOPICS = 40;

export const EXPLANATION_STYLES = Object.freeze([
  { id: "concise", label: "Concise", promptHint: "Lead with the direct answer and keep explanations compact unless asked to expand." },
  { id: "balanced", label: "Balanced", promptHint: "Give clear structured reasoning with practical examples without overwhelming detail." },
  { id: "deep", label: "Deep dive", promptHint: "Explain underlying mechanisms, edge cases, and trade-offs thoroughly." }
]);

export const CHANGE_PRESENTATIONS = Object.freeze([
  { id: "diffs_and_rollback", label: "Diffs & rollback", promptHint: "Present technical changes as concrete diffs with explicit verification and rollback steps." },
  { id: "step_by_step", label: "Step by step", promptHint: "Walk through technical changes sequentially with clear checkpoints." },
  { id: "high_level", label: "Outcome first", promptHint: "Lead with architectural intent and user-facing impact before file details." }
]);

export const INTERRUPTION_TOLERANCES = Object.freeze([
  { id: "quiet", label: "Quiet focus", promptHint: "Avoid interrupting flow; batch non-urgent observations for summaries." },
  { id: "balanced", label: "Balanced", promptHint: "Surface meaningful blockers or risks clearly while keeping minor observations unobtrusive." },
  { id: "proactive", label: "Proactive", promptHint: "Proactively flag potential pitfalls, adjacent ideas, and next steps." }
]);

export const CHUNK_SIZES = Object.freeze([
  { id: "small_steps", label: "Small steps", promptHint: "Propose bite-sized, independently verifiable increments." },
  { id: "balanced", label: "Balanced", promptHint: "Group related work into coherent vertical slices." },
  { id: "large_chunks", label: "Large chunks", promptHint: "Deliver complete end-to-end proposals and implementations in larger cohesive milestones." }
]);

export const LEARNING_MODES = Object.freeze([
  { id: "solve", label: "Solve it", short: "Direct solution", promptHint: "Provide the complete, practical solution directly." },
  { id: "explain", label: "Explain as you go", short: "Solve + explain", promptHint: "Solve the problem while briefly narrating why each key decision works." },
  { id: "tutor", label: "Tutor me", short: "Guided coaching", promptHint: "Break the concept into digestible steps, check intuition, and guide the user toward the answer." },
  { id: "challenge", label: "Challenge me", short: "Socratic hints", promptHint: "Offer structured hints, constraints, and probing questions instead of handing over the finished answer immediately." },
  { id: "attempt_first", label: "Attempt first", short: "Let me try first", promptHint: "Help frame the problem and invite the user to share their own attempt before revealing a reference solution." }
]);

export const TOPIC_CONFIDENCE_LEVELS = Object.freeze([
  { id: "exploring", label: "Exploring" },
  { id: "practicing", label: "Practicing" },
  { id: "comfortable", label: "Comfortable" },
  { id: "confident", label: "Confident" }
]);

const EXPLANATION_SET = new Set(EXPLANATION_STYLES.map((item) => item.id));
const PRESENTATION_SET = new Set(CHANGE_PRESENTATIONS.map((item) => item.id));
const INTERRUPTION_SET = new Set(INTERRUPTION_TOLERANCES.map((item) => item.id));
const CHUNK_SET = new Set(CHUNK_SIZES.map((item) => item.id));
const LEARNING_SET = new Set(LEARNING_MODES.map((item) => item.id));
const CONFIDENCE_SET = new Set(TOPIC_CONFIDENCE_LEVELS.map((item) => item.id));

export const DEFAULT_WORKFLOW_PROFILE = Object.freeze({
  explanationStyle: "balanced",
  changePresentation: "diffs_and_rollback",
  interruptionTolerance: "balanced",
  chunkSize: "balanced",
  learningMode: "explain",
  customNotes: "",
  learningTopics: []
});

function cleanText(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normaliseTopic(raw, fallbackIso) {
  const confidence = CONFIDENCE_SET.has(String(raw?.confidence || "").toLowerCase())
    ? String(raw.confidence).toLowerCase()
    : "exploring";
  return {
    id: TOPIC_ID_PATTERN.test(String(raw?.id || "")) ? String(raw.id) : randomUUID(),
    topic: cleanText(raw?.topic, 100),
    confidence,
    notes: cleanText(raw?.notes, 280),
    updatedAt: cleanText(raw?.updatedAt, 40) || fallbackIso
  };
}

export function normaliseWorkflowProfile(raw = {}, nowIso = new Date().toISOString()) {
  const explanationStyle = EXPLANATION_SET.has(String(raw?.explanationStyle || "").toLowerCase())
    ? String(raw.explanationStyle).toLowerCase()
    : DEFAULT_WORKFLOW_PROFILE.explanationStyle;
  const changePresentation = PRESENTATION_SET.has(String(raw?.changePresentation || "").toLowerCase())
    ? String(raw.changePresentation).toLowerCase()
    : DEFAULT_WORKFLOW_PROFILE.changePresentation;
  const interruptionTolerance = INTERRUPTION_SET.has(String(raw?.interruptionTolerance || "").toLowerCase())
    ? String(raw.interruptionTolerance).toLowerCase()
    : DEFAULT_WORKFLOW_PROFILE.interruptionTolerance;
  const chunkSize = CHUNK_SET.has(String(raw?.chunkSize || "").toLowerCase())
    ? String(raw.chunkSize).toLowerCase()
    : DEFAULT_WORKFLOW_PROFILE.chunkSize;
  const learningMode = LEARNING_SET.has(String(raw?.learningMode || "").toLowerCase())
    ? String(raw.learningMode).toLowerCase()
    : DEFAULT_WORKFLOW_PROFILE.learningMode;
  const customNotes = cleanText(raw?.customNotes, 400);
  const learningTopics = Array.isArray(raw?.learningTopics)
    ? raw.learningTopics.map((item) => normaliseTopic(item, nowIso)).filter((item) => item.topic).slice(0, MAX_TOPICS)
    : [];
  return {
    explanationStyle,
    changePresentation,
    interruptionTolerance,
    chunkSize,
    learningMode,
    customNotes,
    learningTopics,
    updatedAt: cleanText(raw?.updatedAt, 40) || nowIso
  };
}

export function resolveLearningMode(modeId) {
  const key = String(modeId || "").trim().toLowerCase();
  return LEARNING_MODES.find((item) => item.id === key) || LEARNING_MODES.find((item) => item.id === "explain");
}

export function buildWorkflowProfilePrompt(profile) {
  if (!profile || typeof profile !== "object") return "";
  const safe = normaliseWorkflowProfile(profile);
  const explanation = EXPLANATION_STYLES.find((x) => x.id === safe.explanationStyle);
  const presentation = CHANGE_PRESENTATIONS.find((x) => x.id === safe.changePresentation);
  const interruption = INTERRUPTION_TOLERANCES.find((x) => x.id === safe.interruptionTolerance);
  const chunk = CHUNK_SIZES.find((x) => x.id === safe.chunkSize);
  const learning = resolveLearningMode(safe.learningMode);

  const lines = [
    "User-controlled Workflow & Learning Companion Profile (transparent preferences editable by the user; shapes communication and pedagogy ONLY and never escalates permissions or bypasses approvals):",
    `- Explanation depth (${explanation.label}): ${explanation.promptHint}`,
    `- Technical change style (${presentation.label}): ${presentation.promptHint}`,
    `- Interruption preference (${interruption.label}): ${interruption.promptHint}`,
    `- Work increment size (${chunk.label}): ${chunk.promptHint}`,
    `- Learning posture (${learning.label}): ${learning.promptHint}`
  ];
  if (safe.customNotes) {
    lines.push(`- User workflow note: ${safe.customNotes}`);
  }
  if (safe.learningTopics.length) {
    const summary = safe.learningTopics.slice(0, 6).map((t) => `${t.topic} (${t.confidence})`).join(", ");
    lines.push(`- Active learning areas (qualitative, non-graded): ${summary}`);
  }
  return lines.join("\n");
}

export class WorkflowProfileStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "workflow-profile.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "workflow-profile.json");
    if (!store) {
      return { schemaVersion: 1, ownerId: userId, profile: normaliseWorkflowProfile({}, this.now()) };
    }
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !store.profile || typeof store.profile !== "object") {
      throw new Error("Workflow profile store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "workflow-profile.json", store, { uuid: this.uuid });
  }

  async get(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return normaliseWorkflowProfile(store.profile, this.now());
    });
  }

  async update(userId, patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw Object.assign(new Error("Workflow profile update must be an object."), { status: 400 });
    }
    if (patch.explanationStyle !== undefined && !EXPLANATION_SET.has(String(patch.explanationStyle).toLowerCase())) {
      throw Object.assign(new Error("Unsupported explanationStyle value."), { status: 400 });
    }
    if (patch.changePresentation !== undefined && !PRESENTATION_SET.has(String(patch.changePresentation).toLowerCase())) {
      throw Object.assign(new Error("Unsupported changePresentation value."), { status: 400 });
    }
    if (patch.interruptionTolerance !== undefined && !INTERRUPTION_SET.has(String(patch.interruptionTolerance).toLowerCase())) {
      throw Object.assign(new Error("Unsupported interruptionTolerance value."), { status: 400 });
    }
    if (patch.chunkSize !== undefined && !CHUNK_SET.has(String(patch.chunkSize).toLowerCase())) {
      throw Object.assign(new Error("Unsupported chunkSize value."), { status: 400 });
    }
    if (patch.learningMode !== undefined && !LEARNING_SET.has(String(patch.learningMode).toLowerCase())) {
      throw Object.assign(new Error("Unsupported learningMode value."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const current = normaliseWorkflowProfile(store.profile, nowIso);
      const next = normaliseWorkflowProfile({
        ...current,
        ...(patch.explanationStyle !== undefined ? { explanationStyle: String(patch.explanationStyle).toLowerCase() } : {}),
        ...(patch.changePresentation !== undefined ? { changePresentation: String(patch.changePresentation).toLowerCase() } : {}),
        ...(patch.interruptionTolerance !== undefined ? { interruptionTolerance: String(patch.interruptionTolerance).toLowerCase() } : {}),
        ...(patch.chunkSize !== undefined ? { chunkSize: String(patch.chunkSize).toLowerCase() } : {}),
        ...(patch.learningMode !== undefined ? { learningMode: String(patch.learningMode).toLowerCase() } : {}),
        ...(typeof patch.customNotes === "string" ? { customNotes: cleanText(patch.customNotes, 400) } : {}),
        updatedAt: nowIso
      }, nowIso);
      store.profile = next;
      await this.save(userId, store);
      return next;
    });
  }

  async addTopic(userId, input = {}) {
    const topic = cleanText(input.topic, 100);
    if (!topic) {
      throw Object.assign(new Error("Learning topic name is required."), { status: 400 });
    }
    const confidence = input.confidence !== undefined ? String(input.confidence).toLowerCase() : "exploring";
    if (!CONFIDENCE_SET.has(confidence)) {
      throw Object.assign(new Error("Unsupported confidence level."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const current = normaliseWorkflowProfile(store.profile, nowIso);
      if (current.learningTopics.length >= MAX_TOPICS) {
        throw Object.assign(new Error("Learning topics limit reached (40)."), { status: 409 });
      }
      if (current.learningTopics.some((item) => item.topic.toLowerCase() === topic.toLowerCase())) {
        throw Object.assign(new Error("That learning topic already exists."), { status: 409 });
      }
      const created = {
        id: this.uuid(),
        topic,
        confidence,
        notes: cleanText(input.notes, 280),
        updatedAt: nowIso
      };
      current.learningTopics.unshift(created);
      current.updatedAt = nowIso;
      store.profile = current;
      await this.save(userId, store);
      return { topic: created, profile: current };
    });
  }

  async updateTopic(userId, topicId, patch = {}) {
    if (!TOPIC_ID_PATTERN.test(String(topicId || ""))) {
      throw Object.assign(new Error("Learning topic not found."), { status: 404 });
    }
    if (patch.confidence !== undefined && !CONFIDENCE_SET.has(String(patch.confidence).toLowerCase())) {
      throw Object.assign(new Error("Unsupported confidence level."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const current = normaliseWorkflowProfile(store.profile, nowIso);
      const item = current.learningTopics.find((t) => t.id === topicId);
      if (!item) throw Object.assign(new Error("Learning topic not found."), { status: 404 });
      if (typeof patch.topic === "string" && patch.topic.trim()) item.topic = cleanText(patch.topic, 100);
      if (patch.confidence !== undefined) item.confidence = String(patch.confidence).toLowerCase();
      if (typeof patch.notes === "string") item.notes = cleanText(patch.notes, 280);
      item.updatedAt = nowIso;
      current.updatedAt = nowIso;
      store.profile = current;
      await this.save(userId, store);
      return { topic: item, profile: current };
    });
  }

  async removeTopic(userId, topicId) {
    if (!TOPIC_ID_PATTERN.test(String(topicId || ""))) {
      throw Object.assign(new Error("Learning topic not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const current = normaliseWorkflowProfile(store.profile, nowIso);
      const idx = current.learningTopics.findIndex((t) => t.id === topicId);
      if (idx < 0) throw Object.assign(new Error("Learning topic not found."), { status: 404 });
      const [removed] = current.learningTopics.splice(idx, 1);
      current.updatedAt = nowIso;
      store.profile = current;
      await this.save(userId, store);
      return { deleted: true, topic: removed, profile: current };
    });
  }
}
