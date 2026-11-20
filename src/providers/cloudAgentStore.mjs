import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CLOUD_VISIBILITY,
  PRIVACY_CATEGORIES,
  hasAnyPersonalVisibility,
  normaliseVisibility,
  stripPersonalVisibility,
  summarizePrivacy
} from "../privacy/policy.mjs";

export const CLOUD_PROVIDER_CATALOG = Object.freeze({
  gemini: Object.freeze({
    id: "gemini",
    name: "Gemini API",
    vendor: "Google",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-4-hydrogen",
    models: Object.freeze([
      { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen (Recommended coding)" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (Fast)" }
    ]),
    privacyWarning: "Prompts sent to Gemini API leave your local machine and are processed by Google's cloud servers. Emails, Calendar, Journal, Garden Memories, and Dashboard data stay strictly blocked unless you explicitly enable them below."
  }),
  openai: Object.freeze({
    id: "openai",
    name: "ChatGPT (OpenAI)",
    vendor: "OpenAI",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    models: Object.freeze([
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini (Fast coding)" },
      { id: "gpt-4.1", label: "GPT-4.1 (Deep coding)" },
      { id: "o4-mini", label: "o4-mini (Reasoning)" },
      { id: "gpt-4o", label: "GPT-4o" }
    ]),
    privacyWarning: "Prompts sent to ChatGPT (OpenAI API) leave your local machine and are processed by OpenAI's cloud servers. Emails, Calendar, Journal, Garden Memories, and Dashboard data stay strictly blocked unless you explicitly enable them below."
  })
});

const ALLOWED_PROVIDER_IDS = Object.keys(CLOUD_PROVIDER_CATALOG);
const FORBIDDEN_SECRET_KEYS = new Set(["apiKey", "apikey", "api_key", "secret", "token", "accessToken", "bearerToken"]);

function userHash(userId) {
  if (typeof userId !== "string" || !userId.trim()) {
    throw Object.assign(new Error("A valid user ID is required."), { status: 400 });
  }
  return createHash("sha256").update(userId.trim()).digest("hex");
}

function defaultAgentRecord(providerId) {
  const catalog = CLOUD_PROVIDER_CATALOG[providerId];
  return {
    provider: providerId,
    enabled: false,
    privacyWarningAccepted: false,
    privacyWarningAcceptedAt: null,
    privateAccessOptIn: false,
    privateAccessOptInAt: null,
    model: catalog.defaultModel,
    role: "coding",
    visibility: normaliseVisibility(DEFAULT_CLOUD_VISIBILITY),
    updatedAt: null
  };
}

function normaliseAgentRecord(providerId, record) {
  const catalog = CLOUD_PROVIDER_CATALOG[providerId];
  const source = record && typeof record === "object" ? record : {};
  const validModels = new Set(catalog.models.map((m) => m.id));
  const model = typeof source.model === "string" && validModels.has(source.model)
    ? source.model
    : catalog.defaultModel;
  const privacyWarningAccepted = source.privacyWarningAccepted === true;
  const enabled = privacyWarningAccepted && source.enabled === true;
  const rawVisibility = normaliseVisibility(source.visibility);
  // Fail-closed: private section flags can only stay active when privateAccessOptIn is explicitly true.
  const privateAccessOptIn = source.privateAccessOptIn === true;
  const visibility = privateAccessOptIn ? rawVisibility : stripPersonalVisibility(rawVisibility);

  return {
    provider: providerId,
    enabled,
    privacyWarningAccepted,
    privacyWarningAcceptedAt: privacyWarningAccepted && typeof source.privacyWarningAcceptedAt === "string"
      ? source.privacyWarningAcceptedAt
      : null,
    privateAccessOptIn,
    privateAccessOptInAt: privateAccessOptIn && typeof source.privateAccessOptInAt === "string"
      ? source.privateAccessOptInAt
      : null,
    model,
    role: "coding",
    visibility,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null
  };
}

export class CloudAgentStore {
  constructor({
    dataDirectory = process.env.ALFIE_CORE_DATA_DIR || path.resolve(process.cwd(), "data"),
    env = process.env,
    now = () => new Date().toISOString()
  } = {}) {
    this.dataDirectory = dataDirectory;
    this.env = env;
    this.now = now;
  }

  filePath(userId) {
    return path.join(this.dataDirectory, "users", userHash(userId), "cloud-agents.json");
  }

  secretConfigured(providerId) {
    const catalog = CLOUD_PROVIDER_CATALOG[providerId];
    if (!catalog) return false;
    const value = this.env?.[catalog.envVar];
    return typeof value === "string" && value.trim().length > 0;
  }

  async readRaw(userId) {
    const target = this.filePath(userId);
    try {
      const content = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(content);
      return {
        gemini: normaliseAgentRecord("gemini", parsed?.agents?.gemini),
        openai: normaliseAgentRecord("openai", parsed?.agents?.openai)
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          gemini: defaultAgentRecord("gemini"),
          openai: defaultAgentRecord("openai")
        };
      }
      throw error;
    }
  }

  async writeRaw(userId, agents) {
    const target = this.filePath(userId);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = JSON.stringify({ version: 1, agents }, null, 2);
    await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600).catch(() => {});
  }

  toPublicAgent(providerId, record) {
    const catalog = CLOUD_PROVIDER_CATALOG[providerId];
    const normalised = normaliseAgentRecord(providerId, record);
    const configured = this.secretConfigured(providerId);
    return {
      ...normalised,
      name: catalog.name,
      vendor: catalog.vendor,
      envVar: catalog.envVar,
      secretConfigured: configured,
      ready: normalised.enabled && normalised.privacyWarningAccepted && configured,
      models: catalog.models,
      privacyWarning: catalog.privacyWarning,
      privacySummary: summarizePrivacy(normalised.visibility)
    };
  }

  async getPublicState(userId) {
    const raw = await this.readRaw(userId);
    const agents = ALLOWED_PROVIDER_IDS.map((providerId) => this.toPublicAgent(providerId, raw[providerId]));
    return {
      agents,
      categories: PRIVACY_CATEGORIES,
      defaultVisibility: DEFAULT_CLOUD_VISIBILITY
    };
  }

  async getAgent(userId, providerId) {
    if (!ALLOWED_PROVIDER_IDS.includes(providerId)) {
      throw Object.assign(new Error("Unknown cloud agent provider. Supported providers are gemini and openai."), {
        status: 404,
        code: "CLOUD_PROVIDER_UNKNOWN"
      });
    }
    const raw = await this.readRaw(userId);
    return this.toPublicAgent(providerId, raw[providerId]);
  }

  async updateAgent(userId, providerId, patch = {}) {
    if (!ALLOWED_PROVIDER_IDS.includes(providerId)) {
      throw Object.assign(new Error("Unknown cloud agent provider. Supported providers are gemini and openai."), {
        status: 404,
        code: "CLOUD_PROVIDER_UNKNOWN"
      });
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw Object.assign(new Error("Cloud agent update payload must be an object."), { status: 400 });
    }
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_SECRET_KEYS.has(key)) {
        throw Object.assign(
          new Error(`API keys cannot be submitted from the browser. Configure ${CLOUD_PROVIDER_CATALOG[providerId].envVar} in your server environment or Settings > Secrets.`),
          { status: 400, code: "SECRET_IN_CLIENT_FORBIDDEN" }
        );
      }
    }

    const catalog = CLOUD_PROVIDER_CATALOG[providerId];
    const raw = await this.readRaw(userId);
    const current = raw[providerId];

    let nextAccepted = current.privacyWarningAccepted;
    let nextAcceptedAt = current.privacyWarningAcceptedAt;
    if (typeof patch.privacyWarningAccepted === "boolean") {
      nextAccepted = patch.privacyWarningAccepted;
      if (nextAccepted && !current.privacyWarningAccepted) {
        nextAcceptedAt = this.now();
      } else if (!nextAccepted) {
        nextAcceptedAt = null;
      }
    }

    const requestedEnabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
    if (requestedEnabled && !nextAccepted) {
      throw Object.assign(
        new Error(`Review and accept the privacy warning before enabling ${catalog.name}.`),
        { status: 400, code: "PRIVACY_WARNING_REQUIRED" }
      );
    }

    let nextModel = current.model;
    if (patch.model !== undefined) {
      const validModels = new Set(catalog.models.map((m) => m.id));
      if (typeof patch.model !== "string" || !validModels.has(patch.model)) {
        throw Object.assign(
          new Error(`Unsupported model for ${catalog.name}. Allowed models: ${[...validModels].join(", ")}.`),
          { status: 400, code: "CLOUD_MODEL_INVALID" }
        );
      }
      nextModel = patch.model;
    }

    let nextPrivateOptIn = current.privateAccessOptIn === true;
    let nextPrivateOptInAt = current.privateAccessOptInAt || null;
    if (patch.preset === "coding-only") {
      nextPrivateOptIn = false;
      nextPrivateOptInAt = null;
    } else if (typeof patch.privateAccessOptIn === "boolean") {
      nextPrivateOptIn = patch.privateAccessOptIn;
      if (nextPrivateOptIn && !current.privateAccessOptIn) {
        nextPrivateOptInAt = this.now();
      } else if (!nextPrivateOptIn) {
        nextPrivateOptInAt = null;
      }
    }

    let nextVisibility = current.visibility;
    if (patch.preset === "coding-only") {
      nextVisibility = normaliseVisibility(DEFAULT_CLOUD_VISIBILITY);
    } else if (patch.visibility !== undefined) {
      if (!patch.visibility || typeof patch.visibility !== "object" || Array.isArray(patch.visibility)) {
        throw Object.assign(new Error("Visibility settings must be an object of boolean flags."), { status: 400 });
      }
      const merged = normaliseVisibility({ ...current.visibility, ...patch.visibility });
      if (hasAnyPersonalVisibility(merged) && !nextPrivateOptIn) {
        if (patch.privateAccessOptIn === false) {
          nextVisibility = stripPersonalVisibility(merged);
        } else {
          throw Object.assign(
            new Error(`Enable optional private section access for ${catalog.name} before granting access to personal sections.`),
            { status: 400, code: "PRIVATE_ACCESS_OPT_IN_REQUIRED" }
          );
        }
      } else {
        nextVisibility = nextPrivateOptIn ? merged : stripPersonalVisibility(merged);
      }
    } else if (!nextPrivateOptIn) {
      nextVisibility = stripPersonalVisibility(current.visibility);
    }

    const updated = {
      provider: providerId,
      enabled: nextAccepted ? requestedEnabled : false,
      privacyWarningAccepted: nextAccepted,
      privacyWarningAcceptedAt: nextAcceptedAt,
      privateAccessOptIn: nextPrivateOptIn,
      privateAccessOptInAt: nextPrivateOptInAt,
      model: nextModel,
      role: "coding",
      visibility: nextVisibility,
      updatedAt: this.now()
    };

    raw[providerId] = updated;
    await this.writeRaw(userId, raw);
    return this.toPublicAgent(providerId, updated);
  }
}
