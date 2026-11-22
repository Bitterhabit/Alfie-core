import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  UserMutex,
  readUserJsonDocument,
  writeUserJsonDocument
} from "../storage/userJsonStore.mjs";
import {
  normaliseConfig,
  normaliseEndpoint,
  publicConfig,
  publicEndpoint,
  validateProviderUrl
} from "./registry.mjs";

const FILENAME = "providers.json";
const MAX_ENDPOINTS = 8;
const VALID_MODES = new Set(["auto", "light", "standard", "work"]);
const VALID_ENDPOINT_MODES = new Set(["light", "standard", "work"]);
const KEY_FILENAME = ".provider-secret.key";

function buildAad(userId, endpointId) {
  return Buffer.from(`alfie-provider-secret:v1:${String(userId || "")}:${String(endpointId || "")}`, "utf8");
}

function deriveEncryptionKey(masterSecret) {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterSecret, "utf8"), Buffer.from("alfie-provider-store-v1", "utf8"), Buffer.from("aes-256-gcm", "utf8"), 32)
  );
}

function encryptSecret(plaintext, masterKey, userId, endpointId) {
  const clean = String(plaintext || "").trim();
  if (!clean) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(buildAad(userId, endpointId));
  const encrypted = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}

function decryptSecret(envelope, masterKey, userId, endpointId) {
  if (!envelope || typeof envelope !== "object" || envelope.alg !== "aes-256-gcm") return "";
  try {
    const iv = Buffer.from(String(envelope.iv || ""), "base64");
    const tag = Buffer.from(String(envelope.tag || ""), "base64");
    const ciphertext = Buffer.from(String(envelope.ciphertext || ""), "base64");
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) return "";
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAAD(buildAad(userId, endpointId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function makeEndpointId(name, existingIds = new Set()) {
  const base = String(name || "endpoint")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "endpoint";
  if (!existingIds.has(base)) return base;
  for (let i = 2; i <= 50; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function assertStrictBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${fieldName} must be a boolean (true or false).`), {
      status: 400,
      code: "INVALID_PROVIDER_CONFIG"
    });
  }
  return value;
}

export class ProviderStore {
  constructor({
    dataDirectory = process.env.ALFIE_CORE_DATA_DIR || path.resolve(process.cwd(), "data"),
    fallbackConfig = { mode: "auto", healthIntervalSeconds: 30, endpoints: [] },
    secretKey = null,
    now = () => new Date().toISOString()
  } = {}) {
    this.dataDirectory = dataDirectory;
    this.fallbackConfig = normaliseConfig(fallbackConfig, { defaultTrustedLocal: true, enforceUrlPolicy: false });
    this.explicitSecretKey = secretKey;
    this.now = now;
    this.mutex = new UserMutex();
    this._cachedKey = null;
  }

  async getMasterKey() {
    if (this._cachedKey) return this._cachedKey;
    const configured = String(this.explicitSecretKey || process.env.ALFIE_PROVIDER_SECRET_KEY || "").trim();
    if (configured.length >= 16) {
      this._cachedKey = deriveEncryptionKey(configured);
      return this._cachedKey;
    }

    const keyFile = path.join(path.resolve(this.dataDirectory), KEY_FILENAME);
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    try {
      const existing = (await fs.readFile(keyFile, "utf8")).trim();
      if (existing.length >= 32) {
        this._cachedKey = deriveEncryptionKey(existing);
        return this._cachedKey;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const generated = randomBytes(32).toString("hex");
    try {
      const handle = await fs.open(keyFile, "wx", 0o600);
      try {
        await handle.writeFile(generated, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(keyFile, 0o600).catch(() => {});
      this._cachedKey = deriveEncryptionKey(generated);
      return this._cachedKey;
    } catch (error) {
      if (error.code === "EEXIST") {
        const raced = (await fs.readFile(keyFile, "utf8")).trim();
        this._cachedKey = deriveEncryptionKey(raced);
        return this._cachedKey;
      }
      throw error;
    }
  }

  async readPersistedDoc(userId) {
    const doc = await readUserJsonDocument(this.dataDirectory, userId, FILENAME);
    if (!doc || typeof doc !== "object") return null;
    return doc;
  }

  async hydrateDoc(userId, doc) {
    const masterKey = await this.getMasterKey();
    const rawEndpoints = Array.isArray(doc.endpoints) ? doc.endpoints : [];
    const hydrated = rawEndpoints.map((ep, idx) => {
      const decryptedKey = ep?.apiKeyEncrypted
        ? decryptSecret(ep.apiKeyEncrypted, masterKey, userId, ep.id)
        : (typeof ep?.apiKey === "string" ? ep.apiKey : "");
      return normaliseEndpoint({
        ...ep,
        apiKey: decryptedKey
      }, idx, { defaultTrustedLocal: Boolean(ep?.trustedLocal), enforceUrlPolicy: false });
    });

    return {
      mode: VALID_MODES.has(doc.mode) ? doc.mode : "auto",
      healthIntervalSeconds: Number.isFinite(Number(doc.healthIntervalSeconds))
        ? Math.max(10, Math.min(300, Math.round(Number(doc.healthIntervalSeconds))))
        : 30,
      endpoints: hydrated
    };
  }

  async persistConfig(userId, config) {
    const masterKey = await this.getMasterKey();
    const updatedAt = this.now();
    const storedEndpoints = config.endpoints.slice(0, MAX_ENDPOINTS).map((ep) => {
      const encrypted = ep.apiKey ? encryptSecret(ep.apiKey, masterKey, userId, ep.id) : null;
      return {
        id: ep.id,
        name: ep.name,
        mode: ep.mode,
        priority: ep.priority,
        enabled: ep.enabled,
        provider: ep.provider,
        baseUrl: ep.baseUrl,
        trustedLocal: Boolean(ep.trustedLocal),
        model: ep.model,
        apiKeyConfigured: Boolean(encrypted),
        ...(encrypted ? { apiKeyEncrypted: encrypted } : {}),
        temperature: ep.temperature,
        maxTokens: ep.maxTokens
      };
    });

    const payload = {
      version: 1,
      mode: config.mode,
      healthIntervalSeconds: config.healthIntervalSeconds,
      endpoints: storedEndpoints,
      updatedAt
    };

    await writeUserJsonDocument(this.dataDirectory, userId, FILENAME, payload);
    return updatedAt;
  }

  async getEffectiveConfig(userId) {
    const doc = await this.readPersistedDoc(userId);
    if (!doc) {
      return {
        config: normaliseConfig(this.fallbackConfig, { defaultTrustedLocal: true, enforceUrlPolicy: false }),
        source: "environment",
        updatedAt: null
      };
    }
    const config = await this.hydrateDoc(userId, doc);
    return {
      config,
      source: "persisted",
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null
    };
  }

  async getPublicState(userId) {
    const { config, source, updatedAt } = await this.getEffectiveConfig(userId);
    return {
      ...publicConfig(config),
      source,
      updatedAt,
      maxEndpoints: MAX_ENDPOINTS
    };
  }

  async updateSettings(userId, patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw Object.assign(new Error("Provider settings payload must be an object."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
    }
    return this.mutex.run(userId, async () => {
      const { config } = await this.getEffectiveConfig(userId);
      let nextMode = config.mode;
      if (patch.mode !== undefined) {
        if (!VALID_MODES.has(patch.mode)) {
          throw Object.assign(new Error("Routing mode must be one of: auto, light, standard, work."), {
            status: 400,
            code: "INVALID_PROVIDER_CONFIG"
          });
        }
        nextMode = patch.mode;
      }

      let nextInterval = config.healthIntervalSeconds;
      if (patch.healthIntervalSeconds !== undefined) {
        const num = Number(patch.healthIntervalSeconds);
        if (!Number.isFinite(num) || num < 10 || num > 300) {
          throw Object.assign(new Error("Health check interval must be between 10 and 300 seconds."), {
            status: 400,
            code: "INVALID_PROVIDER_CONFIG"
          });
        }
        nextInterval = Math.round(num);
      }

      let nextEndpoints = [...config.endpoints];
      if (Array.isArray(patch.endpointOrder)) {
        const orderIds = patch.endpointOrder.map((id) => String(id || "").trim()).filter(Boolean);
        const byId = new Map(nextEndpoints.map((ep) => [ep.id, ep]));
        const ordered = [];
        for (const id of orderIds) {
          if (byId.has(id)) {
            ordered.push(byId.get(id));
            byId.delete(id);
          }
        }
        for (const leftover of byId.values()) ordered.push(leftover);
        const step = Math.max(5, Math.floor(80 / Math.max(1, ordered.length)));
        nextEndpoints = ordered.map((ep, idx) => ({
          ...ep,
          priority: Math.max(1, Math.min(100, 95 - idx * step))
        }));
      }

      const nextConfig = {
        mode: nextMode,
        healthIntervalSeconds: nextInterval,
        endpoints: nextEndpoints
      };
      const updatedAt = await this.persistConfig(userId, nextConfig);
      return {
        ...publicConfig(nextConfig),
        source: "persisted",
        updatedAt,
        maxEndpoints: MAX_ENDPOINTS
      };
    });
  }

  async addEndpoint(userId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("Endpoint configuration must be an object."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
    }
    return this.mutex.run(userId, async () => {
      const { config } = await this.getEffectiveConfig(userId);
      if (config.endpoints.length >= MAX_ENDPOINTS) {
        throw Object.assign(new Error(`You can configure up to ${MAX_ENDPOINTS} model endpoints.`), {
          status: 400,
          code: "MAX_ENDPOINTS_REACHED"
        });
      }

      if (input.enabled !== undefined) assertStrictBoolean(input.enabled, "enabled");
      if (input.trustedLocal !== undefined) assertStrictBoolean(input.trustedLocal, "trustedLocal");
      if (input.provider !== undefined && !["ollama", "openai-compatible"].includes(input.provider)) {
        throw Object.assign(new Error("Provider must be 'ollama' or 'openai-compatible'."), {
          status: 400,
          code: "INVALID_PROVIDER_CONFIG"
        });
      }
      if (input.mode !== undefined && !VALID_ENDPOINT_MODES.has(input.mode)) {
        throw Object.assign(new Error("Endpoint tier mode must be light, standard, or work."), {
          status: 400,
          code: "INVALID_PROVIDER_CONFIG"
        });
      }

      const existingIds = new Set(config.endpoints.map((ep) => ep.id));
      const desiredId = input.id
        ? String(input.id).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
        : makeEndpointId(input.name || input.provider || "endpoint", existingIds);
      const id = existingIds.has(desiredId) ? makeEndpointId(desiredId, existingIds) : desiredId;

      const endpoint = normaliseEndpoint(
        {
          ...input,
          id,
          trustedLocal: input.trustedLocal === true,
          enabled: input.enabled === undefined ? true : input.enabled
        },
        config.endpoints.length,
        { defaultTrustedLocal: false, enforceUrlPolicy: true }
      );

      const nextConfig = {
        ...config,
        endpoints: [...config.endpoints, endpoint]
      };
      const updatedAt = await this.persistConfig(userId, nextConfig);
      return {
        endpoint: publicEndpoint(endpoint),
        config: { ...publicConfig(nextConfig), source: "persisted", updatedAt, maxEndpoints: MAX_ENDPOINTS }
      };
    });
  }

  async updateEndpoint(userId, endpointId, patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw Object.assign(new Error("Endpoint update payload must be an object."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
    }
    return this.mutex.run(userId, async () => {
      const { config } = await this.getEffectiveConfig(userId);
      const idx = config.endpoints.findIndex((ep) => ep.id === endpointId);
      if (idx === -1) {
        throw Object.assign(new Error("Model endpoint not found."), { status: 404, code: "ENDPOINT_NOT_FOUND" });
      }
      const existing = config.endpoints[idx];

      if (patch.enabled !== undefined) assertStrictBoolean(patch.enabled, "enabled");
      if (patch.trustedLocal !== undefined) assertStrictBoolean(patch.trustedLocal, "trustedLocal");
      if (patch.clearApiKey !== undefined) assertStrictBoolean(patch.clearApiKey, "clearApiKey");
      if (patch.provider !== undefined && !["ollama", "openai-compatible"].includes(patch.provider)) {
        throw Object.assign(new Error("Provider must be 'ollama' or 'openai-compatible'."), {
          status: 400,
          code: "INVALID_PROVIDER_CONFIG"
        });
      }
      if (patch.mode !== undefined && !VALID_ENDPOINT_MODES.has(patch.mode)) {
        throw Object.assign(new Error("Endpoint tier mode must be light, standard, or work."), {
          status: 400,
          code: "INVALID_PROVIDER_CONFIG"
        });
      }

      let nextApiKey = existing.apiKey;
      let keyAction = "unchanged";
      if (patch.clearApiKey === true) {
        nextApiKey = "";
        keyAction = "cleared";
      } else if (typeof patch.apiKey === "string" && patch.apiKey.trim().length > 0) {
        nextApiKey = patch.apiKey.trim();
        keyAction = "updated";
      }

      const merged = normaliseEndpoint(
        {
          ...existing,
          name: patch.name !== undefined ? patch.name : existing.name,
          provider: patch.provider !== undefined ? patch.provider : existing.provider,
          baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl,
          model: patch.model !== undefined ? patch.model : existing.model,
          mode: patch.mode !== undefined ? patch.mode : existing.mode,
          priority: patch.priority !== undefined ? patch.priority : existing.priority,
          enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
          trustedLocal: patch.trustedLocal !== undefined ? patch.trustedLocal : existing.trustedLocal,
          temperature: patch.temperature !== undefined ? patch.temperature : existing.temperature,
          maxTokens: patch.maxTokens !== undefined ? patch.maxTokens : existing.maxTokens,
          apiKey: nextApiKey,
          id: existing.id
        },
        idx,
        { defaultTrustedLocal: Boolean(existing.trustedLocal), enforceUrlPolicy: true }
      );

      const nextEndpoints = [...config.endpoints];
      nextEndpoints[idx] = merged;
      const nextConfig = { ...config, endpoints: nextEndpoints };
      const updatedAt = await this.persistConfig(userId, nextConfig);

      return {
        endpoint: publicEndpoint(merged),
        keyAction,
        config: { ...publicConfig(nextConfig), source: "persisted", updatedAt, maxEndpoints: MAX_ENDPOINTS }
      };
    });
  }

  async removeEndpoint(userId, endpointId) {
    return this.mutex.run(userId, async () => {
      const { config } = await this.getEffectiveConfig(userId);
      const target = config.endpoints.find((ep) => ep.id === endpointId);
      if (!target) {
        throw Object.assign(new Error("Model endpoint not found."), { status: 404, code: "ENDPOINT_NOT_FOUND" });
      }
      const nextEndpoints = config.endpoints.filter((ep) => ep.id !== endpointId);
      const nextConfig = { ...config, endpoints: nextEndpoints };
      const updatedAt = await this.persistConfig(userId, nextConfig);
      return {
        removed: publicEndpoint(target),
        config: { ...publicConfig(nextConfig), source: "persisted", updatedAt, maxEndpoints: MAX_ENDPOINTS }
      };
    });
  }

  /**
   * Builds a validated, non-persisted endpoint object for connection testing.
   * When testing an existing saved endpoint ID without passing a new API key,
   * safely hydrates the stored encrypted key server-side.
   */
  async prepareTestEndpoint(userId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("Test connection payload must be an object."), { status: 400, code: "INVALID_PROVIDER_CONFIG" });
    }
    if (input.trustedLocal !== undefined) assertStrictBoolean(input.trustedLocal, "trustedLocal");
    if (input.clearApiKey !== undefined) assertStrictBoolean(input.clearApiKey, "clearApiKey");

    let existing = null;
    if (typeof input.id === "string" && input.id.trim()) {
      const { config } = await this.getEffectiveConfig(userId);
      existing = config.endpoints.find((ep) => ep.id === input.id.trim()) || null;
    }

    const provider = input.provider !== undefined
      ? input.provider
      : (existing?.provider || "openai-compatible");
    if (!["ollama", "openai-compatible"].includes(provider)) {
      throw Object.assign(new Error("Provider must be 'ollama' or 'openai-compatible'."), {
        status: 400,
        code: "INVALID_PROVIDER_CONFIG"
      });
    }

    const baseUrl = input.baseUrl !== undefined ? input.baseUrl : existing?.baseUrl;
    const trustedLocal = input.trustedLocal !== undefined
      ? input.trustedLocal
      : Boolean(existing?.trustedLocal);

    const urlCheck = validateProviderUrl(baseUrl, { trustedLocal });
    if (!urlCheck.valid) {
      throw Object.assign(new Error(urlCheck.error), { status: 400, code: urlCheck.code });
    }

    let apiKey = "";
    if (input.clearApiKey === true) {
      apiKey = "";
    } else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      apiKey = input.apiKey.trim();
    } else if (existing?.apiKey) {
      apiKey = existing.apiKey;
    }

    return normaliseEndpoint(
      {
        id: existing?.id || "draft-test",
        name: input.name || existing?.name || "Draft endpoint",
        provider,
        baseUrl: urlCheck.url,
        trustedLocal,
        model: input.model !== undefined ? input.model : (existing?.model || ""),
        apiKey
      },
      0,
      { defaultTrustedLocal: trustedLocal, enforceUrlPolicy: true }
    );
  }
}
