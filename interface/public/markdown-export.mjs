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

if (typeof globalThis !== "undefined") {
  globalThis.AlfieMarkdownExport = Object.freeze({
    formatRoleHeading,
    formatExportTimestamp,
    sanitizeExportFilename,
    formatConversationMarkdown
  });
}
