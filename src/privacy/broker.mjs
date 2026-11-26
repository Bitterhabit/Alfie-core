/**
 * Split-Brain Privacy Broker (Phase 4)
 *
 * Local deterministic sanitization airlock allowing external cloud models to
 * assist on technical/coding tasks adjacent to private context without leaking
 * personal details, secrets, private LAN addresses, or user-defined private terms.
 *
 * Reversible session-scoped tokens ([EMAIL_1], [PRIVATE_IP_1], [SECRET_1], ...)
 * are replaced locally on outbound prompts and restored locally on inbound replies.
 */

const PATTERNS = Object.freeze([
  {
    category: "secret",
    prefix: "SECRET",
    regex: /\b(?:sk-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AIza[0-9A-Za-z_-]{25,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}=*)\b/g
  },
  {
    category: "email",
    prefix: "EMAIL",
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g
  },
  {
    category: "private_ip",
    prefix: "PRIVATE_IP",
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
  },
  {
    category: "local_host",
    prefix: "LOCAL_HOST",
    regex: /\b[a-zA-Z0-9-]+\.(?:local|lan|home\.arpa|internal|proxmox)\b/gi
  },
  {
    category: "local_path",
    prefix: "LOCAL_PATH",
    regex: /(?:\/(?:home|Users|root|etc|var\/lib|mnt|srv)\/[^\s"'`,;)]+|[A-Za-z]:\\Users\\[^\s"'`,;)]+)/g
  },
  {
    category: "phone",
    prefix: "PHONE",
    regex: /(?<!\w)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}(?!\w)/g
  }
]);

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSanitizerState() {
  return {
    valueToToken: new Map(),
    tokenToValue: new Map(),
    counters: {},
    redactions: []
  };
}

export function sanitizeForCloud(text, { customTerms = [], state = null } = {}) {
  const original = String(text ?? "");
  const shared = state || createSanitizerState();
  const redactionStart = shared.redactions.length;

  function tokenFor(category, prefix, matchedValue) {
    const existing = shared.valueToToken.get(matchedValue);
    if (existing) return existing;
    shared.counters[prefix] = (shared.counters[prefix] || 0) + 1;
    const token = `[${prefix}_${shared.counters[prefix]}]`;
    shared.valueToToken.set(matchedValue, token);
    shared.tokenToValue.set(token, matchedValue);
    shared.redactions.push({ token, category, length: matchedValue.length });
    return token;
  }

  let sanitized = original;
  const cleanTerms = Array.isArray(customTerms)
    ? customTerms
        .map((term) => String(term || "").trim())
        .filter((term) => term.length >= 3)
        .sort((a, b) => b.length - a.length)
        .slice(0, 40)
    : [];

  for (const term of cleanTerms) {
    const regex = new RegExp(`\\\\b${escapeRegExp(term)}\\\\b`, "gi");
    sanitized = sanitized.replace(regex, (match) => tokenFor("custom_private_term", "PRIVATE_TERM", match));
  }

  for (const rule of PATTERNS) {
    rule.regex.lastIndex = 0;
    sanitized = sanitized.replace(rule.regex, (match) => tokenFor(rule.category, rule.prefix, match));
  }

  const redactions = shared.redactions.slice(redactionStart);
  const categoryCounts = {};
  for (const item of redactions) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  return {
    sanitizedText: sanitized,
    redactedCount: redactions.length,
    categoryCounts,
    redactions,
    tokenMap: Object.fromEntries(shared.tokenToValue.entries()),
    safeToSend: true
  };
}

export function rehydrateFromCloud(cloudText, tokenMap = {}) {
  let output = String(cloudText ?? "");
  if (!tokenMap || typeof tokenMap !== "object") return output;
  const entries = Object.entries(tokenMap).sort((a, b) => b[0].length - a[0].length);
  for (const [token, originalValue] of entries) {
    if (!token || typeof originalValue !== "string") continue;
    output = output.split(token).join(originalValue);
  }
  return output;
}

export function sanitizeMessagesForCloud(messages = [], { customTerms = [] } = {}) {
  const state = createSanitizerState();
  const sanitizedMessages = (Array.isArray(messages) ? messages : []).map((message) => {
    const result = sanitizeForCloud(message?.content || "", { customTerms, state });
    return { ...message, content: result.sanitizedText };
  });

  const categoryCounts = {};
  for (const item of state.redactions) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  return {
    messages: sanitizedMessages,
    tokenMap: Object.fromEntries(state.tokenToValue.entries()),
    manifest: {
      airlockActive: true,
      redactedCount: state.redactions.length,
      categoryCounts,
      redactions: state.redactions
    }
  };
}
