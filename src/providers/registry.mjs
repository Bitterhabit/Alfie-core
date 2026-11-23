import net from "node:net";
import dns from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  isPrivateOrReservedIp
} from "../watchers/engine.mjs";

export const DEFAULT_PROVIDER_CHAT_TIMEOUT_MS = 30 * 60 * 1000;
const MODES = new Set(["auto", "light", "standard", "work"]);
const ENDPOINT_MODES = new Set(["light", "standard", "work"]);

// Always-prohibited hosts (cloud metadata endpoints & unspecified addresses),
// blocked unconditionally even when trustedLocal is enabled.
const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254"
]);

const LOCAL_OR_PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc"
]);

const LOCAL_OR_PRIVATE_SUFFIXES = [
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

function boundedNumber(value, fallback, min, max, integer = false) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  const bounded = Math.max(min, Math.min(max, safe));
  return integer ? Math.round(bounded) : bounded;
}

function normaliseHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function parseTrustedHostList(raw) {
  if (Array.isArray(raw)) {
    return new Set(raw.map((item) => normaliseHost(item)).filter(Boolean));
  }
  return new Set(
    String(raw || "")
      .split(",")
      .map((item) => normaliseHost(item))
      .filter(Boolean)
  );
}

/**
 * Returns true if an IP address is ALWAYS prohibited (metadata, link-local,
 * unspecified, multicast, broadcast, or IPv4-mapped metadata/link-local),
 * even for trusted local/LAN model endpoints.
 */
export function isAlwaysProhibitedIp(ip) {
  if (typeof ip !== "string") return true;
  const cleaned = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!cleaned || cleaned.includes("%")) return true;
  const version = net.isIP(cleaned);
  if (version === 4) {
    const parts = cleaned.split(".").map(Number);
    const [a, b, c, d] = parts;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 100 && b === 100 && c === 100 && d === 200) return true; // Alibaba Cloud metadata
    if (a >= 224) return true; // Multicast & reserved/broadcast
    return false;
  }
  if (version === 6) {
    // Check IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254 or ::ffff:a9fe:a9fe)
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(cleaned);
    if (mappedDotted && net.isIP(mappedDotted[1]) === 4) {
      return isAlwaysProhibitedIp(mappedDotted[1]);
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(cleaned);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isAlwaysProhibitedIp(v4);
    }
    // Unspecified (::)
    if (cleaned === "::" || /^0+(:0+){7}$/.test(cleaned)) return true;
    // AWS IPv6 IMDS (fd00:ec2::254)
    if (cleaned === "fd00:ec2::254") return true;
    // Link-local (fe80::/10)
    const firstGroupHex = cleaned.split(":")[0];
    const g0 = firstGroupHex ? parseInt(firstGroupHex, 16) : 0;
    if ((g0 & 0xffc0) === 0xfe80) return true;
    // Multicast (ff00::/8)
    if ((g0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

/**
 * Returns true if a hostname or IP literal refers to localhost, private LAN,
 * single-label Docker/internal hostname, or private suffix.
 */
export function isLocalOrPrivateHost(hostname) {
  const host = normaliseHost(hostname);
  if (!host) return true;
  if (LOCAL_OR_PRIVATE_HOSTNAMES.has(host)) return true;
  if (LOCAL_OR_PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateOrReservedIpv4(host);
  if (ipVersion === 6) return isPrivateOrReservedIpv6(host);
  // Single-label hostnames (e.g. "ollama", "thor", "lmstudio") are local/internal
  if (!host.includes(".")) return true;
  return false;
}

/**
 * Validates a model provider endpoint URL against SSRF & protocol rules.
 * - Requires http: or https: with no embedded username/password/search/hash.
 * - Unconditionally blocks cloud metadata, link-local, unspecified, and multicast targets.
 * - Blocks localhost/private/LAN/single-label destinations UNLESS `trustedLocal`
 *   is explicitly true (or the host is listed in `trustedHosts`) and private
 *   endpoints are permitted by server policy.
 */
export function validateProviderUrl(rawUrl, {
  trustedLocal = false,
  allowPrivateEndpoints = process.env.ALFIE_PROVIDER_ALLOW_PRIVATE_ENDPOINTS !== "false",
  trustedHosts = process.env.ALFIE_PROVIDER_TRUSTED_HOSTS || ""
} = {}) {
  const candidate = String(rawUrl || "").trim();
  if (!candidate || candidate.length > 1024) {
    return { valid: false, code: "INVALID_PROVIDER_CONFIG", error: "Enter a valid model endpoint URL." };
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, code: "INVALID_PROVIDER_CONFIG", error: "Enter a valid model endpoint URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return {
      valid: false,
      code: "INVALID_PROVIDER_CONFIG",
      error: "Model endpoints must use HTTP or HTTPS without embedded credentials."
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      valid: false,
      code: "INVALID_PROVIDER_CONFIG",
      error: "Model endpoint base URLs cannot include query parameters or fragments."
    };
  }

  const host = normaliseHost(parsed.hostname);
  if (!host) {
    return { valid: false, code: "INVALID_PROVIDER_CONFIG", error: "Model endpoint URL must include a hostname." };
  }

  // Always block cloud metadata and prohibited ranges regardless of trustedLocal
  if (ALWAYS_BLOCKED_HOSTNAMES.has(host) || host.endsWith(".metadata.google.internal")) {
    return {
      valid: false,
      code: "PROVIDER_URL_BLOCKED",
      error: "Cloud metadata and link-local destinations are permanently blocked for model endpoints."
    };
  }
  const ipVersion = net.isIP(host);
  if (ipVersion && isAlwaysProhibitedIp(host)) {
    return {
      valid: false,
      code: "PROVIDER_URL_BLOCKED",
      error: "Link-local, metadata, unspecified, and multicast IP addresses are permanently blocked."
    };
  }

  const trustedHostSet = parseTrustedHostList(trustedHosts);
  const hostExplicitlyTrusted = trustedLocal === true || trustedHostSet.has(host);
  const isPrivateTarget = isLocalOrPrivateHost(host);

  if (isPrivateTarget) {
    if (!allowPrivateEndpoints && !trustedHostSet.has(host)) {
      return {
        valid: false,
        code: "PROVIDER_URL_BLOCKED",
        error: "Private and local model endpoints are disabled by server policy."
      };
    }
    if (!hostExplicitlyTrusted) {
      return {
        valid: false,
        code: "PROVIDER_LOCAL_OPT_IN_REQUIRED",
        error: "Local or private network endpoints must be explicitly marked as a trusted local endpoint."
      };
    }
  }

  return {
    valid: true,
    url: parsed.toString().replace(/\/$/, ""),
    parsed,
    host,
    isPrivateTarget,
    trustedLocal: hostExplicitlyTrusted
  };
}

/**
 * Resolves DNS for a provider endpoint URL and verifies that no resolved IP
 * points to an always-prohibited destination (metadata/link-local/multicast),
 * and when trustedLocal is false, rejects any private/loopback/reserved IP.
 */
export async function resolveAndValidateProviderTarget(rawUrl, {
  trustedLocal = false,
  allowPrivateEndpoints = process.env.ALFIE_PROVIDER_ALLOW_PRIVATE_ENDPOINTS !== "false",
  trustedHosts = process.env.ALFIE_PROVIDER_TRUSTED_HOSTS || "",
  dnsLookup = dns.lookup
} = {}) {
  const urlCheck = validateProviderUrl(rawUrl, { trustedLocal, allowPrivateEndpoints, trustedHosts });
  if (!urlCheck.valid) return urlCheck;

  const ipVersion = net.isIP(urlCheck.host);
  if (ipVersion) {
    return {
      ...urlCheck,
      addresses: [{ address: urlCheck.host, family: ipVersion }]
    };
  }

  let records;
  try {
    records = await dnsLookup(urlCheck.host, { all: true, verbatim: true });
  } catch (error) {
    return {
      valid: false,
      code: "PROVIDER_DNS_FAILED",
      error: `Could not resolve hostname "${urlCheck.host}": ${error?.code || error?.message || "DNS lookup failed"}.`
    };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return {
      valid: false,
      code: "PROVIDER_DNS_FAILED",
      error: `Hostname "${urlCheck.host}" did not resolve to any IP address.`
    };
  }

  for (const record of records) {
    const addr = String(record?.address || "").trim();
    if (!addr || isAlwaysProhibitedIp(addr)) {
      return {
        valid: false,
        code: "PROVIDER_URL_BLOCKED",
        error: `Hostname "${urlCheck.host}" resolved to a blocked metadata or link-local address.`
      };
    }
    if (!urlCheck.trustedLocal && isPrivateOrReservedIp(addr)) {
      return {
        valid: false,
        code: "PROVIDER_LOCAL_OPT_IN_REQUIRED",
        error: `Hostname "${urlCheck.host}" resolved to a private or loopback IP. Enable "Trusted local endpoint" only for hosts you control.`
      };
    }
  }

  return {
    ...urlCheck,
    addresses: records.map((r) => ({ address: String(r.address).trim(), family: Number(r.family) || net.isIP(String(r.address).trim()) }))
  };
}

export function redactProviderError(message, secret = "") {
  let clean = String(message || "Provider request failed.").trim();
  if (secret && secret.length >= 4) {
    clean = clean.split(secret).join("[redacted]");
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]");
  clean = clean.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{10,})\b/g, "[redacted]");
  return clean.slice(0, 500);
}

export function normaliseEndpoint(value = {}, index = 0, { defaultTrustedLocal = true, enforceUrlPolicy = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const provider = value.provider === "ollama" ? "ollama" : "openai-compatible";
  const id = String(value.id || `endpoint-${index + 1}`)
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || `endpoint-${index + 1}`;
  const fallbackUrl = provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
  const rawUrl = String(value.baseUrl || fallbackUrl).trim().replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw Object.assign(new Error("Enter a valid model endpoint URL."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error("Model endpoints must use HTTP or HTTPS without embedded credentials."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
  }
  if (parsed.search || parsed.hash) {
    throw Object.assign(new Error("Model endpoint base URLs cannot include query parameters or fragments."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
  }

  const host = normaliseHost(parsed.hostname);
  const explicitTrusted = typeof value.trustedLocal === "boolean"
    ? value.trustedLocal
    : (defaultTrustedLocal && isLocalOrPrivateHost(host));

  const urlCheck = validateProviderUrl(parsed.toString().replace(/\/$/, ""), {
    trustedLocal: explicitTrusted
  });
  if (!urlCheck.valid && (enforceUrlPolicy || urlCheck.code === "PROVIDER_URL_BLOCKED" || urlCheck.code === "INVALID_PROVIDER_CONFIG")) {
    throw Object.assign(new Error(urlCheck.error), { status: 400, code: urlCheck.code });
  }

  const enabled = typeof value.enabled === "boolean" ? value.enabled : value.enabled !== false;

  return {
    id,
    name: String(value.name || `Alfie endpoint ${index + 1}`).trim().slice(0, 80) || `Alfie endpoint ${index + 1}`,
    mode: ENDPOINT_MODES.has(value.mode) ? value.mode : "standard",
    priority: boundedNumber(value.priority, 50, 1, 100, true),
    enabled,
    provider,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    trustedLocal: explicitTrusted,
    model: String(value.model || "").trim().slice(0, 200),
    apiKey: String(value.apiKey || "").trim(),
    temperature: boundedNumber(value.temperature, 0.4, 0, 2),
    maxTokens: boundedNumber(value.maxTokens, 700, 64, 4096, true)
  };
}

export function normaliseConfig(value = {}, options = {}) {
  let source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (!Array.isArray(source.endpoints) && (source.baseUrl || source.model || source.provider)) {
    source = {
      mode: "auto",
      healthIntervalSeconds: 30,
      endpoints: [{ ...source, id: "legacy-primary", name: "Primary model" }]
    };
  }
  const endpoints = (Array.isArray(source.endpoints) ? source.endpoints : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, 8).map((item, idx) => normaliseEndpoint(item, idx, options));
  const ids = new Set();
  endpoints.forEach((endpoint, index) => {
    if (ids.has(endpoint.id)) endpoint.id = `${endpoint.id}-${index + 1}`;
    ids.add(endpoint.id);
  });
  return {
    mode: MODES.has(source.mode) ? source.mode : "auto",
    healthIntervalSeconds: boundedNumber(source.healthIntervalSeconds, 30, 10, 300, true),
    endpoints
  };
}

export function publicEndpoint(endpoint) {
  const { apiKey, apiKeyEncrypted, ...safe } = endpoint;
  return {
    ...safe,
    trustedLocal: Boolean(endpoint.trustedLocal),
    apiKeyConfigured: Boolean(apiKey || apiKeyEncrypted || endpoint.apiKeyConfigured)
  };
}

export function publicConfig(config) {
  return { ...config, endpoints: config.endpoints.map(publicEndpoint) };
}

export function endpointFor(endpoint, purpose = "chat") {
  if (endpoint.provider === "ollama") {
    return `${endpoint.baseUrl}${purpose === "models" ? "/api/tags" : "/api/chat"}`;
  }

  // Treat a supplied path as the provider's API root. This supports standard
  // /v1 endpoints and vendor compatibility roots such as Google's
  // /v1beta/openai without accidentally inserting a second /v1 segment.
  let base = String(endpoint.baseUrl || "");
  while (base.endsWith("/")) base = base.slice(0, -1);
  const pathname = new URL(base).pathname;
  const apiRoot = pathname && pathname !== "/"
    ? base
    : `${base}/v1`;
  return `${apiRoot}/${purpose === "models" ? "models" : "chat/completions"}`;
}
export function headersFor(endpoint) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}

/**
 * Perform a provider request against only the IPs validated immediately
 * beforehand. Keep the original hostname for Host, TLS certificate checks,
 * and SNI; pin only the socket lookup. A one-shot agent prevents socket reuse.
 */
export async function fetchPinnedProviderRequest(rawUrl, options = {}, validatedTarget) {
  const url = new URL(rawUrl);
  const addresses = validatedTarget?.addresses;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw Object.assign(new Error("Provider destination was not DNS-validated."), { code: "PROVIDER_DNS_FAILED" });
  }
  const hostname = normaliseHost(url.hostname);
  const literalFamily = net.isIP(hostname);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Unsupported provider request protocol."), { code: "INVALID_PROVIDER_CONFIG" });
  }
  const pinnedLookup = (requestedHost, lookupOptions, callback) => {
    if (normaliseHost(requestedHost) !== hostname) {
      callback(Object.assign(new Error("Unexpected provider DNS lookup host."), { code: "PROVIDER_DNS_FAILED" }));
      return;
    }
    const eligible = addresses.filter((entry) =>
      entry && net.isIP(String(entry.address || "")) &&
      (!lookupOptions?.family || Number(lookupOptions.family) === Number(entry.family))
    );
    if (!eligible.length) {
      callback(Object.assign(new Error("No validated address matches the provider connection."), { code: "PROVIDER_DNS_FAILED" }));
      return;
    }
    if (lookupOptions?.all) {
      callback(null, eligible.map((entry) => ({
        address: String(entry.address),
        family: Number(entry.family) || net.isIP(String(entry.address))
      })));
      return;
    }
    const selected = eligible[0];
    callback(null, String(selected.address), Number(selected.family) || net.isIP(String(selected.address)));
  };
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : { ...(options.headers || {}) };
  const requestOptions = {
    method: options.method || "GET",
    headers,
    agent: false,
    ...(literalFamily ? {} : {
      lookup: pinnedLookup,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {})
    }),
    ...(options.signal ? { signal: options.signal } : {})
  };
  return await new Promise((resolve, reject) => {
    const request = transport(url, requestOptions, (incoming) => {
      const body = [204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming);
      resolve(new Response(body, {
        status: incoming.statusCode || 502,
        statusText: incoming.statusMessage || "",
        headers: incoming.headers
      }));
    });
    request.once("error", reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

export function modeRank(endpointMode, requestedMode) {
  if (requestedMode === "auto") return endpointMode === "standard" ? 3 : endpointMode === "work" ? 2 : 1;
  if (endpointMode === requestedMode) return 4;
  if (requestedMode === "work" && endpointMode === "standard") return 3;
  if (requestedMode === "standard" && endpointMode === "light") return 2;
  return 1;
}

export class ProviderRegistry {
  constructor({
    fetchImpl = globalThis.fetch,
    dnsLookup = null,
    now = () => Date.now()
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("ProviderRegistry requires a fetch implementation.");
    this.fetchImpl = fetchImpl;
    this.usesDefaultFetch = fetchImpl === globalThis.fetch;
    this.dnsLookup = dnsLookup;
    this.now = now;
    this.healthCache = new Map();
  }

  clearHealthCache(endpointId = null) {
    if (!endpointId) {
      this.healthCache.clear();
      return;
    }
    const prefix = `${endpointId}|`;
    for (const key of this.healthCache.keys()) {
      if (key.startsWith(prefix)) this.healthCache.delete(key);
    }
  }

  async assertTargetAllowed(endpoint) {
    const trustedLocal = typeof endpoint.trustedLocal === "boolean"
      ? endpoint.trustedLocal
      : isLocalOrPrivateHost(new URL(endpoint.baseUrl).hostname);
    const staticCheck = validateProviderUrl(endpoint.baseUrl, { trustedLocal });
    if (!staticCheck.valid) {
      throw Object.assign(new Error(staticCheck.error), { status: 400, code: staticCheck.code });
    }
    // The default network path returns the validated addresses for pinning.
    // Custom fetch implementations remain injectable for isolated unit tests.
    if (this.dnsLookup || this.usesDefaultFetch) {
      const dnsCheck = await resolveAndValidateProviderTarget(endpoint.baseUrl, {
        trustedLocal,
        dnsLookup: this.dnsLookup || dns.lookup
      });
      if (!dnsCheck.valid) {
        throw Object.assign(new Error(dnsCheck.error), { status: 400, code: dnsCheck.code });
      }
      return dnsCheck;
    }
    return staticCheck;
  }

  async inspect(endpoint) {
    const started = this.now();
    try {
      const validatedTarget = await this.assertTargetAllowed(endpoint);
      const requestOptions = {
        method: "GET",
        headers: headersFor(endpoint),
        redirect: "error",
        signal: AbortSignal.timeout(6000)
      };
      const response = this.usesDefaultFetch
        ? await fetchPinnedProviderRequest(endpointFor(endpoint, "models"), requestOptions, validatedTarget)
        : await this.fetchImpl(endpointFor(endpoint, "models"), requestOptions);
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) {
        throw new Error(
          redactProviderError(
            payload?.error?.message || payload?.error || payload?.message || `Model server returned HTTP ${response.status}.`,
            endpoint.apiKey
          )
        );
      }
      const models = endpoint.provider === "ollama"
        ? (payload.models || []).map((item) => item.name || item.model).filter(Boolean)
        : (payload.data || []).map((item) => item.id).filter(Boolean);
      const uniqueModels = [...new Set(models.map((item) => String(item).trim()).filter(Boolean))];
      return {
        id: endpoint.id,
        online: true,
        latencyMs: Math.max(0, this.now() - started),
        models: uniqueModels,
        modelAvailable: !endpoint.model || uniqueModels.includes(endpoint.model)
      };
    } catch (error) {
      return {
        id: endpoint.id,
        online: false,
        latencyMs: Math.max(0, this.now() - started),
        models: [],
        modelAvailable: false,
        code: error?.code || "PROVIDER_UNREACHABLE",
        error: redactProviderError(error?.message || "Could not connect to model endpoint.", endpoint.apiKey)
      };
    }
  }

  async inspectCached(endpoint, maxAgeSeconds = 30) {
    const maxAgeMs = Math.max(10000, Number(maxAgeSeconds || 30) * 1000);
    const cacheKey = [endpoint.id, endpoint.provider, endpoint.baseUrl, endpoint.model, endpoint.trustedLocal ? "1" : "0", endpoint.apiKey ? "k" : "n"].join("|");
    const cached = this.healthCache.get(cacheKey);
    if (cached && this.now() - cached.checkedAt < maxAgeMs) return cached.result;
    const result = await this.inspect(endpoint);
    this.healthCache.set(cacheKey, { checkedAt: this.now(), result });
    return result;
  }

  async rankedCandidates(config, requestedMode = config.mode) {
    const enabled = config.endpoints.filter((endpoint) => endpoint.enabled && endpoint.model);
    if (!enabled.length) throw new Error("Add and enable at least one Alfie endpoint with a model name.");
    const health = await Promise.all(enabled.map((endpoint) =>
      this.inspectCached(endpoint, config.healthIntervalSeconds)));
    const candidates = enabled
      .map((endpoint) => ({ endpoint, health: health.find((item) => item.id === endpoint.id) }))
      .filter((item) => item.health?.online && item.health.modelAvailable)
      .sort((a, b) =>
        modeRank(b.endpoint.mode, requestedMode) - modeRank(a.endpoint.mode, requestedMode) ||
        b.endpoint.priority - a.endpoint.priority ||
        a.health.latencyMs - b.health.latencyMs
      );
    if (!candidates.length) {
      const detail = health.map((item) =>
        `${item.id}: ${item.error || (item.modelAvailable ? "online" : "model unavailable")}`).join("; ");
      throw new Error(`No configured Alfie endpoint is available. ${detail}`);
    }
    return { candidates, health };
  }

  async select(config, requestedMode = config.mode) {
    const { candidates, health } = await this.rankedCandidates(config, requestedMode);
    return { ...candidates[0], health };
  }

  async complete(config, messages, requestedMode = config.mode, { signal, timeoutMs = DEFAULT_PROVIDER_CHAT_TIMEOUT_MS } = {}) {
    const { candidates, health } = await this.rankedCandidates(config, requestedMode);
    const failures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const result = await this.chat(candidate.endpoint, messages, { stream: false, signal, timeoutMs });
        return {
          ...candidate,
          health,
          result,
          fallbackUsed: index > 0 || (requestedMode !== "auto" && candidate.endpoint.mode !== requestedMode)
        };
      } catch (error) {
        failures.push(`${candidate.endpoint.id}: ${redactProviderError(error.message, candidate.endpoint.apiKey)}`);
      }
    }
    throw new Error(`All available Alfie providers failed. ${failures.join("; ")}`);
  }

  async openStream(config, messages, requestedMode = config.mode, { signal, timeoutMs = DEFAULT_PROVIDER_CHAT_TIMEOUT_MS } = {}) {
    const { candidates, health } = await this.rankedCandidates(config, requestedMode);
    const failures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const response = await this.chat(candidate.endpoint, messages, { stream: true, signal, timeoutMs });
        return {
          ...candidate,
          health,
          response,
          fallbackUsed: index > 0 || (requestedMode !== "auto" && candidate.endpoint.mode !== requestedMode)
        };
      } catch (error) {
        failures.push(`${candidate.endpoint.id}: ${redactProviderError(error.message, candidate.endpoint.apiKey)}`);
      }
    }
    throw new Error(`All available Alfie streaming providers failed. ${failures.join("; ")}`);
  }

  async chat(endpoint, messages, { stream = false, signal, timeoutMs = DEFAULT_PROVIDER_CHAT_TIMEOUT_MS } = {}) {
    const validatedTarget = await this.assertTargetAllowed(endpoint);
    const body = endpoint.provider === "ollama"
      ? {
          model: endpoint.model, messages, stream,
          options: { temperature: endpoint.temperature, num_predict: endpoint.maxTokens }
        }
      : {
          model: endpoint.model, messages, stream,
          temperature: endpoint.temperature, max_tokens: endpoint.maxTokens
        };
    const requestOptions = {
      method: "POST",
      headers: headersFor(endpoint),
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, Math.min(DEFAULT_PROVIDER_CHAT_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_PROVIDER_CHAT_TIMEOUT_MS)))])
        : AbortSignal.timeout(Math.max(1000, Math.min(DEFAULT_PROVIDER_CHAT_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_PROVIDER_CHAT_TIMEOUT_MS)))
    };
    const response = this.usesDefaultFetch
      ? await fetchPinnedProviderRequest(endpointFor(endpoint, "chat"), requestOptions, validatedTarget)
      : await this.fetchImpl(endpointFor(endpoint, "chat"), requestOptions);
    if (!response.ok) {
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      throw Object.assign(
        new Error(
          redactProviderError(
            payload?.error?.message || payload?.error || payload?.message || `Model server returned HTTP ${response.status}.`,
            endpoint.apiKey
          )
        ),
        { status: response.status }
      );
    }
    if (stream) return response;
    const payload = await response.json();
    const content = endpoint.provider === "ollama"
      ? payload?.message?.content
      : payload?.choices?.[0]?.message?.content;
    if (!String(content || "").trim()) throw new Error("The model returned an empty response.");
    return { content: String(content).trim(), raw: payload };
  }
}
