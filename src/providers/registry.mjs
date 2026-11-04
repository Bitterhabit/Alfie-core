const MODES = new Set(["auto", "light", "standard", "work"]);
const ENDPOINT_MODES = new Set(["light", "standard", "work"]);

function boundedNumber(value, fallback, min, max, integer = false) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  const bounded = Math.max(min, Math.min(max, safe));
  return integer ? Math.round(bounded) : bounded;
}

export function normaliseEndpoint(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const provider = value.provider === "ollama" ? "ollama" : "openai-compatible";
  const id = String(value.id || `endpoint-${index + 1}`)
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || `endpoint-${index + 1}`;
  const fallbackUrl = provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
  const rawUrl = String(value.baseUrl || fallbackUrl).trim().replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw Object.assign(new Error("Enter a valid model endpoint URL."), { code: "INVALID_PROVIDER_CONFIG" });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error("Model endpoints must use HTTP or HTTPS without embedded credentials."), { code: "INVALID_PROVIDER_CONFIG" });
  }
  return {
    id,
    name: String(value.name || `Alfie endpoint ${index + 1}`).trim().slice(0, 80),
    mode: ENDPOINT_MODES.has(value.mode) ? value.mode : "standard",
    priority: boundedNumber(value.priority, 50, 1, 100, true),
    enabled: value.enabled !== false,
    provider,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    model: String(value.model || "").trim().slice(0, 200),
    apiKey: String(value.apiKey || "").trim(),
    temperature: boundedNumber(value.temperature, 0.4, 0, 2),
    maxTokens: boundedNumber(value.maxTokens, 700, 64, 4096, true)
  };
}

export function normaliseConfig(value = {}) {
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
    .slice(0, 8).map(normaliseEndpoint);
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
  const { apiKey, ...safe } = endpoint;
  return { ...safe, apiKeyConfigured: Boolean(apiKey) };
}

export function publicConfig(config) {
  return { ...config, endpoints: config.endpoints.map(publicEndpoint) };
}

export function endpointFor(endpoint, purpose = "chat") {
  if (endpoint.provider === "ollama") {
    return `${endpoint.baseUrl}${purpose === "models" ? "/api/tags" : "/api/chat"}`;
  }
  const base = endpoint.baseUrl.replace(/\/v1\/?$/, "");
  return `${base}/v1/${purpose === "models" ? "models" : "chat/completions"}`;
}

export function headersFor(endpoint) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}

export function modeRank(endpointMode, requestedMode) {
  if (requestedMode === "auto") return endpointMode === "standard" ? 3 : endpointMode === "work" ? 2 : 1;
  if (endpointMode === requestedMode) return 4;
  if (requestedMode === "work" && endpointMode === "standard") return 3;
  if (requestedMode === "standard" && endpointMode === "light") return 2;
  return 1;
}

export class ProviderRegistry {
  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("ProviderRegistry requires a fetch implementation.");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.healthCache = new Map();
  }

  async inspect(endpoint) {
    const started = this.now();
    try {
      const response = await this.fetchImpl(endpointFor(endpoint, "models"), {
        method: "GET",
        headers: headersFor(endpoint),
        signal: AbortSignal.timeout(6000)
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || `Model server returned HTTP ${response.status}.`);
      const models = endpoint.provider === "ollama"
        ? (payload.models || []).map((item) => item.name || item.model).filter(Boolean)
        : (payload.data || []).map((item) => item.id).filter(Boolean);
      return {
        id: endpoint.id, online: true, latencyMs: Math.max(0, this.now() - started),
        models, modelAvailable: !endpoint.model || models.includes(endpoint.model)
      };
    } catch (error) {
      return {
        id: endpoint.id, online: false, latencyMs: Math.max(0, this.now() - started),
        models: [], modelAvailable: false, error: error.message
      };
    }
  }

  async inspectCached(endpoint, maxAgeSeconds = 30) {
    const maxAgeMs = Math.max(10000, Number(maxAgeSeconds || 30) * 1000);
    const cacheKey = [endpoint.id, endpoint.provider, endpoint.baseUrl, endpoint.model].join("|");
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

  async complete(config, messages, requestedMode = config.mode, { signal } = {}) {
    const { candidates, health } = await this.rankedCandidates(config, requestedMode);
    const failures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const result = await this.chat(candidate.endpoint, messages, { stream: false, signal });
        return {
          ...candidate,
          health,
          result,
          fallbackUsed: index > 0 || (requestedMode !== "auto" && candidate.endpoint.mode !== requestedMode)
        };
      } catch (error) {
        failures.push(`${candidate.endpoint.id}: ${error.message}`);
      }
    }
    throw new Error(`All available Alfie providers failed. ${failures.join("; ")}`);
  }


  async openStream(config, messages, requestedMode = config.mode, { signal } = {}) {
    const { candidates, health } = await this.rankedCandidates(config, requestedMode);
    const failures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const response = await this.chat(candidate.endpoint, messages, { stream: true, signal });
        return {
          ...candidate,
          health,
          response,
          fallbackUsed: index > 0 || (requestedMode !== "auto" && candidate.endpoint.mode !== requestedMode)
        };
      } catch (error) {
        failures.push(`${candidate.endpoint.id}: ${error.message}`);
      }
    }
    throw new Error(`All available Alfie streaming providers failed. ${failures.join("; ")}`);
  }

  async chat(endpoint, messages, { stream = false, signal } = {}) {
    const body = endpoint.provider === "ollama"
      ? {
          model: endpoint.model, messages, stream,
          options: { temperature: endpoint.temperature, num_predict: endpoint.maxTokens }
        }
      : {
          model: endpoint.model, messages, stream,
          temperature: endpoint.temperature, max_tokens: endpoint.maxTokens
        };
    const response = await this.fetchImpl(endpointFor(endpoint, "chat"), {
      method: "POST",
      headers: headersFor(endpoint),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      throw Object.assign(new Error(String(payload?.error?.message || payload?.error || payload?.message || `Model server returned HTTP ${response.status}.`)), { status: response.status });
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
