const DEFAULT_MAX_RECENT_TURNS = 8;
const DEFAULT_MAX_CHARS = 4200;

function normalizeWhitespace(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function truncateText(text, maxChars) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

export function nextContinuationTitle(title = "New conversation") {
  const base = String(title || "New conversation").replace(/\s+/g, " ").trim() || "New conversation";
  const match = /^(.*?)\s*\(Part\s+(\d+)\)$/i.exec(base);
  if (match) {
    const stem = match[1].trim() || "Conversation";
    const nextPart = Math.min(999, Number(match[2]) + 1);
    const suffix = ` (Part ${nextPart})`;
    return stem.slice(0, Math.max(1, 120 - suffix.length)).trimEnd() + suffix;
  }
  const suffix = " (Part 2)";
  return base.slice(0, Math.max(1, 120 - suffix.length)).trimEnd() + suffix;
}

export function buildHandoffBrief(conversation, {
  project = null,
  maxRecentTurns = DEFAULT_MAX_RECENT_TURNS,
  maxChars = DEFAULT_MAX_CHARS,
  extraNotes = "",
  reason = "context_handoff"
} = {}) {
  const title = String(conversation?.title || "Previous conversation").trim();
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages.filter((item) => item && ["user", "assistant"].includes(item.role) && String(item.content || "").trim())
    : [];

  const sections = [];
  sections.push(`# Context carried over from "${title}"`);

  const metaLines = [];
  if (project?.name) metaLines.push(`- **Project**: ${project.name}`);
  if (project?.description) metaLines.push(`- **Project notes**: ${truncateText(project.description, 320)}`);
  metaLines.push(`- **Source conversation**: ${title} (${messages.length} message${messages.length === 1 ? "" : "s"})`);
  if (reason === "vram_threshold") {
    metaLines.push(`- **Handoff reason**: Started a fresh chat at high VRAM usage to keep the project responsive without losing context.`);
  }
  sections.push(metaLines.join("\n"));

  const cleanNotes = normalizeWhitespace(extraNotes).slice(0, 600);
  if (cleanNotes) {
    sections.push(`## Continuation focus\n${cleanNotes}`);
  }

  // Carry over any prior handoff chain concisely so multi-part projects stay coherent
  if (typeof conversation?.handoffContext === "string" && conversation.handoffContext.trim()) {
    sections.push(`## Earlier project context\n${truncateText(conversation.handoffContext, 700)}`);
  }

  const userMessages = messages.filter((item) => item.role === "user");
  if (userMessages.length > 0) {
    const goalLines = [];
    const firstGoal = truncateText(userMessages[0].content, 240);
    goalLines.push(`- Initial request: ${firstGoal}`);
    if (userMessages.length > 1) {
      const latestGoal = truncateText(userMessages[userMessages.length - 1].content, 240);
      if (latestGoal !== firstGoal) {
        goalLines.push(`- Most recent request: ${latestGoal}`);
      }
    }
    sections.push(`## Key goals\n${goalLines.join("\n")}`);
  }

  // Extract referenced asset paths or filenames if present in conversation
  const assetMatches = new Set();
  for (const item of messages) {
    const found = String(item.content || "").match(/\/api\/core\/images\/[a-zA-Z0-9._-]+|assets\/[a-zA-Z0-9._/-]+/g);
    if (found) {
      for (const pathMatch of found) {
        assetMatches.add(pathMatch);
        if (assetMatches.size >= 6) break;
      }
    }
    if (assetMatches.size >= 6) break;
  }
  if (assetMatches.size > 0) {
    sections.push(`## Referenced assets\n${Array.from(assetMatches).map((item) => `- ${item}`).join("\n")}`);
  }

  const recentLimit = Math.max(2, Math.min(16, Number(maxRecentTurns) || DEFAULT_MAX_RECENT_TURNS));
  const recent = messages.slice(-recentLimit);
  if (recent.length > 0) {
    const perMessageLimit = recent.length <= 4 ? 420 : 260;
    const excerptLines = recent.map((item) => {
      const speaker = item.role === "user" ? "User" : "Alfie";
      return `- **${speaker}**: ${truncateText(item.content, perMessageLimit)}`;
    });
    sections.push(`## Recent exchange summary\n${excerptLines.join("\n")}`);
  } else {
    sections.push(`## Recent exchange summary\n- No prior messages were recorded yet in the source conversation.`);
  }

  let brief = sections.join("\n\n");
  const limit = Math.max(400, Math.min(12000, Number(maxChars) || DEFAULT_MAX_CHARS));
  if (brief.length > limit) {
    brief = brief.slice(0, limit - 1).trimEnd() + "…";
  }

  return {
    title: nextContinuationTitle(title),
    summary: brief,
    sourceConversationId: conversation?.id || null,
    sourceTitle: title,
    sourceMessageCount: messages.length,
    projectId: project?.id || conversation?.projectId || null,
    projectName: project?.name || null
  };
}
