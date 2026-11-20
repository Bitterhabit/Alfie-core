import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_THRESHOLD_PERCENT = 80;
const DEFAULT_REPORT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EXTERNAL_TTL_SECONDS = 120;

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200"
]);

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num * 10) / 10));
}

function clampThreshold(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_THRESHOLD_PERCENT;
  return Math.max(50, Math.min(95, Math.round(num)));
}

function clampExternalTtlMs(secondsValue) {
  const sec = Number(secondsValue);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXTERNAL_TTL_SECONDS * 1000;
  return Math.max(15, Math.min(3600, Math.round(sec))) * 1000;
}

function sanitiseLabel(value, fallback, maxLen = 80) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
  return cleaned || fallback;
}

export function validateRemoteVramUrl(rawUrl) {
  const candidate = String(rawUrl || "").trim();
  if (!candidate) return null;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || BLOCKED_METADATA_HOSTS.has(host) || host.startsWith("169.254.")) {
    return null;
  }
  return parsed.toString();
}

export function parseNvidiaSmiCsv(stdout = "") {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const gpus = [];
  for (const line of lines) {
    const parts = line.split(",").map((item) => item.trim());
    if (parts.length < 3) continue;
    const gpuName = parts[0] || "NVIDIA GPU";
    const usedMb = Number(parts[1]);
    const totalMb = Number(parts[2]);
    if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) continue;
    const percent = clampPercent((usedMb / totalMb) * 100);
    gpus.push({
      gpuName,
      usedMb: Math.round(usedMb),
      totalMb: Math.round(totalMb),
      percent
    });
  }
  if (!gpus.length) return null;

  // Report the highest-utilization GPU so a single hot GPU triggers the 80% warning reliably
  gpus.sort((a, b) => (b.percent || 0) - (a.percent || 0));
  const primary = gpus[0];
  return {
    available: true,
    source: "nvidia-smi",
    gpuName: primary.gpuName,
    usedMb: primary.usedMb,
    totalMb: primary.totalMb,
    percent: primary.percent,
    gpus
  };
}

export function parseRemoteVramPayload(rawText, { fallbackHost = null, source = "external-pc-pull" } = {}) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const data = parsed?.vram && typeof parsed.vram === "object" ? parsed.vram : parsed;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const usedMb = data.usedMb ?? data.used_mb ?? data.memory_used_mb ?? data.vram_used_mb ?? null;
      const totalMb = data.totalMb ?? data.total_mb ?? data.memory_total_mb ?? data.vram_total_mb ?? null;
      let percent = data.percent ?? data.utilizationPercent ?? data.vram_percent ?? null;
      const usedNum = usedMb !== null && usedMb !== undefined ? Number(usedMb) : null;
      const totalNum = totalMb !== null && totalMb !== undefined ? Number(totalMb) : null;
      if (percent === null || percent === undefined) {
        if (Number.isFinite(usedNum) && Number.isFinite(totalNum) && totalNum > 0 && usedNum >= 0) {
          percent = (usedNum / totalNum) * 100;
        }
      }
      const clamped = clampPercent(percent);
      if (clamped !== null) {
        const resolvedTotal = Number.isFinite(totalNum) && totalNum > 0 ? Math.round(totalNum) : null;
        const resolvedUsed = Number.isFinite(usedNum) && usedNum >= 0
          ? Math.round(resolvedTotal ? Math.min(usedNum, resolvedTotal) : usedNum)
          : (resolvedTotal ? Math.round((clamped / 100) * resolvedTotal) : null);
        return {
          available: true,
          source,
          gpuName: sanitiseLabel(data.gpuName || data.gpu_name || data.name, "External PC GPU", 80),
          hostName: sanitiseLabel(data.hostName || data.host_name || data.host || fallbackHost, fallbackHost || "External PC", 64),
          usedMb: resolvedUsed,
          totalMb: resolvedTotal,
          percent: clamped
        };
      }
    }
  } catch {
    // Fall back to nvidia-smi CSV format
  }

  const csv = parseNvidiaSmiCsv(trimmed);
  if (csv) {
    return {
      ...csv,
      source,
      hostName: sanitiseLabel(fallbackHost, "External PC", 64)
    };
  }
  return null;
}

export function parseOllamaPs(payload, configuredTotalMb = null, hostName = null) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  let totalVramBytes = 0;
  const loaded = [];
  for (const model of models) {
    const vramBytes = Number(model?.size_vram);
    if (Number.isFinite(vramBytes) && vramBytes > 0) {
      totalVramBytes += vramBytes;
    }
    loaded.push({
      name: String(model?.name || model?.model || "unknown").slice(0, 120),
      vramMb: Number.isFinite(vramBytes) ? Math.round(vramBytes / (1024 * 1024)) : 0
    });
  }
  const usedMb = Math.round(totalVramBytes / (1024 * 1024));
  const totalMb = Number.isFinite(Number(configuredTotalMb)) && Number(configuredTotalMb) > 0
    ? Math.round(Number(configuredTotalMb))
    : null;
  const percent = totalMb ? clampPercent((usedMb / totalMb) * 100) : null;
  return {
    available: totalMb !== null,
    source: "ollama",
    gpuName: hostName ? `Ollama (${hostName})` : "Ollama VRAM",
    hostName: hostName || null,
    usedMb,
    totalMb,
    percent,
    modelsLoaded: loaded
  };
}

export class VramMonitor {
  constructor({
    thresholdPercent = process.env.ALFIE_VRAM_WARNING_THRESHOLD ?? DEFAULT_THRESHOLD_PERCENT,
    totalMbHint = process.env.ALFIE_VRAM_TOTAL_MB ?? null,
    simulatedPercent = process.env.ALFIE_VRAM_SIMULATED_PERCENT ?? null,
    remoteUrl = process.env.ALFIE_VRAM_REMOTE_URL ?? "",
    remoteToken = process.env.ALFIE_VRAM_REMOTE_TOKEN ?? "",
    reportTokenConfigured = Boolean(process.env.ALFIE_VRAM_REPORT_TOKEN && process.env.ALFIE_VRAM_REPORT_TOKEN.trim().length >= 16),
    externalReportTtlSeconds = process.env.ALFIE_VRAM_REPORT_TTL_SECONDS ?? DEFAULT_EXTERNAL_TTL_SECONDS,
    disableLocalProbe = process.env.ALFIE_VRAM_DISABLE_LOCAL_PROBE === "true",
    reportTtlMs = DEFAULT_REPORT_TTL_MS,
    now = () => Date.now(),
    execFileImpl = execFileAsync,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.thresholdPercent = clampThreshold(thresholdPercent);
    this.totalMbHint = Number.isFinite(Number(totalMbHint)) && Number(totalMbHint) > 0 ? Math.round(Number(totalMbHint)) : null;
    this.simulatedPercent = simulatedPercent !== null && simulatedPercent !== "" ? clampPercent(simulatedPercent) : null;
    this.remoteUrl = validateRemoteVramUrl(remoteUrl);
    this.remoteToken = typeof remoteToken === "string" ? remoteToken.trim() : "";
    this.reportTokenConfigured = Boolean(reportTokenConfigured);
    this.externalReportTtlMs = clampExternalTtlMs(externalReportTtlSeconds);
    this.disableLocalProbe = Boolean(disableLocalProbe);
    this.reportTtlMs = Math.max(5000, Number(reportTtlMs) || DEFAULT_REPORT_TTL_MS);
    this.now = now;
    this.execFileImpl = execFileImpl;
    this.fetchImpl = fetchImpl;
    this.reportedByUser = new Map();
    this.externalHostReport = null;
    this.lastExternalHostMeta = null;
  }

  normaliseReportPayload(input = {}, { defaultSource = "reported", defaultGpuName = "Reported GPU", defaultHostName = null } = {}) {
    const usedMb = input.usedMb !== undefined && input.usedMb !== null ? Number(input.usedMb) : null;
    const totalMb = input.totalMb !== undefined && input.totalMb !== null ? Number(input.totalMb) : null;
    let percent = input.percent !== undefined && input.percent !== null ? clampPercent(input.percent) : null;

    if (percent === null && Number.isFinite(usedMb) && Number.isFinite(totalMb) && totalMb > 0 && usedMb >= 0) {
      percent = clampPercent((usedMb / totalMb) * 100);
    }
    if (percent === null) {
      throw Object.assign(new Error("Provide a valid VRAM percent (0-100) or usedMb and totalMb values."), { status: 400 });
    }
    const resolvedTotalMb = Number.isFinite(totalMb) && totalMb > 0 ? Math.round(totalMb) : (this.totalMbHint || 24576);
    const resolvedUsedMb = Number.isFinite(usedMb) && usedMb >= 0
      ? Math.round(Math.min(usedMb, resolvedTotalMb))
      : Math.round((percent / 100) * resolvedTotalMb);

    return {
      available: true,
      source: String(input.source || defaultSource).replace(/[^a-z0-9._-]/gi, "").slice(0, 40) || defaultSource,
      gpuName: sanitiseLabel(input.gpuName, defaultGpuName, 80),
      hostName: input.hostName ? sanitiseLabel(input.hostName, defaultHostName || "External PC", 64) : defaultHostName,
      usedMb: resolvedUsedMb,
      totalMb: resolvedTotalMb,
      percent
    };
  }

  report(userId, input = {}) {
    if (!userId) {
      throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
    }
    if (input.clear === true) {
      this.reportedByUser.delete(userId);
      return { cleared: true, thresholdPercent: this.thresholdPercent };
    }
    const base = this.normaliseReportPayload(input, {
      defaultSource: "reported",
      defaultGpuName: "Reported GPU",
      defaultHostName: null
    });
    const entry = {
      ...base,
      reportedAt: this.now(),
      expiresAt: this.now() + this.reportTtlMs
    };
    this.reportedByUser.set(userId, entry);
    return this.formatStatus(entry);
  }

  reportExternalHost(input = {}) {
    if (input.clear === true) {
      this.externalHostReport = null;
      return { cleared: true, thresholdPercent: this.thresholdPercent };
    }
    const base = this.normaliseReportPayload(input, {
      defaultSource: "external-pc",
      defaultGpuName: "External PC GPU",
      defaultHostName: "External PC"
    });
    const timestamp = this.now();
    const entry = {
      ...base,
      source: base.source === "reported" ? "external-pc" : base.source,
      reportedAt: timestamp,
      expiresAt: timestamp + this.externalReportTtlMs
    };
    this.externalHostReport = entry;
    this.lastExternalHostMeta = {
      hostName: entry.hostName,
      gpuName: entry.gpuName,
      reportedAt: timestamp
    };
    return this.formatStatus(entry);
  }

  clearReport(userId) {
    if (userId) this.reportedByUser.delete(userId);
    return { cleared: true };
  }

  getActiveReport(userId) {
    if (!userId) return null;
    const entry = this.reportedByUser.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.reportedByUser.delete(userId);
      return null;
    }
    return entry;
  }

  getActiveExternalHostReport() {
    if (!this.externalHostReport) return null;
    if (this.externalHostReport.expiresAt <= this.now()) {
      this.externalHostReport = null;
      return null;
    }
    return this.externalHostReport;
  }

  isPushTokenConfigured() {
    if (this.reportTokenConfigured) return true;
    const envVal = process.env.ALFIE_VRAM_REPORT_TOKEN;
    return typeof envVal === "string" && envVal.trim().length >= 16;
  }

  formatStatus(reading, modelsLoaded = [], extras = {}) {
    const percent = reading?.percent !== undefined && reading?.percent !== null ? clampPercent(reading.percent) : null;
    const available = Boolean(reading?.available && percent !== null);
    const source = reading?.source || "unavailable";
    const lastExternal = this.lastExternalHostMeta;
    const stale = !available && Boolean(lastExternal);

    let mode = "unconfigured";
    if (source === "test-alert" || source === "reported") mode = "test-alert";
    else if (source === "external-pc") mode = "external-push";
    else if (source === "external-pc-pull") mode = "external-pull";
    else if (source === "ollama") mode = "remote-ollama";
    else if (source === "nvidia-smi") mode = "local-gpu";
    else if (source === "simulated") mode = "simulated";
    else if (stale) mode = "stale";
    else if (extras.ollamaReachableHost) mode = "ollama-needs-total";

    return {
      available,
      percent,
      usedMb: Number.isFinite(reading?.usedMb) ? Math.round(reading.usedMb) : null,
      totalMb: Number.isFinite(reading?.totalMb) ? Math.round(reading.totalMb) : null,
      gpuName: reading?.gpuName || null,
      hostName: reading?.hostName || extras.ollamaReachableHost || lastExternal?.hostName || null,
      source,
      thresholdPercent: this.thresholdPercent,
      warning: available && percent >= this.thresholdPercent,
      modelsLoaded: Array.isArray(modelsLoaded) ? modelsLoaded : [],
      connection: {
        mode,
        hostName: reading?.hostName || extras.ollamaReachableHost || lastExternal?.hostName || null,
        pushTokenConfigured: this.isPushTokenConfigured(),
        remoteUrlConfigured: Boolean(this.remoteUrl),
        stale,
        lastReportedAt: reading?.reportedAt
          ? new Date(reading.reportedAt).toISOString()
          : (lastExternal?.reportedAt ? new Date(lastExternal.reportedAt).toISOString() : null),
        ttlSeconds: Math.round(this.externalReportTtlMs / 1000)
      },
      updatedAt: new Date(this.now()).toISOString()
    };
  }

  async probeRemoteEndpoint() {
    if (!this.remoteUrl || typeof this.fetchImpl !== "function") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const parsed = new URL(this.remoteUrl);
      const headers = { accept: "application/json, text/plain" };
      if (this.remoteToken) {
        headers.authorization = `Bearer ${this.remoteToken}`;
      }
      const response = await this.fetchImpl(this.remoteUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) return null;
      const rawText = await response.text();
      if (rawText.length > 64 * 1024) return null;
      return parseRemoteVramPayload(rawText, { fallbackHost: parsed.host, source: "external-pc-pull" });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async probeNvidiaSmi() {
    if (this.disableLocalProbe || typeof this.execFileImpl !== "function") return null;
    try {
      const { stdout } = await this.execFileImpl(
        "nvidia-smi",
        ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 2500, maxBuffer: 64 * 1024 }
      );
      return parseNvidiaSmiCsv(stdout);
    } catch {
      return null;
    }
  }

  async probeOllama(endpoints = []) {
    if (typeof this.fetchImpl !== "function" || !Array.isArray(endpoints) || !endpoints.length) return null;
    const ollamaEndpoints = endpoints.filter((item) => item && item.provider === "ollama" && typeof item.baseUrl === "string" && item.baseUrl);
    for (const endpoint of ollamaEndpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1800);
      try {
        const parsed = new URL(endpoint.baseUrl);
        const base = endpoint.baseUrl.replace(/\/+$/, "");
        const response = await this.fetchImpl(`${base}/api/ps`, { signal: controller.signal, redirect: "error" });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => null);
        if (!payload) continue;
        return parseOllamaPs(payload, this.totalMbHint, parsed.host);
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async inspect({ userId = null, endpoints = [] } = {}) {
    // 1. Per-user test/manual alert override
    const reported = this.getActiveReport(userId);
    if (reported) {
      return this.formatStatus(reported, []);
    }

    // 2. Explicit env simulation (testing)
    if (this.simulatedPercent !== null) {
      const totalMb = this.totalMbHint || 24576;
      const usedMb = Math.round((this.simulatedPercent / 100) * totalMb);
      return this.formatStatus({
        available: true,
        source: "simulated",
        gpuName: "Simulated GPU",
        usedMb,
        totalMb,
        percent: this.simulatedPercent
      });
    }

    // 3. External PC live push report (Proxmox -> External GPU PC)
    const externalPush = this.getActiveExternalHostReport();
    if (externalPush) {
      const ollama = await this.probeOllama(endpoints);
      return this.formatStatus(externalPush, ollama?.modelsLoaded || []);
    }

    // 4. External PC pull endpoint (ALFIE_VRAM_REMOTE_URL) + Remote Ollama + optional local GPU fallback
    const [remotePull, ollama, nvidia] = await Promise.all([
      this.probeRemoteEndpoint(),
      this.probeOllama(endpoints),
      this.probeNvidiaSmi()
    ]);

    if (remotePull) {
      return this.formatStatus(remotePull, ollama?.modelsLoaded || []);
    }

    if (ollama?.available) {
      return this.formatStatus(ollama, ollama.modelsLoaded || []);
    }

    if (nvidia) {
      return this.formatStatus(nvidia, ollama?.modelsLoaded || []);
    }

    return this.formatStatus(
      {
        available: false,
        source: "unavailable",
        usedMb: ollama ? ollama.usedMb : null,
        gpuName: ollama ? ollama.gpuName : null
      },
      ollama?.modelsLoaded || [],
      { ollamaReachableHost: ollama?.hostName || null }
    );
  }
}
