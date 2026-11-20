export const PERSONAL_VISIBILITY_KEYS = Object.freeze([
  "allowMail",
  "allowCalendar",
  "allowJournal",
  "allowPersonalMemories",
  "allowDashboardState"
]);

export const DEFAULT_CLOUD_VISIBILITY = Object.freeze({
  allowMail: false,
  allowCalendar: false,
  allowJournal: false,
  allowPersonalMemories: false,
  allowDashboardState: false,
  allowProjectContext: true,
  allowCodeTools: true,
  redactPersonalIdentifiers: true
});

export const PRIVACY_CATEGORIES = Object.freeze([
  {
    key: "allowMail",
    label: "Emails & Inbox",
    group: "personal",
    defaultAllowed: false,
    description: "Mail summaries, inbox context, and email tools."
  },
  {
    key: "allowCalendar",
    label: "Calendar & Schedule",
    group: "personal",
    defaultAllowed: false,
    description: "Upcoming events, selected dates, and calendar tools."
  },
  {
    key: "allowJournal",
    label: "Personal Journal",
    group: "personal",
    defaultAllowed: false,
    description: "Private journal reflections, diary entries, and activity logs."
  },
  {
    key: "allowPersonalMemories",
    label: "Garden Memories",
    group: "personal",
    defaultAllowed: false,
    description: "Saved personal memories and memory search/write tools."
  },
  {
    key: "allowDashboardState",
    label: "Dashboard & Notifications",
    group: "personal",
    defaultAllowed: false,
    description: "System notifications, Petrio status, quest progress, and health."
  },
  {
    key: "allowProjectContext",
    label: "Project Notes & Handoff",
    group: "coding",
    defaultAllowed: true,
    description: "Active project notes and carried-over coding context."
  },
  {
    key: "allowCodeTools",
    label: "Code & Utility Tools",
    group: "coding",
    defaultAllowed: true,
    description: "Repository audit, project roadmap, and visual asset tools."
  },
  {
    key: "redactPersonalIdentifiers",
    label: "Scrub Email Addresses",
    group: "coding",
    defaultAllowed: true,
    description: "Automatically redact email addresses from outbound prompts."
  }
]);

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function normaliseVisibility(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_CLOUD_VISIBILITY)) {
    result[key] = typeof source[key] === "boolean" ? source[key] : fallback;
  }
  return result;
}

export function hasAnyPersonalVisibility(visibility) {
  const v = normaliseVisibility(visibility);
  return PERSONAL_VISIBILITY_KEYS.some((key) => v[key] === true);
}

export function stripPersonalVisibility(visibility) {
  const v = normaliseVisibility(visibility);
  for (const key of PERSONAL_VISIBILITY_KEYS) {
    v[key] = false;
  }
  return v;
}

export function isStrictCodingOnly(visibility) {
  return !hasAnyPersonalVisibility(visibility);
}

export function summarizePrivacy(visibility) {
  const v = normaliseVisibility(visibility);
  const blockedCategories = [];
  const allowedCategories = [];
  const allowedPersonalCategories = [];

  for (const cat of PRIVACY_CATEGORIES) {
    if (cat.key === "redactPersonalIdentifiers") continue;
    if (v[cat.key]) {
      allowedCategories.push(cat.label);
      if (cat.group === "personal") allowedPersonalCategories.push(cat.label);
    } else {
      blockedCategories.push(cat.label);
    }
  }

  return {
    preset: isStrictCodingOnly(v) ? "coding-only" : "custom",
    personalDataIsolated: isStrictCodingOnly(v),
    allowedPersonalCategories,
    allowedPersonalCount: allowedPersonalCategories.length,
    totalPersonalCount: PERSONAL_VISIBILITY_KEYS.length,
    redactPersonalIdentifiers: v.redactPersonalIdentifiers,
    blockedCategories,
    allowedCategories
  };
}

export function classifyToolCategory(toolOrScope) {
  const scope = String(typeof toolOrScope === "string" ? toolOrScope : (toolOrScope?.scope || "")).toLowerCase();
  const id = String(typeof toolOrScope === "object" ? (toolOrScope?.id || "") : "").toLowerCase();
  const tags = Array.isArray(toolOrScope?.tags) ? toolOrScope.tags.map((t) => String(t).toLowerCase()) : [];

  if (scope.startsWith("mail:") || id.includes("mail") || id.includes("email") || tags.includes("mail") || tags.includes("inbox")) {
    return "mail";
  }
  if (scope === "petrio:activity:read" || id === "get_personal_activity") {
    return "personal_activity";
  }
  if (scope.startsWith("calendar:") || id.includes("calendar") || tags.includes("calendar")) {
    return "calendar";
  }
  if (scope.startsWith("journal:") || id.includes("journal") || tags.includes("journal") || tags.includes("diary")) {
    return "journal";
  }
  if (scope.startsWith("memory:") || id.startsWith("memory.") || tags.includes("memory") || tags.includes("garden")) {
    return "memory";
  }
  if (
    scope === "petrio:audit:read" ||
    scope === "petrio:roadmap:read" ||
    scope === "image:generate" ||
    id === "get_implementation_audit" ||
    id === "get_project_tasks" ||
    id === "generate_image"
  ) {
    return "code";
  }
  // Fail-closed: any other tool (Petrio status, quest progress, world model, or unknown external tools)
  // is governed by the dashboard/personal boundary.
  return "dashboard";
}

export function isToolAllowedByVisibility(toolOrScope, visibility) {
  const v = normaliseVisibility(visibility);
  const category = classifyToolCategory(toolOrScope);
  if (category === "mail") return v.allowMail;
  if (category === "calendar") return v.allowCalendar;
  if (category === "journal") return v.allowJournal;
  if (category === "personal_activity") return v.allowCalendar && v.allowJournal;
  if (category === "memory") return v.allowPersonalMemories;
  if (category === "code") return v.allowCodeTools;
  return v.allowDashboardState;
}

export function filterGrantedScopes(grantedScopes = [], toolRegistry = null, visibility = DEFAULT_CLOUD_VISIBILITY) {
  const v = normaliseVisibility(visibility);
  const registeredTools = typeof toolRegistry?.list === "function" ? toolRegistry.list() : [];
  const toolsByScope = new Map();
  for (const tool of registeredTools) {
    if (!toolsByScope.has(tool.scope)) toolsByScope.set(tool.scope, []);
    toolsByScope.get(tool.scope).push(tool);
  }

  const allowedScopes = [];
  const blockedScopes = [];

  for (const scope of Array.isArray(grantedScopes) ? grantedScopes : []) {
    const tools = toolsByScope.get(scope);
    const allowed = tools && tools.length
      ? tools.every((tool) => isToolAllowedByVisibility(tool, v))
      : isToolAllowedByVisibility(scope, v);
    if (allowed) allowedScopes.push(scope);
    else blockedScopes.push(scope);
  }

  return { allowedScopes, blockedScopes };
}

export function redactPersonalText(value) {
  const input = String(value || "");
  let count = 0;
  const text = input.replace(EMAIL_PATTERN, () => {
    count += 1;
    return "[redacted-email]";
  });
  return { text, count };
}

export function filterDashboardState(dashboardState = {}, visibility = DEFAULT_CLOUD_VISIBILITY) {
  const v = normaliseVisibility(visibility);
  const source = dashboardState && typeof dashboardState === "object" ? dashboardState : {};
  const filtered = {};
  let redactedCount = 0;

  const maybeRedact = (val) => {
    if (!v.redactPersonalIdentifiers || typeof val !== "string") return val;
    const res = redactPersonalText(val);
    redactedCount += res.count;
    return res.text;
  };

  if (v.allowMail && source.mailSummary !== undefined && source.mailSummary !== null) {
    filtered.mailSummary = maybeRedact(source.mailSummary);
  }
  if (v.allowCalendar) {
    if (source.calendarSummary !== undefined && source.calendarSummary !== null) {
      filtered.calendarSummary = maybeRedact(source.calendarSummary);
    }
    if (source.selectedDate !== undefined && source.selectedDate !== null) {
      filtered.selectedDate = source.selectedDate;
    }
  }
  if (v.allowJournal && source.journalSummary !== undefined && source.journalSummary !== null) {
    filtered.journalSummary = maybeRedact(source.journalSummary);
  }
  if (v.allowDashboardState) {
    for (const key of ["activeApp", "view", "systemSummary", "notificationsCount", "systemHealth"]) {
      if (source[key] !== undefined && source[key] !== null) {
        filtered[key] = maybeRedact(source[key]);
      }
    }
  }
  if (v.allowProjectContext && source.attachedContext !== undefined && source.attachedContext !== null) {
    filtered.attachedContext = maybeRedact(source.attachedContext);
  }

  return { dashboardState: filtered, redactedCount };
}

export function filterMemories(memories = [], visibility = DEFAULT_CLOUD_VISIBILITY) {
  const v = normaliseVisibility(visibility);
  if (!v.allowPersonalMemories) return { memories: [], redactedCount: 0 };
  let redactedCount = 0;
  const result = (Array.isArray(memories) ? memories : []).map((memory) => {
    if (!v.redactPersonalIdentifiers) return memory;
    const titleRes = redactPersonalText(memory.title || "");
    const textRes = redactPersonalText(memory.text || "");
    redactedCount += titleRes.count + textRes.count;
    return { ...memory, title: titleRes.text, text: textRes.text };
  });
  return { memories: result, redactedCount };
}

export function applyCloudPrivacyPolicy({
  provider,
  model,
  visibility = DEFAULT_CLOUD_VISIBILITY,
  dashboardState = {},
  memories = [],
  grantedScopes = [],
  toolRegistry = null,
  history = []
} = {}) {
  const v = normaliseVisibility(visibility);
  const summary = summarizePrivacy(v);
  const stateResult = filterDashboardState(dashboardState, v);
  const memoryResult = filterMemories(memories, v);
  const scopeResult = filterGrantedScopes(grantedScopes, toolRegistry, v);

  let redactedCount = stateResult.redactedCount + memoryResult.redactedCount;
  const filteredHistory = (Array.isArray(history) ? history : []).map((message) => {
    if (!v.redactPersonalIdentifiers) return message;
    const res = redactPersonalText(message.content || "");
    redactedCount += res.count;
    return { ...message, content: res.text };
  });

  const providerLabel = provider === "gemini" ? "Gemini API" : (provider === "openai" ? "ChatGPT (OpenAI)" : String(provider || "Cloud"));
  const blockedList = summary.blockedCategories.length ? summary.blockedCategories.join(", ") : "None";
  const allowedList = summary.allowedCategories.length ? summary.allowedCategories.join(", ") : "Chat prompt only";

  const systemNotice = summary.personalDataIsolated
    ? [
        `CLOUD CODING AGENT PRIVACY BOUNDARY (${providerLabel}${model ? ` · ${model}` : ""}):`,
        "You are acting as a focused software engineering and coding assistant inside Alfie.",
        `Blocked by user privacy controls (NEVER claim access to these): ${blockedList}.`,
        `Explicitly permitted context: ${allowedList}.`,
        "Focus cleanly on code architecture, debugging, refactoring, tests, and technical explanations."
      ].join("\n")
    : [
        `CLOUD AGENT PRIVACY BOUNDARY (${providerLabel}${model ? ` · ${model}` : ""}):`,
        "You are assisting the user inside Alfie with coding and ONLY the private sections they explicitly opted into below.",
        `Blocked by user privacy controls (NEVER claim access to these): ${blockedList}.`,
        `Explicitly opted-in private sections: ${summary.allowedPersonalCategories.join(", ")}.`,
        `All permitted context: ${allowedList}.`,
        "Only reference private data from explicitly permitted sections and respect all remaining blocked boundaries."
      ].join("\n");

  return {
    visibility: v,
    dashboardState: stateResult.dashboardState,
    memories: memoryResult.memories,
    grantedScopes: scopeResult.allowedScopes,
    blockedScopes: scopeResult.blockedScopes,
    history: filteredHistory,
    systemNotice,
    privacyReport: {
      provider,
      providerLabel,
      model: model || null,
      preset: summary.preset,
      personalDataIsolated: summary.personalDataIsolated,
      allowedPersonalCategories: summary.allowedPersonalCategories,
      blockedCategories: summary.blockedCategories,
      allowedCategories: summary.allowedCategories,
      blockedScopesCount: scopeResult.blockedScopes.length,
      redactedCount
    }
  };
}
