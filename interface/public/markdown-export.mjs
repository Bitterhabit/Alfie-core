/**
 * Pure Markdown conversation exporter and filename sanitizer for Alfie Workspace.
 */

const ROLE_LABELS = Object.freeze({
  user: "You",
  assistant: "Alfie",
  system: "System",
  tool: "Tool"
});

/**
 * Format a message role into a readable Markdown speaker heading.
 * @param {string} role
 * @returns {string}
 */
export function formatRoleHeading(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (!normalized) return "Message";
  return ROLE_LABELS[normalized] || (normalized[0].toUpperCase() + normalized.slice(1));
}

/**
 * Format an ISO timestamp or Date into a clean UTC string (`YYYY-MM-DD HH:MM UTC`).
 * Returns an empty string if the input is missing or invalid.
 * @param {string | number | Date | null | undefined} value
 * @returns {string}
 */
export function formatExportTimestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/**
 * Sanitize a conversation title into a safe `.md` download filename.
 * @param {string | null | undefined} title
 * @param {Date} [now]
 * @returns {string}
 */
export function sanitizeExportFilename(title, now = new Date()) {
  const raw = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

  const base = raw || "alfie-conversation";
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${base}-${dateStamp}.md`;
}

function formatMessageMetadataLine(message) {
  const parts = [];
  const metrics = message?.metrics && typeof message.metrics === "object" ? message.metrics : null;
  if (metrics) {
    if (metrics.model) parts.push(`Model: ${String(metrics.model).trim()}`);
    else if (metrics.provider) parts.push(`Provider: ${String(metrics.provider).trim()}`);
    if (Number.isFinite(Number(metrics.latencyMs)) && Number(metrics.latencyMs) > 0) {
      parts.push(`${Math.round(Number(metrics.latencyMs))} ms`);
    }
    const tokenCount = Number(metrics.totalTokens ?? metrics.tokens ?? metrics.outputTokens);
    if (Number.isFinite(tokenCount) && tokenCount > 0) {
      parts.push(`${Math.round(tokenCount)} tokens`);
    }
  }
  const modeLabel = String(message?.provenance?.workingMode?.label || "").trim();
  if (modeLabel) parts.push(`Mode: ${modeLabel}`);

  if (message?.reaction === "up" || message?.reaction === "like") parts.push("Reaction: Helpful");
  else if (message?.reaction === "down") parts.push("Reaction: Needs work");
  else if (message?.reaction === "flag") parts.push("Reaction: Flagged");

  if (!parts.length) return "";
  return `> _${parts.join(" · ")}_`;
}

/**
 * Format a conversation and its message history into a clean Markdown document.
 *
 * @param {{
 *   conversation?: {
 *     title?: string,
 *     createdAt?: string,
 *     updatedAt?: string,
 *     handoffContext?: string
 *   } | null,
 *   messages?: Array<{
 *     role?: string,
 *     content?: string,
 *     createdAt?: string,
 *     metrics?: Record<string, unknown>,
 *     provenance?: { workingMode?: { label?: string } },
 *     reaction?: string
 *   }>,
 *   project?: { name?: string, status?: string } | null,
 *   exportedAt?: Date
 * }} options
 * @returns {string}
 */
export function formatConversationMarkdown({
  conversation = null,
  messages = [],
  project = null,
  exportedAt = new Date()
} = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const title = String(conversation?.title || "").trim() || "Alfie Conversation";
  const exportedStamp = formatExportTimestamp(exportedAt);
  const projectName = String(project?.name || "").trim();
  const projectStatus = String(project?.status || "").trim();
  const handoffContext = String(conversation?.handoffContext || "").trim();

  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");

  const metaItems = [];
  if (exportedStamp) metaItems.push(`- **Exported:** ${exportedStamp}`);
  if (projectName) {
    metaItems.push(projectStatus ? `- **Project:** ${projectName} (${projectStatus})` : `- **Project:** ${projectName}`);
  }
  metaItems.push(`- **Messages:** ${safeMessages.length}`);
  lines.push(...metaItems);

  if (handoffContext) {
    lines.push("");
    lines.push("## Carried-Over Context");
    lines.push("");
    lines.push(handoffContext);
  }

  if (safeMessages.length > 0) {
    lines.push("");
    lines.push("---");

    safeMessages.forEach((message, index) => {
      const roleHeading = formatRoleHeading(message?.role);
      const stamp = formatExportTimestamp(message?.createdAt || message?.timestamp);
      const header = stamp ? `## ${roleHeading} — ${stamp}` : `## ${roleHeading}`;
      const metaLine = formatMessageMetadataLine(message);
      const body = String(message?.content ?? "").replace(/\r\n/g, "\n").trimEnd();

      lines.push("");
      lines.push(header);
      if (metaLine) {
        lines.push("");
        lines.push(metaLine);
      }
      lines.push("");
      lines.push(body || "_(Empty message)_");

      if (index < safeMessages.length - 1) {
        lines.push("");
        lines.push("---");
      }
    });
  }

  return lines.join("\n") + "\n";
}

/**
 * Parse newline-separated textarea content or an array into deduplicated dossier list items.
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
export function parseDossierLines(value) {
  if (value === undefined || value === null) return [];
  const rawList = typeof value === "string"
    ? value.split(/\r?\n/)
    : (Array.isArray(value) ? value : []);
  const seen = new Set();
  const result = [];
  for (const entry of rawList) {
    const cleaned = String(entry || "")
      .replace(/^\s*[-*•]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

/**
 * Parse structured or newline-formatted dossier decisions ("Choice — Rationale" or "Choice | Rationale").
 * @param {string | Array<Record<string, unknown>> | null | undefined} value
 * @returns {Array<{ summary: string, rationale: string, id?: string, createdAt?: string }>}
 */
export function parseDossierDecisions(value) {
  if (value === undefined || value === null) return [];
  const rawList = typeof value === "string"
    ? value
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+[—–-]{1,2}\s+|\s*\|\s*/);
          return { summary: parts[0] || "", rationale: parts.slice(1).join(" — ") };
        })
    : (Array.isArray(value) ? value : []);

  const result = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const summary = String(item.summary || item.decision || "").replace(/\s+/g, " ").trim();
    if (!summary) continue;
    const rationale = String(item.rationale || "").replace(/\s+/g, " ").trim();
    const entry = { summary, rationale };
    if (typeof item.id === "string" && item.id.trim()) entry.id = item.id.trim();
    if (typeof item.createdAt === "string" && item.createdAt.trim()) entry.createdAt = item.createdAt.trim();
    result.push(entry);
  }
  return result;
}

/**
 * Sanitize a project name into a safe `.json` or `.md` dossier backup filename.
 * @param {string | null | undefined} projectName
 * @param {"json" | "md" | "markdown"} [format]
 * @param {Date} [now]
 * @returns {string}
 */
export function sanitizeDossierExportFilename(projectName, format = "md", now = new Date()) {
  const raw = String(projectName || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
    .replace(/-+$/g, "");

  const base = raw || "project";
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const ext = String(format || "md").trim().toLowerCase() === "json" ? "json" : "md";
  return `${base}-dossier-${dateStamp}.${ext}`;
}

/**
 * Build a structured, schema-versioned Project Dossier snapshot suitable for JSON backup or Markdown rendering.
 * @param {Record<string, unknown> | null | undefined} project
 * @param {{ exportedAt?: Date }} [options]
 */
export function buildProjectDossierSnapshot(project = {}, { exportedAt = new Date() } = {}) {
  const src = project && typeof project === "object" ? project : {};
  const safeDate = exportedAt instanceof Date && !Number.isNaN(exportedAt.getTime()) ? exportedAt : new Date();
  const cleanBlock = (val) => String(val || "").replace(/\r\n/g, "\n").trim();

  const name = cleanBlock(src.name).replace(/\s+/g, " ") || "Untitled Project";
  const status = cleanBlock(src.status).toLowerCase() || "active";
  const color = cleanBlock(src.color).toLowerCase() || "purple";
  const vision = cleanBlock(src.vision);
  const notes = cleanBlock(src.notes ?? src.description);
  const architectureConstraints = cleanBlock(src.architectureConstraints ?? src.architecture);
  const decisions = parseDossierDecisions(src.decisions);
  const nextActions = parseDossierLines(src.nextActions);
  const blockers = parseDossierLines(src.blockers);
  const postponed = parseDossierLines(src.postponed);

  const projectRecord = {
    ...(typeof src.id === "string" && src.id.trim() ? { id: src.id.trim() } : {}),
    name,
    status,
    color,
    ...(typeof src.createdAt === "string" && src.createdAt.trim() ? { createdAt: src.createdAt.trim() } : {}),
    ...(typeof src.updatedAt === "string" && src.updatedAt.trim() ? { updatedAt: src.updatedAt.trim() } : {}),
    vision,
    notes,
    architectureConstraints,
    decisions,
    nextActions,
    blockers,
    postponed
  };

  return {
    schema: "alfie.project-dossier.v1",
    exportedAt: safeDate.toISOString(),
    project: projectRecord
  };
}

/**
 * Serialize a Project Dossier into a pretty-printed JSON backup string.
 * @param {Record<string, unknown> | null | undefined} project
 * @param {{ exportedAt?: Date }} [options]
 * @returns {string}
 */
export function formatProjectDossierJson(project = {}, { exportedAt = new Date() } = {}) {
  return JSON.stringify(buildProjectDossierSnapshot(project, { exportedAt }), null, 2) + "\n";
}

/**
 * Format a Project Dossier into a structured Markdown backup document.
 * @param {Record<string, unknown> | null | undefined} project
 * @param {{ exportedAt?: Date }} [options]
 * @returns {string}
 */
export function formatProjectDossierMarkdown(project = {}, { exportedAt = new Date() } = {}) {
  const snapshot = buildProjectDossierSnapshot(project, { exportedAt });
  const p = snapshot.project;
  const exportedStamp = formatExportTimestamp(snapshot.exportedAt);
  const createdStamp = formatExportTimestamp(p.createdAt);
  const updatedStamp = formatExportTimestamp(p.updatedAt);

  const lines = [];
  lines.push(`# ${p.name} — Project Dossier`);
  lines.push("");
  lines.push(`- **Status:** ${p.status}`);
  if (exportedStamp) lines.push(`- **Exported:** ${exportedStamp}`);
  if (p.id) lines.push(`- **Project ID:** \`${p.id}\``);
  if (createdStamp) lines.push(`- **Created:** ${createdStamp}`);
  if (updatedStamp) lines.push(`- **Last updated:** ${updatedStamp}`);

  const sections = [];

  if (p.vision) {
    sections.push(`## Vision & Objective\n\n${p.vision}`);
  }
  if (p.notes) {
    sections.push(`## Project Notes\n\n${p.notes}`);
  }
  if (p.architectureConstraints) {
    sections.push(`## Architecture & Constraints\n\n${p.architectureConstraints}`);
  }
  if (p.decisions.length) {
    const decisionLines = p.decisions.map((d) =>
      d.rationale ? `- **${d.summary}** — ${d.rationale}` : `- **${d.summary}**`
    );
    sections.push(`## Key Decisions\n\n${decisionLines.join("\n")}`);
  }
  if (p.nextActions.length) {
    sections.push(`## Next Actions\n\n${p.nextActions.map((item) => `- [ ] ${item}`).join("\n")}`);
  }
  if (p.blockers.length) {
    sections.push(`## Blockers\n\n${p.blockers.map((item) => `- ${item}`).join("\n")}`);
  }
  if (p.postponed.length) {
    sections.push(`## Deliberately Postponed\n\n${p.postponed.map((item) => `- ${item}`).join("\n")}`);
  }

  if (sections.length) {
    lines.push("");
    lines.push("---");
    for (const section of sections) {
      lines.push("");
      lines.push(section);
    }
  } else {
    lines.push("");
    lines.push("_(No dossier notes, architecture constraints, or decisions recorded yet.)_");
  }

  return lines.join("\n") + "\n";
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieMarkdownExport = Object.freeze({
    formatRoleHeading,
    formatExportTimestamp,
    sanitizeExportFilename,
    formatConversationMarkdown,
    parseDossierLines,
    parseDossierDecisions,
    sanitizeDossierExportFilename,
    buildProjectDossierSnapshot,
    formatProjectDossierJson,
    formatProjectDossierMarkdown
  });
}
