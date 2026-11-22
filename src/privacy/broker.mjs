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

export function sanitizeForCloud(text, { customTerms = [] } = {}) {
  const original = String(text ?? "");
  const valueToToken = new Map();
  const tokenToValue = new Map();
  const counters = {};
  const redactions = [];

  function tokenFor(category, prefix, matchedValue) {
    const existing = valueToToken.get(matchedValue);
    if (existing) return existing;
    counters[prefix] = (counters[prefix] || 0) + 1;
    const token = `[${prefix}_${counters[prefix]}]`;
    valueToToken.set(matchedValue, token);
    tokenToValue.set(token, matchedValue);
    redactions.push({
      token,
      category,
      length: matchedValue.length
    });
    return token;
  }

  let sanitized = original;

  // 1. Apply user-defined private terms first (longest first to avoid partial collisions)
  const cleanTerms = Array.isArray(customTerms)
    ? customTerms
        .map((t) => String(t || "").trim())
        .filter((t) => t.length >= 3)
        .sort((a, b) => b.length - a.length)
        .slice(0, 40)
    : [];

  for (const term of cleanTerms) {
    const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    sanitized = sanitized.replace(regex, (match) => tokenFor("custom_private_term", "PRIVATE_TERM", match));
  }

  // 2. Apply deterministic structured entity patterns
  for (const rule of PATTERNS) {
    rule.regex.lastIndex = 0;
    sanitized = sanitized.replace(rule.regex, (match) => tokenFor(rule.category, rule.prefix, match));
  }

  const categoryCounts = {};
  for (const item of redactions) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  return {
    sanitizedText: sanitized,
    redactedCount: redactions.length,
    categoryCounts,
    redactions,
    tokenMap: Object.fromEntries(tokenToValue.entries()),
    safeToSend: true
  };
}

export function rehydrateFromCloud(cloudText, tokenMap = {}) {
  let output = String(cloudText ?? "");
  if (!tokenMap || typeof tokenMap !== "object") return output;
  const entries = Object.entries(tokenMap).sort((a, b) => b[0].length - a[0].length);
  for (const [token, originalValue] of entries) {
    if (!token || typeof originalValue !== "string") continue;
    // Never rehydrate secrets back into model output if someone tried to echo them?
    // Safe here because rehydration only restores the user's own local text in the local UI.
    output = output.split(token).join(originalValue);
  }
  return output;
}

export function sanitizeMessagesForCloud(messages = [], { customTerms = [] } = {}) {
  const combinedTokenMap = {};
  const allRedactions = [];
  const categoryCounts = {};

  const sanitizedMessages = (Array.isArray(messages) ? messages : []).map((msg) => {
    const result = sanitizeForCloud(msg?.content || "", { customTerms });
    Object.assign(combinedTokenMap, result.tokenMap);
    allRedactions.push(...result.redactions);
    for (const [cat, count] of Object.entries(result.categoryCounts)) {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + count;
    }
    return {
      ...msg,
      content: result.sanitizedText
    };
  });

  return {
    messages: sanitizedMessages,
    tokenMap: combinedTokenMap,
    manifest: {
      airlockActive: true,
      redactedCount: allRedactions.length,
      categoryCounts,
      redactions: allRedactions
    }
  };
}
