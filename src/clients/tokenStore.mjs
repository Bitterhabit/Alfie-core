import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { safeUserKey, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

export const PEER_TOKEN_SCOPES = Object.freeze([
  "capture:write",
  "search:read",
  "status:read",
  "projects:read"
]);

const SCOPE_SET = new Set(PEER_TOKEN_SCOPES);
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_TOKENS_PER_USER = 25;

function cleanString(value, maxLen = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function hashTokenSecret(secret) {
  return createHash("sha256").update(String(secret || ""), "utf8").digest("hex");
}

function encodePeerToken(userId, tokenId, rawSecret) {
  const userB64 = Buffer.from(String(userId), "utf8").toString("base64url");
  return `alf_${userB64}.${tokenId}.${rawSecret}`;
}

export function parsePeerToken(bearerValue) {
  const clean = String(bearerValue || "").trim();
  if (!clean.startsWith("alf_")) return null;
  const body = clean.slice(4);
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  const [userB64, tokenId, rawSecret] = parts;
  if (!userB64 || !UUID_PATTERN.test(tokenId) || !rawSecret || rawSecret.length < 32) return null;
  try {
    const userId = Buffer.from(userB64, "base64url").toString("utf8");
    if (!userId || userId.length > 128) return null;
    return { userId, tokenId, rawSecret };
  } catch {
    return null;
  }
}

/**
 * Per-user Scoped Peer Client Token Store (Phase 6.3).
 * Stores ONLY SHA-256 hashes of high-entropy 32-byte tokens (never plaintext after creation).
 */
export class PeerTokenStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "peer-tokens.json");
    if (!store) return { schemaVersion: 1, ownerId: userId, tokens: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.tokens)) {
      throw new Error("Peer token store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    await writeUserJsonDocument(this.dataDirectory, userId, "peer-tokens.json", store, { uuid: this.uuid });
  }

  sanitizeRecord(rec) {
    return {
      id: rec.id,
      name: rec.name,
      prefix: rec.prefix,
      scopes: rec.scopes,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      lastUsedAt: rec.lastUsedAt,
      revokedAt: rec.revokedAt
    };
  }

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return store.tokens.map((t) => this.sanitizeRecord(t));
    });
  }

  async create(userId, input = {}) {
    const name = cleanString(input.name, 80);
    if (!name) {
      throw Object.assign(new Error("A token name is required (e.g. 'Laptop CLI' or 'Phone Shortcut')."), { status: 400 });
    }
    const requestedScopes = Array.isArray(input.scopes) ? input.scopes : ["capture:write", "status:read"];
    const scopes = Array.from(new Set(requestedScopes.map((s) => cleanString(s, 40)).filter((s) => SCOPE_SET.has(s))));
    if (!scopes.length) {
      throw Object.assign(new Error(`Select at least one valid scope: ${PEER_TOKEN_SCOPES.join(", ")}.`), { status: 400 });
    }

    let expiresAt = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== "") {
      const days = Number(input.expiresInDays);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        throw Object.assign(new Error("expiresInDays must be between 1 and 365."), { status: 400 });
      }
      expiresAt = new Date(Date.parse(this.now()) + Math.floor(days) * 86400000).toISOString();
    }

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const nowIso = this.now();
      const nowMs = Date.parse(nowIso);
      const activeCount = store.tokens.filter((token) => {
        if (token.revokedAt) return false;
        if (!token.expiresAt) return true;
        const expiresAtMs = Date.parse(token.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      }).length;
      if (activeCount >= MAX_TOKENS_PER_USER) {
        throw Object.assign(new Error(`Maximum of ${MAX_TOKENS_PER_USER} active peer tokens reached.`), { status: 400 });
      }

      const tokenId = this.uuid();
      const rawSecret = randomBytes(32).toString("base64url");
      const tokenString = encodePeerToken(userId, tokenId, rawSecret);

      const record = {
        id: tokenId,
        name,
        prefix: `${tokenString.slice(0, 14)}…`,
        secretHash: hashTokenSecret(rawSecret),
        scopes,
        createdAt: nowIso,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null
      };

      store.tokens = [record, ...store.tokens].slice(0, 60);
      await this.save(userId, store);

      return {
        token: tokenString,
        record: this.sanitizeRecord(record)
      };
    });
  }

  async revoke(userId, tokenId) {
    if (!UUID_PATTERN.test(String(tokenId || ""))) {
      throw Object.assign(new Error("Peer token not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idx = store.tokens.findIndex((t) => t.id === tokenId);
      if (idx === -1) throw Object.assign(new Error("Peer token not found."), { status: 404 });
      store.tokens[idx] = {
        ...store.tokens[idx],
        revokedAt: store.tokens[idx].revokedAt || this.now()
      };
      await this.save(userId, store);
      return this.sanitizeRecord(store.tokens[idx]);
    });
  }

  /**
   * Authenticates a Bearer peer token and enforces an optional required scope.
   * Uses constant-time hash comparison and updates lastUsedAt on success.
   */
  async authenticate(bearerToken, requiredScope = null) {
    const parsed = parsePeerToken(bearerToken);
    if (!parsed) return null;
    const { userId, tokenId, rawSecret } = parsed;

    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const idx = store.tokens.findIndex((t) => t.id === tokenId);
      if (idx === -1) return null;

      const rec = store.tokens[idx];
      if (rec.revokedAt) return null;

      const nowIso = this.now();
      if (rec.expiresAt) {
        const expiresAtMs = Date.parse(rec.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.parse(nowIso)) return null;
      }

      const providedHash = Buffer.from(hashTokenSecret(rawSecret), "utf8");
      const storedHash = Buffer.from(String(rec.secretHash || ""), "utf8");
      if (providedHash.length !== storedHash.length || !timingSafeEqual(providedHash, storedHash)) {
        return null;
      }

      if (requiredScope && !rec.scopes.includes(requiredScope)) {
        throw Object.assign(
          new Error(`Peer token lacks required scope "${requiredScope}".`),
          { status: 403, code: "PEER_SCOPE_DENIED" }
        );
      }

      store.tokens[idx] = { ...rec, lastUsedAt: nowIso };
      await this.save(userId, store);
      return {
        userId,
        tokenId: rec.id,
        name: rec.name,
        scopes: rec.scopes
      };
    });
  }
}
