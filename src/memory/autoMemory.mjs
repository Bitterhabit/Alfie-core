const SENSITIVE_PATTERNS = [
  /\bsk-[a-z0-9_-]{12,}/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9]{16,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:my\s+)?(?:password|passphrase|api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|recovery[\s_-]?code|pin\s+code)\s*(?:is|:|=)\s*\S+/i,
  /\b[A-Z0-9_]*(?:PASSWORD|SECRET|API_KEY|TOKEN)\s*=\s*\S+/
];

const EPHEMERAL_PREFIX = /^(?:hey|hi|hello|thanks|thank you|ok|okay|sure|yes|no|cool|nice|great|can you|could you|would you|please\s+(?:write|fix|explain|tell|show|summarize|summarise|check|run|generate|create|help)|what|why|how|when|where|who)\b/i;

const PREFERENCE_HINT = /\b(?:prefer|like\s+(?:responses|answers|replies|it\s+when)|hate|dislike|always\s+(?:give|use|include|keep|format|reply|respond|answer|show)|never\s+(?:use|include|add|give)|keep\s+(?:your\s+)?(?:answers|responses|replies)|reply\s+in|answer\s+in|concise|brief|short|detailed|bullet|markdown|rollback|step[\s-]by[\s-]step|tone|style|call\s+me)\b/i;

const RULES = [
  {
    name: "explicit_remember",
    pattern: /^(?:please\s+)?(?:remember|don'?t\s+forget|keep\s+in\s+mind|note\s+down|save\s+(?:this|that)\s+to\s+memory)\s*(?:that\s+)?(.+)$/i,
    kind: (clause) => (PREFERENCE_HINT.test(clause) ? "preference" : "fact"),
    importance: 8,
    allowQuestionFallback: true,
    formatText: (match) => cleanSentence(match[1]),
    formatTitle: (text, kind) => buildTitle(kind === "preference" ? "Preference" : "Remembered", text)
  },
  {
    name: "response_preference",
    pattern: /^(?:i\s+(?:really\s+)?(?:prefer|like\s+responses\s+that|like\s+answers\s+that|like\s+it\s+when\s+you|want\s+you\s+to\s+always|dislike|hate\s+it\s+when)|always\s+(?:give\s+me|use|include|keep|format|reply|respond|answer|show)|never\s+(?:use|include|give\s+me)|keep\s+(?:your\s+)?(?:answers|responses|replies)\s+|please\s+(?:always\s+)?(?:reply|respond|answer)\s+(?:in|with))\s*(.+)$/i,
    kind: () => "preference",
    importance: 8,
    formatText: (match, sentence) => cleanSentence(sentence),
    formatTitle: (text) => buildTitle("Preference", text)
  },
  {
    name: "decision",
    pattern: /^(?:i(?:'ve|\s+have)?\s+decided\s+to|we(?:'ve|\s+have)?\s+decided\s+to|let'?s\s+(?:standardize|standardise|stick\s+with|go\s+with|commit\s+to))\s+(.+)$/i,
    kind: () => "decision",
    importance: 8,
    formatText: (match, sentence) => cleanSentence(sentence),
    formatTitle: (text) => buildTitle("Decision", text)
  },
  {
    name: "identity_or_name",
    pattern: /^(?:my\s+name\s+is|call\s+me|i\s+go\s+by)\s+([a-z][a-z0-9 .'-]{1,40})$/i,
    kind: () => "fact",
    importance: 9,
    formatText: (match) => `User prefers to be called ${cleanSentence(match[1])}.`,
    formatTitle: (text) => buildTitle("Name", text)
  },
  {
    name: "personal_fact",
    pattern: /^(?:i\s+(?:live\s+in|am\s+based\s+in|work\s+(?:as|at|on)|use|run|host|self-host|build\s+with|maintain)|my\s+(?:homelab|server|stack|gpu|pc|workstation|timezone|time\s+zone|os|editor|ide|primary\s+language|day\s+job|company|role|hardware)\s+(?:is|runs|uses|has))\s+(.+)$/i,
    kind: () => "fact",
    importance: 7,
    formatText: (match, sentence) => cleanSentence(sentence),
    formatTitle: (text) => buildTitle("Fact", text)
  }
];

function cleanSentence(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+/, "")
    .replace(/[\s]+$/, "")
    .slice(0, 360);
}

function buildTitle(prefix, text) {
  const clean = cleanSentence(text).replace(/[.!?]+$/, "");
  if (clean.length <= 72) return clean;
  return `${prefix}: ${clean.slice(0, 62).trim()}…`;
}

function slugTag(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function containsSensitiveMaterial(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(raw));
}

function splitCandidateClauses(userText) {
  const raw = String(userText || "").trim();
  if (!raw || raw.startsWith("/")) return [];
  // Drop fenced code blocks so pasted code snippets are never misread as personal facts.
  const withoutCode = raw.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCode) return [];
  return withoutCode
    .split(/(?:\r?\n|(?<=[.!])\s+)/)
    .map((part) => cleanSentence(part))
    .filter((part) => part.length >= 12 && part.length <= 360);
}

export function extractAutoMemories(userText, { projectName = null, maxItems = 2 } = {}) {
  const raw = String(userText || "").trim();
  if (!raw || raw.startsWith("/") || containsSensitiveMaterial(raw)) return [];

  const clauses = splitCandidateClauses(raw);
  const results = [];
  const seen = new Set();
  const projectTag = projectName ? slugTag(projectName) : "";

  for (const clause of clauses) {
    if (results.length >= maxItems) break;
    if (containsSensitiveMaterial(clause)) continue;

    const isQuestion = clause.endsWith("?");
    for (const rule of RULES) {
      if (isQuestion && !rule.allowQuestionFallback) continue;
      const match = rule.pattern.exec(clause);
      if (!match) continue;
      if (rule.name === "personal_fact" && EPHEMERAL_PREFIX.test(clause)) continue;

      const text = rule.formatText(match, clause);
      if (!text || text.length < 10) continue;
      if (containsSensitiveMaterial(text)) continue;

      const normKey = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!normKey || seen.has(normKey)) continue;
      seen.add(normKey);

      const kind = rule.kind(text);
      const title = rule.formatTitle(text, kind);
      const tags = ["auto-memory", kind, ...(projectTag ? [`project:${projectTag}`] : [])];

      results.push({
        title: title.slice(0, 120),
        text: text.slice(0, 400),
        kind,
        importance: rule.importance,
        tags
      });
      break;
    }
  }

  return results;
}

export const LEARNED_STYLE_TRAITS = Object.freeze([
  {
    key: "concise",
    label: "Concise replies",
    preferHint: "Prefer concise, direct answers without unnecessary padding.",
    avoidHint: "Avoid overly terse replies; include enough context to be self-contained."
  },
  {
    key: "detailed",
    label: "Thorough detail",
    preferHint: "Provide thorough, well-explained answers with deeper rationale and edge cases.",
    avoidHint: "Avoid long walls of text; keep replies tighter and easier to scan."
  },
  {
    key: "structured",
    label: "Structured headings & bullets",
    preferHint: "Organize answers with clear headings and scannable bullet points.",
    avoidHint: "Prefer natural prose paragraphs over heavy bulleted formatting when simple."
  },
  {
    key: "codeExamples",
    label: "Concrete code & commands",
    preferHint: "Include concrete code snippets or runnable commands when explaining technical topics.",
    avoidHint: "Keep code snippets minimal unless explicitly requested."
  },
  {
    key: "stepByStep",
    label: "Step-by-step walkthroughs",
    preferHint: "Present actionable procedures as clear numbered steps with verification points.",
    avoidHint: "Summarize outcomes directly instead of rigid numbered checklists."
  }
]);

const TRAIT_KEYS = LEARNED_STYLE_TRAITS.map((t) => t.key);

export const FEEDBACK_SENSITIVITIES = Object.freeze([
  { id: "gentle", label: "Gentle", step: 1, threshold: 2, description: "Requires repeated feedback (score ±2) before shaping replies." },
  { id: "balanced", label: "Balanced", step: 1, threshold: 1, description: "Adapts steadily from each thumbs-up or flag reaction." },
  { id: "responsive", label: "Responsive", step: 2, threshold: 1, description: "Adapts quickly with stronger weight per reaction." }
]);

const SENSITIVITY_MAP = new Map(FEEDBACK_SENSITIVITIES.map((item) => [item.id, item]));

export function resolveFeedbackSensitivity(value) {
  const key = String(value || "").trim().toLowerCase();
  return SENSITIVITY_MAP.get(key) || SENSITIVITY_MAP.get("balanced");
}

function makeSignalId(reaction, label, at, idx = 0) {
  const base = `${reaction}-${at || "t"}-${idx}-${String(label || "").slice(0, 16)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return base || `sig-${idx}`;
}

export function createDefaultLearnedStyle() {
  return {
    likes: 0,
    flags: 0,
    sensitivity: "balanced",
    traits: {
      concise: 0,
      detailed: 0,
      structured: 0,
      codeExamples: 0,
      stepByStep: 0
    },
    traitOverrides: {},
    recentSignals: []
  };
}

export function normaliseLearnedStyle(raw) {
  const base = createDefaultLearnedStyle();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  base.likes = Number.isFinite(Number(raw.likes)) ? Math.max(0, Math.round(Number(raw.likes))) : 0;
  base.flags = Number.isFinite(Number(raw.flags)) ? Math.max(0, Math.round(Number(raw.flags))) : 0;
  base.sensitivity = resolveFeedbackSensitivity(raw.sensitivity).id;
  for (const key of TRAIT_KEYS) {
    const val = Number(raw.traits?.[key]);
    base.traits[key] = Number.isFinite(val) ? Math.max(-10, Math.min(10, Math.round(val))) : 0;
    const rawOverride = raw.traitOverrides?.[key];
    if (typeof rawOverride === "string") {
      const cleaned = rawOverride.replace(/\s+/g, " ").trim().slice(0, 220);
      if (cleaned) base.traitOverrides[key] = cleaned;
    }
  }
  if (Array.isArray(raw.recentSignals)) {
    const seenIds = new Set();
    base.recentSignals = raw.recentSignals
      .filter((item) => item && typeof item === "object" && typeof item.label === "string")
      .slice(0, 12)
      .map((item, idx) => {
        const reaction = item.reaction === "flag" ? "flag" : "like";
        const label = String(item.label).trim().slice(0, 80);
        const at = typeof item.at === "string" ? item.at.slice(0, 40) : "";
        let id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id)
          ? item.id
          : makeSignalId(reaction, label, at, idx);
        while (seenIds.has(id)) id = `${id.slice(0, 58)}-${idx}`;
        seenIds.add(id);
        return { id, reaction, label, at };
      })
      .filter((item) => item.label);
  }
  return base;
}

export function analyzeResponseStyle(content) {
  const text = String(content || "").trim();
  if (!text) return [];
  const traits = [];
  if (text.length <= 480) {
    traits.push("concise");
  } else if (text.length >= 1050) {
    traits.push("detailed");
  }
  const hasHeadings = /^#{1,4}\s+\S/m.test(text);
  const bulletCount = (text.match(/^\s*(?:[-*•]|\d+\.)\s+\S/gm) || []).length;
  if (hasHeadings || bulletCount >= 3) {
    traits.push("structured");
  }
  const hasFencedCode = /```[\s\S]*?```/.test(text);
  const inlineCodeCount = (text.match(/`[^`\n]{2,}`/g) || []).length;
  if (hasFencedCode || inlineCodeCount >= 2) {
    traits.push("codeExamples");
  }
  const numberedSteps = (text.match(/^\s*\d+\.\s+\S/gm) || []).length;
  if (numberedSteps >= 2 || /\b(?:step\s*1|rollback|verify)\b/i.test(text)) {
    traits.push("stepByStep");
  }
  return [...new Set(traits)];
}

function reactionWeight(reaction) {
  if (reaction === "like") return 1;
  if (reaction === "flag") return -1;
  return 0;
}

export function applyReactionDelta(currentStyle, { reaction = null, previousReaction = null, content = "", nowIso = new Date().toISOString() } = {}) {
  const next = normaliseLearnedStyle(currentStyle);
  const prevW = reactionWeight(previousReaction);
  const nextW = reactionWeight(reaction);
  if (prevW === nextW) {
    return { learnedStyle: next, detectedTraits: [], signals: [] };
  }

  if (previousReaction === "like" && next.likes > 0) next.likes -= 1;
  if (previousReaction === "flag" && next.flags > 0) next.flags -= 1;
  if (reaction === "like") next.likes += 1;
  if (reaction === "flag") next.flags += 1;

  const detectedTraits = analyzeResponseStyle(content);
  const sensitivityConfig = resolveFeedbackSensitivity(next.sensitivity);
  const delta = (nextW - prevW) * sensitivityConfig.step;
  for (const key of detectedTraits) {
    if (key in next.traits) {
      next.traits[key] = Math.max(-10, Math.min(10, next.traits[key] + delta));
    }
  }

  const labelMap = Object.fromEntries(LEARNED_STYLE_TRAITS.map((t) => [t.key, t.label]));
  const signals = detectedTraits.map((key) => labelMap[key]).filter(Boolean);

  if (reaction && signals.length) {
    const label = `${reaction === "like" ? "Liked" : "Flagged"}: ${signals.slice(0, 3).join(", ")}`;
    const id = `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    next.recentSignals = [{ id, reaction, label, at: nowIso }, ...next.recentSignals].slice(0, 12);
  }

  return { learnedStyle: next, detectedTraits, signals };
}

export function summarizeLearnedStyle(learnedStyle) {
  const safe = normaliseLearnedStyle(learnedStyle);
  const sensitivityConfig = resolveFeedbackSensitivity(safe.sensitivity);
  const threshold = sensitivityConfig.threshold;
  const chips = [];
  const promptHints = [];
  const preferences = [];

  for (const trait of LEARNED_STYLE_TRAITS) {
    const score = safe.traits[trait.key] || 0;
    const customHint = safe.traitOverrides?.[trait.key] || "";
    const direction = score > 0 ? "prefer" : score < 0 ? "avoid" : "neutral";
    const defaultHint = score < 0 ? trait.avoidHint : trait.preferHint;
    const effectiveHint = customHint || defaultHint;
    const active = Math.abs(score) >= threshold;

    preferences.push({
      key: trait.key,
      label: trait.label,
      score,
      direction,
      active,
      defaultHint,
      customHint,
      effectiveHint
    });

    if (score >= threshold) {
      chips.push({ key: trait.key, label: trait.label, score, direction: "prefer", customHint });
      promptHints.push(effectiveHint);
    } else if (score <= -threshold) {
      chips.push({ key: trait.key, label: `Less ${trait.label.toLowerCase()}`, score, direction: "avoid", customHint });
      promptHints.push(effectiveHint);
    }
  }

  // Resolve opposite concise/detailed signals so the stronger direction wins cleanly.
  if (safe.traits.concise >= threshold && safe.traits.detailed >= threshold) {
    const conciseHint = safe.traitOverrides?.concise || LEARNED_STYLE_TRAITS[0].preferHint;
    const detailedHint = safe.traitOverrides?.detailed || LEARNED_STYLE_TRAITS[1].preferHint;
    if (safe.traits.concise >= safe.traits.detailed) {
      const idx = promptHints.indexOf(detailedHint);
      if (idx >= 0) promptHints.splice(idx, 1);
    } else {
      const idx = promptHints.indexOf(conciseHint);
      if (idx >= 0) promptHints.splice(idx, 1);
    }
  }

  chips.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  return {
    likes: safe.likes,
    flags: safe.flags,
    sensitivity: safe.sensitivity,
    threshold,
    chips,
    preferences,
    promptHints: promptHints.slice(0, 4),
    recentSignals: safe.recentSignals
  };
}
