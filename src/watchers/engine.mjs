import net from "node:net";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

export const WATCHER_KINDS = Object.freeze(["http_probe", "project_stall", "vram_threshold", "push_metric"]);
export const ATTENTION_TIERS = Object.freeze(["quiet_log", "digest", "notify", "urgent"]);
export const METRIC_OPERATORS = Object.freeze(["gt", "gte", "lt", "lte", "eq"]);
export const DEFAULT_QUIET_HOURS_TIMEZONE = "UTC";

const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const IANA_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

const SUPPORTED_TIMEZONES = (() => {
  const zones = new Set(["UTC", "Etc/UTC", "Etc/GMT"]);
  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    try {
      for (const tz of Intl.supportedValuesOf("timeZone")) {
        zones.add(tz);
      }
    } catch {
      // Fall back to runtime Intl.DateTimeFormat validation below.
    }
  }
  return zones;
})();

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc",
  "169.254.169.254",
  "100.100.100.200"
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
  ".corp",
  ".intranet",
  ".docker",
  ".svc",
  ".cluster.local"
];

export function isPrivateOrReservedIpv4(ip) {
  if (typeof ip !== "string") return true;
  const parts = ip.split(".").map((n) => (n === "" || !/^\d+$/.test(n) ? NaN : Number(n)));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 unspecified ("this network")
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Alibaba metadata
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved / broadcast
  return false;
}

function parseIpv6ToGroups(ip) {
  if (typeof ip !== "string") return null;
  let candidate = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!candidate || candidate.includes("%")) return null; // Reject zone IDs (e.g. fe80::1%eth0)

  // Handle embedded IPv4 dotted-quad suffix (e.g. ::ffff:127.0.0.1, 0:0:0:0:0:ffff:10.0.0.1)
  if (candidate.includes(".")) {
    const lastColon = candidate.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Part = candidate.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    candidate = `${candidate.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = candidate.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(":") : [];

  let parts;
  if (doubleColonParts.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    parts = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    if (left.length !== 8) return null;
    parts = left;
  }

  if (parts.length !== 8) return null;
  const groups = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

export function isPrivateOrReservedIpv6(ip) {
  const groups = parseIpv6ToGroups(ip);
  if (!groups) return true; // Fail closed on malformed IPv6 or zone identifiers

  const [g0, g1, g2, g3, g4, g5] = groups;

  // Unspecified (::) and loopback (::1) and deprecated IPv4-compatible (::/96)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // IPv4-mapped IPv6 (::ffff:0:0/96) — non-global transition prefix, always blocked
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return true;
  // IPv4-translated IPv6 (::ffff:0:0:0/96)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
  if (g0 === 0x0064 && g1 === 0xff9b) return true;
  // Link-local (fe80::/10) and deprecated site-local (fec0::/10)
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  // Unique local addresses (fc00::/7)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Multicast (ff00::/8)
  if ((g0 & 0xff00) === 0xff00) return true;

  // Fail closed: allow ONLY IANA Global Unicast (2000::/3), excluding special-purpose sub-ranges
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && g1 === 0x0000) return true; // Teredo (2001::/32)
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0x0000) return true; // Benchmarking (2001:2::/48)
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true; // ORCHID (2001:10::/28)
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return true; // ORCHIDv2 (2001:20::/28)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // Documentation (2001:db8::/32)
  if (g0 === 0x2002) return true; // Deprecated 6to4 (2002::/16)
  if (g0 === 0x3fff && (g1 & 0xf000) === 0x0000) return true; // RFC 9637 Documentation (3fff::/20)

  return false;
}

export function isPrivateOrReservedIp(ip) {
  if (typeof ip !== "string") return true;
  const cleaned = ip.trim().replace(/^\[|\]$/g, "");
  const version = net.isIP(cleaned);
  if (version === 4) return isPrivateOrReservedIpv4(cleaned);
  if (version === 6) return isPrivateOrReservedIpv6(cleaned);
  return true; // Fail closed on unrecognised address formats
}

export function validateWatcherUrl(rawUrl) {
  const candidate = String(rawUrl || "").trim();
  if (!candidate || candidate.length > 1024) {
    return { valid: false, error: "Provide a valid http:// or https:// endpoint URL." };
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, error: "Provide a valid http:// or https:// endpoint URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: "Only http:// and https:// endpoints are allowed for HTTP probes." };
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return { valid: false, error: "Watcher URLs cannot contain embedded credentials or URL fragments." };
  }
  const rawHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const hostNoTrailingDot = rawHost.replace(/\.+$/, "");
  if (!hostNoTrailingDot) {
    return { valid: false, error: "Watcher URL must include a valid hostname." };
  }
  if (
    BLOCKED_HOSTNAMES.has(hostNoTrailingDot) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostNoTrailingDot.endsWith(suffix))
  ) {
    return { valid: false, error: "Local, link-local, and internal metadata hosts cannot be probed by HTTP watchers." };
  }
  const ipVersion = net.isIP(hostNoTrailingDot);
  if (ipVersion === 4) {
    if (isPrivateOrReservedIpv4(hostNoTrailingDot)) {
      return { valid: false, error: "Private, loopback, and reserved IPv4 addresses cannot be probed by HTTP watchers." };
    }
    return { valid: true, url: parsed.toString(), parsed };
  }
  if (ipVersion === 6) {
    if (isPrivateOrReservedIpv6(hostNoTrailingDot)) {
      return { valid: false, error: "Private, loopback, and reserved IPv6 addresses cannot be probed by HTTP watchers." };
    }
    return { valid: true, url: parsed.toString(), parsed };
  }
  // Reject single-label hostnames (e.g. Docker/Kubernetes service names like "redis" or "alfie-core")
  if (!hostNoTrailingDot.includes(".")) {
    return { valid: false, error: "Single-label internal hostnames cannot be probed by HTTP watchers." };
  }
  return { valid: true, url: parsed.toString(), parsed };
}

/**
 * Resolves a validated watcher URL's hostname to all IPv4 and IPv6 addresses
 * and fails closed if DNS fails, returns zero addresses, or if ANY resolved
 * address is private, loopback, link-local, multicast, metadata, or non-public.
 */
export async function resolveAndValidateWatcherTarget(rawUrl, { dnsLookup = dns.lookup } = {}) {
  const urlCheck = validateWatcherUrl(rawUrl);
  if (!urlCheck.valid) {
    return { valid: false, code: "WATCHER_URL_BLOCKED", error: urlCheck.error };
  }
  const parsed = urlCheck.parsed;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const literalVersion = net.isIP(hostname);
  if (literalVersion === 4 || literalVersion === 6) {
    if (isPrivateOrReservedIp(hostname)) {
      return { valid: false, code: "WATCHER_IP_BLOCKED", error: "Target IP address is private, loopback, or non-public." };
    }
    const pinned = { address: hostname, family: literalVersion };
    return { valid: true, url: urlCheck.url, parsed, addresses: [pinned], pinned };
  }

  if (typeof dnsLookup !== "function") {
    return { valid: false, code: "WATCHER_DNS_UNAVAILABLE", error: "DNS validation is unavailable in this runtime." };
  }

  let records;
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    return {
      valid: false,
      code: "WATCHER_DNS_FAILED",
      error: `DNS resolution failed for ${hostname}: ${sanitiseSummary(error?.code || error?.message || "lookup error", 120)}.`
    };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, code: "WATCHER_DNS_EMPTY", error: `DNS resolution returned no addresses for ${hostname}.` };
  }

  const seen = new Set();
  const validated = [];
  for (const entry of records) {
    const address = typeof entry === "string" ? entry.trim() : String(entry?.address || "").trim();
    const cleaned = address.replace(/^\[|\]$/g, "");
    const detectedFamily = net.isIP(cleaned);
    if (!detectedFamily) {
      return {
        valid: false,
        code: "WATCHER_DNS_INVALID_IP",
        error: `DNS resolution returned an invalid IP address for ${hostname}.`
      };
    }
    if (isPrivateOrReservedIp(cleaned)) {
      return {
        valid: false,
        code: "WATCHER_DNS_BLOCKED",
        error: `Resolved address for ${hostname} is private, loopback, link-local, or non-public.`
      };
    }
    const key = `${detectedFamily}:${cleaned}`;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push({ address: cleaned, family: detectedFamily });
    }
  }

  if (!validated.length) {
    return { valid: false, code: "WATCHER_DNS_EMPTY", error: `DNS resolution returned no usable public addresses for ${hostname}.` };
  }

  // Prefer first validated IPv4, else first validated IPv6
  const pinned = validated.find((item) => item.family === 4) || validated[0];
  return { valid: true, url: urlCheck.url, parsed, addresses: validated, pinned };
}

/**
 * Performs an HTTP or HTTPS GET probe pinned directly to an already-validated
 * { address, family } via a custom lookup function so no second DNS resolution
 * can occur (preventing DNS rebinding). Preserves Host header, HTTPS SNI,
 * TLS certificate/hostname verification, strict redirect rejection, timeout,
 * and bounded response handling.
 */
export function pinnedHttpProbe(parsedUrl, pinned, {
  timeoutMs = 5000,
  maxBytes = MAX_PROBE_RESPONSE_BYTES,
  requestImpl = null,
  tlsOptions = null
} = {}) {
  return new Promise((resolve, reject) => {
    if (!parsedUrl || !pinned || !pinned.address || (pinned.family !== 4 && pinned.family !== 6)) {
      reject(Object.assign(new Error("Invalid pinned probe target."), { code: "WATCHER_PIN_INVALID" }));
      return;
    }

    const isHttps = parsedUrl.protocol === "https:";
    const transport = typeof requestImpl === "function"
      ? requestImpl
      : (isHttps ? https.request : http.request);

    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
    const port = parsedUrl.port ? Number(parsedUrl.port) : (isHttps ? 443 : 80);
    const requestPath = (parsedUrl.pathname || "/") + (parsedUrl.search || "");

    const pinnedLookup = (_host, opts, cb) => {
      const callback = typeof opts === "function" ? opts : cb;
      const returnAll = typeof opts === "object" && opts !== null && Boolean(opts.all);
      process.nextTick(() => {
        if (returnAll) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      });
    };

    const reqOptions = {
      protocol: parsedUrl.protocol,
      hostname,
      port,
      path: requestPath,
      method: "GET",
      headers: {
        host: parsedUrl.host,
        accept: "application/json, text/plain, */*",
        "user-agent": "Alfie-Core-Watcher/0.3"
      },
      agent: false,
      lookup: pinnedLookup
    };

    if (isHttps) {
      if (tlsOptions && typeof tlsOptions === "object") {
        Object.assign(reqOptions, tlsOptions);
      }
      // Enforce TLS SNI and strict certificate/hostname verification (never override to false)
      reqOptions.rejectUnauthorized = true;
      if (!net.isIP(hostname)) {
        reqOptions.servername = hostname;
      }
    }

    let settled = false;
    let req;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      const err = Object.assign(new Error("request timed out"), { name: "AbortError", code: "WATCHER_TIMEOUT" });
      if (req) req.destroy(err);
      finish(err);
    }, Math.max(100, Number(timeoutMs) || 5000));

    try {
      req = transport(reqOptions, (res) => {
        const status = Number(res.statusCode || 0);
        if (status >= 300 && status < 400) {
          res.destroy();
          finish(Object.assign(
            new Error(`Redirects are not allowed for HTTP watcher probes (received HTTP ${status}).`),
            { code: "WATCHER_REDIRECT_BLOCKED", statusCode: status }
          ));
          return;
        }

        let bytesRead = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          bytesRead += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          if (bytesRead > maxBytes) {
            truncated = true;
            res.destroy();
            finish(null, { status, bytesRead: maxBytes, truncated, pinnedAddress: pinned.address });
          }
        });
        res.on("end", () => {
          finish(null, { status, bytesRead, truncated, pinnedAddress: pinned.address });
        });
        res.on("close", () => {
          finish(null, { status, bytesRead: Math.min(bytesRead, maxBytes), truncated, pinnedAddress: pinned.address });
        });
        res.on("error", (err) => {
          if (truncated) {
            finish(null, { status, bytesRead: maxBytes, truncated, pinnedAddress: pinned.address });
          } else {
            finish(err);
          }
        });
      });

      req.on("error", (err) => finish(err));
      req.end();
    } catch (err) {
      finish(err);
    }
  });
}

export function validateTimeZone(value) {
  if (typeof value !== "string") {
    return { valid: false, error: "Quiet hours timezone must be a valid IANA timezone string (e.g. 'UTC', 'Europe/London')." };
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || !IANA_TIMEZONE_PATTERN.test(trimmed)) {
    return { valid: false, error: `Invalid IANA timezone identifier: "${trimmed.slice(0, 40)}".` };
  }
  if (!SUPPORTED_TIMEZONES.has(trimmed)) {
    return { valid: false, error: `Unsupported or unknown IANA timezone identifier: "${trimmed}".` };
  }
  try {
    // Double-check with Intl.DateTimeFormat to confirm full runtime ICU support
    new Intl.DateTimeFormat("en-GB", { timeZone: trimmed });
  } catch {
    return { valid: false, error: `Unsupported IANA timezone identifier: "${trimmed}".` };
  }
  return { valid: true, timeZone: trimmed };
}

function parseClockMinutes(clockStr) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(clockStr || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getLocalClockMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  if (hour === 24) hour = 0; // Normalize ICU midnight "24:00" representation
  return hour * 60 + minute;
}

export function isWithinQuietHours(quietHours, nowDate = new Date()) {
  if (!quietHours || !quietHours.enabled) return false;
  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const date = nowDate instanceof Date ? nowDate : new Date(nowDate);
  if (Number.isNaN(date.getTime())) return false;

  const tzCandidate = quietHours.timezone === undefined || quietHours.timezone === null || quietHours.timezone === ""
    ? DEFAULT_QUIET_HOURS_TIMEZONE
    : quietHours.timezone;
  const tzCheck = validateTimeZone(tzCandidate);
  if (!tzCheck.valid) return false;

  const current = getLocalClockMinutes(date, tzCheck.timeZone);
  if (start < end) {
    return current >= start && current < end;
  }
  // Overnight window (e.g. 22:00 -> 07:00)
  return current >= start || current < end;
}

/**
 * Deterministic 4-Tier Attention Budget router (ADR-002).
 * Tiers: quiet_log | digest | notify | urgent
 */
export function routeAttentionTier({
  baseTier = "notify",
  severity = "alert",
  quietHours = null,
  nowMs = Date.now(),
  lastNotifiedAt = null,
  cooldownMinutes = 30,
  sameFingerprint = false
} = {}) {
  const safeBase = ATTENTION_TIERS.includes(baseTier) ? baseTier : "notify";

  if (severity === "ok") {
    return { tier: "quiet_log", suppressed: false, reason: "nominal" };
  }

  // Cooldown deduplication suppresses repeated alerts with identical fingerprint
  const cooldownMs = Math.max(0, Number(cooldownMinutes) || 0) * 60 * 1000;
  if (sameFingerprint && lastNotifiedAt && cooldownMs > 0) {
    const lastMs = Date.parse(String(lastNotifiedAt));
    if (Number.isFinite(lastMs) && (nowMs - lastMs) < cooldownMs) {
      return { tier: "quiet_log", suppressed: true, reason: "cooldown_dedup" };
    }
  }

  // Quiet hours downgrade non-urgent notifications to digest; urgent breaks through
  if (safeBase === "notify" && isWithinQuietHours(quietHours, new Date(nowMs))) {
    return { tier: "digest", suppressed: false, reason: "quiet_hours_downgrade" };
  }

  return { tier: safeBase, suppressed: false, reason: "threshold_triggered" };
}

export function compareMetric(value, operator, threshold) {
  const num = Number(value);
  const limit = Number(threshold);
  if (!Number.isFinite(num) || !Number.isFinite(limit)) return false;
  switch (operator) {
    case "gt": return num > limit;
    case "gte": return num >= limit;
    case "lt": return num < limit;
    case "lte": return num <= limit;
    case "eq": return num === limit;
    default: return num >= limit;
  }
}

export function sanitiseSummary(text, max = 320) {
  return String(text || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Evaluates a watcher deterministically (zero LLM calls).
 * Every external-sourced reading is explicitly stamped with trust: "external_untrusted" (ADR-003).
 */
export async function evaluateWatcher(watcher, {
  userId,
  projectStore = null,
  vramMonitor = null,
  endpoints = [],
  dnsLookup = dns.lookup,
  requestImpl = null,
  tlsOptions = null,
  now = () => Date.now()
} = {}) {
  const nowMs = now();
  const kind = watcher.kind;

  if (kind === "project_stall") {
    const staleDays = Math.max(1, Math.min(90, Number(watcher.config?.staleDays) || 7));
    const targetProjectId = watcher.config?.projectId || null;
    const projects = projectStore ? await projectStore.list(userId) : [];
    const active = projects.filter((p) => {
      if (targetProjectId && p.id !== targetProjectId) return false;
      return (p.status || "active") === "active";
    });
    if (!active.length) {
      return {
        severity: "ok",
        trust: "system_verified",
        fingerprint: "project_stall:none",
        summary: targetProjectId ? "Target project is not currently active." : "No active projects to monitor.",
        metrics: { checkedProjects: 0, stalledCount: 0, blockedCount: 0 }
      };
    }
    const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
    const stalled = [];
    const blocked = [];
    for (const p of active) {
      const updatedMs = Date.parse(p.updatedAt || p.createdAt || "");
      const ageMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : 0;
      if (ageMs >= thresholdMs) {
        stalled.push({ id: p.id, name: p.name, days: Math.floor(ageMs / (24 * 60 * 60 * 1000)) });
      }
      if (Array.isArray(p.blockers) && p.blockers.length > 0) {
        blocked.push({ id: p.id, name: p.name, count: p.blockers.length });
      }
    }
    if (stalled.length || blocked.length) {
      const parts = [];
      if (stalled.length) parts.push(`${stalled.length} stalled (${stalled.map((s) => `${s.name} · ${s.days}d`).join(", ")})`);
      if (blocked.length) parts.push(`${blocked.length} with blockers (${blocked.map((b) => `${b.name} · ${b.count}`).join(", ")})`);
      return {
        severity: "alert",
        trust: "system_verified",
        fingerprint: `project_stall:${stalled.map((s) => s.id).join(",")}:${blocked.map((b) => `${b.id}=${b.count}`).join(",")}`,
        summary: sanitiseSummary(`Project attention needed: ${parts.join("; ")}.`),
        metrics: { checkedProjects: active.length, stalledCount: stalled.length, blockedCount: blocked.length }
      };
    }
    return {
      severity: "ok",
      trust: "system_verified",
      fingerprint: "project_stall:ok",
      summary: `Checked ${active.length} active project(s) — all updated within ${staleDays}d with zero blockers.`,
      metrics: { checkedProjects: active.length, stalledCount: 0, blockedCount: 0 }
    };
  }

  if (kind === "vram_threshold") {
    const thresholdPercent = Math.max(50, Math.min(99, Number(watcher.config?.thresholdPercent) || 80));
    const status = vramMonitor ? await vramMonitor.inspect({ userId, endpoints }) : { available: false, percent: null };
    if (!status.available || status.percent === null) {
      return {
        severity: "ok",
        trust: "system_verified",
        fingerprint: "vram:unavailable",
        summary: "No active GPU VRAM telemetry reading available yet.",
        metrics: { available: false, thresholdPercent }
      };
    }
    const triggered = Number(status.percent) >= thresholdPercent;
    return {
      severity: triggered ? "alert" : "ok",
      trust: "system_verified",
      fingerprint: triggered ? `vram:high:${Math.floor(status.percent / 5) * 5}` : "vram:ok",
      summary: sanitiseSummary(
        triggered
          ? `GPU VRAM reached ${status.percent}% on ${status.gpuName || "GPU"} (threshold ${thresholdPercent}%).`
          : `GPU VRAM nominal at ${status.percent}% on ${status.gpuName || "GPU"} (threshold ${thresholdPercent}%).`
      ),
      metrics: { available: true, percent: status.percent, thresholdPercent, gpuName: status.gpuName || null }
    };
  }

  if (kind === "http_probe") {
    const target = await resolveAndValidateWatcherTarget(watcher.config?.url, { dnsLookup });
    if (!target.valid) {
      return {
        severity: "alert",
        trust: "external_untrusted",
        fingerprint: `http_probe:${String(target.code || "blocked").toLowerCase()}`,
        summary: sanitiseSummary(target.error),
        metrics: { ok: false, blocked: true, code: target.code || "WATCHER_URL_BLOCKED" }
      };
    }

    const expectedStatus = Math.max(100, Math.min(599, Number(watcher.config?.expectedStatus) || 200));
    const maxLatencyMs = Math.max(100, Math.min(10000, Number(watcher.config?.maxLatencyMs) || 3000));
    const timeoutMs = Math.min(maxLatencyMs + 1000, 5000);
    const started = now();

    try {
      const response = await pinnedHttpProbe(target.parsed, target.pinned, {
        timeoutMs,
        maxBytes: MAX_PROBE_RESPONSE_BYTES,
        requestImpl,
        tlsOptions
      });
      const latencyMs = Math.max(0, now() - started);
      const statusOk = response.status === expectedStatus;
      const latencyOk = latencyMs <= maxLatencyMs;
      const ok = statusOk && latencyOk;
      return {
        severity: ok ? "ok" : "alert",
        trust: "external_untrusted",
        fingerprint: ok ? `http:ok:${response.status}` : `http:alert:${response.status}:${latencyOk ? "status" : "slow"}`,
        summary: sanitiseSummary(
          ok
            ? `${target.url} responded HTTP ${response.status} in ${latencyMs} ms.`
            : `${target.url} returned HTTP ${response.status} in ${latencyMs} ms (expected ${expectedStatus} within ${maxLatencyMs} ms).`
        ),
        metrics: {
          status: response.status,
          expectedStatus,
          latencyMs,
          maxLatencyMs,
          pinnedAddress: response.pinnedAddress,
          ok
        }
      };
    } catch (error) {
      const latencyMs = Math.max(0, now() - started);
      const isRedirect = error?.code === "WATCHER_REDIRECT_BLOCKED";
      return {
        severity: "alert",
        trust: "external_untrusted",
        fingerprint: isRedirect ? "http:redirect_blocked" : "http:network_error",
        summary: sanitiseSummary(
          isRedirect
            ? error.message
            : `Probe failed for ${target.url}: ${error?.name === "AbortError" ? "request timed out" : (error?.message || "network error")}.`
        ),
        metrics: {
          ok: false,
          blocked: isRedirect,
          code: error?.code || "WATCHER_NETWORK_ERROR",
          latencyMs
        }
      };
    }
  }

  if (kind === "push_metric") {
    const lastValue = watcher.lastMetrics?.value;
    if (lastValue === undefined || lastValue === null) {
      return {
        severity: "ok",
        trust: "external_untrusted",
        fingerprint: "push_metric:awaiting",
        summary: `Awaiting pushed readings for ${watcher.config?.metricName || "metric"}.`,
        metrics: { awaiting: true }
      };
    }
    return evaluatePushMetricReading(watcher, {
      value: lastValue,
      note: watcher.lastMetrics?.note || ""
    });
  }

  return {
    severity: "ok",
    trust: "system_verified",
    fingerprint: "unknown",
    summary: "Unsupported watcher kind.",
    metrics: {}
  };
}

export function evaluatePushMetricReading(watcher, reading = {}) {
  const value = Number(reading.value);
  if (!Number.isFinite(value)) {
    throw Object.assign(new Error("Metric reading requires a finite numeric value."), { status: 400 });
  }
  const metricName = sanitiseSummary(watcher.config?.metricName || "metric", 64);
  const operator = METRIC_OPERATORS.includes(watcher.config?.operator) ? watcher.config.operator : "gte";
  const threshold = Number(watcher.config?.threshold ?? 80);
  const unit = sanitiseSummary(watcher.config?.unit || "", 16);
  const note = sanitiseSummary(reading.note || "", 160);
  const triggered = compareMetric(value, operator, threshold);
  const unitSuffix = unit ? ` ${unit}` : "";
  return {
    severity: triggered ? "alert" : "ok",
    // ADR-003: external push payloads are always untrusted data
    trust: "external_untrusted",
    fingerprint: triggered ? `push:${metricName}:alert:${operator}:${threshold}` : `push:${metricName}:ok`,
    summary: sanitiseSummary(
      triggered
        ? `${metricName} reported ${value}${unitSuffix} (crossed ${operator} ${threshold}${unitSuffix})${note ? ` — ${note}` : ""}.`
        : `${metricName} nominal at ${value}${unitSuffix} (threshold ${operator} ${threshold}${unitSuffix}).`
    ),
    metrics: { metricName, value, operator, threshold, unit, triggered, note }
  };
}
