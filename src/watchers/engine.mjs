import net from "node:net";

export const WATCHER_KINDS = Object.freeze(["http_probe", "project_stall", "vram_threshold", "push_metric"]);
export const ATTENTION_TIERS = Object.freeze(["quiet_log", "digest", "notify", "urgent"]);
export const METRIC_OPERATORS = Object.freeze(["gt", "gte", "lt", "lte", "eq"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
  "100.100.100.200"
]);

function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Alibaba metadata
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateOrReservedIpv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 or hex form ::ffff:7f00:1)
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
  if (mappedMatch) return isPrivateOrReservedIpv4(mappedMatch[1]);
  if (lower.startsWith("::ffff:")) return true;
  return false;
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
  if (!rawHost) {
    return { valid: false, error: "Watcher URL must include a valid hostname." };
  }
  if (
    BLOCKED_HOSTNAMES.has(rawHost) ||
    rawHost.endsWith(".localhost") ||
    rawHost.endsWith(".local") ||
    rawHost.endsWith(".internal")
  ) {
    return { valid: false, error: "Local, link-local, and internal metadata hosts cannot be probed by HTTP watchers." };
  }
  const ipVersion = net.isIP(rawHost);
  if (ipVersion === 4 && isPrivateOrReservedIpv4(rawHost)) {
    return { valid: false, error: "Private, loopback, and reserved IPv4 addresses cannot be probed by HTTP watchers." };
  }
  if (ipVersion === 6 && isPrivateOrReservedIpv6(rawHost)) {
    return { valid: false, error: "Private, loopback, and reserved IPv6 addresses cannot be probed by HTTP watchers." };
  }
  return { valid: true, url: parsed.toString() };
}

function parseClockMinutes(clockStr) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(clockStr || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isWithinQuietHours(quietHours, nowDate = new Date()) {
  if (!quietHours || !quietHours.enabled) return false;
  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const date = nowDate instanceof Date ? nowDate : new Date(nowDate);
  if (Number.isNaN(date.getTime())) return false;
  const current = date.getUTCHours() * 60 + date.getUTCMinutes();
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
  fetchImpl = globalThis.fetch,
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
    const check = validateWatcherUrl(watcher.config?.url);
    if (!check.valid) {
      return {
        severity: "alert",
        trust: "external_untrusted",
        fingerprint: "http_probe:invalid_url",
        summary: sanitiseSummary(check.error),
        metrics: { ok: false, blocked: true }
      };
    }
    const expectedStatus = Math.max(100, Math.min(599, Number(watcher.config?.expectedStatus) || 200));
    const maxLatencyMs = Math.max(100, Math.min(10000, Number(watcher.config?.maxLatencyMs) || 3000));
    if (typeof fetchImpl !== "function") {
      return {
        severity: "alert",
        trust: "external_untrusted",
        fingerprint: "http_probe:no_fetch",
        summary: "Outbound HTTP probing is unavailable in this runtime.",
        metrics: { ok: false }
      };
    }
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(maxLatencyMs + 1000, 5000));
    try {
      const response = await fetchImpl(check.url, {
        method: "GET",
        headers: { accept: "application/json, text/plain, */*" },
        redirect: "error",
        signal: controller.signal
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
            ? `${check.url} responded HTTP ${response.status} in ${latencyMs} ms.`
            : `${check.url} returned HTTP ${response.status} in ${latencyMs} ms (expected ${expectedStatus} within ${maxLatencyMs} ms).`
        ),
        metrics: { status: response.status, expectedStatus, latencyMs, maxLatencyMs, ok }
      };
    } catch (error) {
      const latencyMs = Math.max(0, now() - started);
      return {
        severity: "alert",
        trust: "external_untrusted",
        fingerprint: "http:network_error",
        summary: sanitiseSummary(`Probe failed for ${check.url}: ${error?.name === "AbortError" ? "request timed out" : (error?.message || "network error")}.`),
        metrics: { ok: false, latencyMs }
      };
    } finally {
      clearTimeout(timer);
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
