import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function makeCode() {
  const bytes = randomBytes(10);
  return [...bytes].map((value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

function assertUserId(value) {
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
}

export class IdentityLinkStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => Date.now() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.file = path.join(this.dataDirectory, "identity-links.json");
    this.now = now;
    this.queue = Promise.resolve();
  }

  async exclusive(operation) {
    const current = this.queue.then(operation, operation);
    this.queue = current.catch(() => {});
    return current;
  }

  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (value.schemaVersion !== 1 || !Array.isArray(value.links) || !Array.isArray(value.codes)) {
        throw new Error("Identity link store failed its integrity check.");
      }
      if (!Array.isArray(value.attempts)) value.attempts = [];
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, links: [], codes: [], attempts: [] };
      throw error;
    }
  }

  async save(value) {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDirectory, 0o700);
    const temporary = path.join(this.dataDirectory, "identity-links." + randomUUID() + ".tmp");
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
  }

  async createCode(canonicalUserId, { ttlMs = 5 * 60 * 1000 } = {}) {
    assertUserId(canonicalUserId);
    return this.exclusive(async () => {
      const store = await this.load();
      const now = this.now();
      store.codes = store.codes.filter((item) => item.expiresAt > now);
      store.codes = store.codes.filter((item) => item.canonicalUserId !== canonicalUserId);
      let code;
      let hash;
      do {
        code = makeCode();
        hash = digest(code);
      } while (store.codes.some((item) => item.hash === hash));
      const expiresAt = now + Math.max(30_000, Math.min(10 * 60 * 1000, Number(ttlMs) || 5 * 60 * 1000));
      store.codes.push({ id: randomUUID(), hash, canonicalUserId, createdAt: now, expiresAt, attempts: 0 });
      await this.save(store);
      return { code, expiresAt };
    });
  }

  async consumeCode(providerId, subjectId, suppliedCode) {
    if (typeof providerId !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(providerId)) {
      throw Object.assign(new Error("Identity provider is invalid."), { status: 400 });
    }
    assertUserId(subjectId);
    const code = String(suppliedCode || "").trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code)) {
      throw Object.assign(new Error("Enter a valid account-link code."), { status: 400 });
    }
    return this.exclusive(async () => {
      const store = await this.load();
      const now = this.now();
      store.codes = store.codes.filter((item) => item.expiresAt > now);
      store.attempts = store.attempts.filter((item) => item.resetAt > now);
      const attempt = store.attempts.find((item) => item.providerId === providerId && item.subjectId === subjectId);
      if (attempt && attempt.count >= 5) {
        throw Object.assign(new Error("Too many account-link attempts. Request a fresh code and try again later."), { status: 429, code: "IDENTITY_LINK_RATE_LIMITED" });
      }
      if (store.links.some((item) => item.providerId === providerId && item.subjectId === subjectId)) {
        throw Object.assign(new Error("This interface account is already linked."), { status: 409, code: "IDENTITY_ALREADY_LINKED" });
      }
      const hash = digest(code);
      const pending = store.codes.find((item) => item.hash === hash);
      if (!pending) {
        if (attempt) attempt.count += 1;
        else store.attempts.push({ providerId, subjectId, count: 1, resetAt: now + 10 * 60 * 1000 });
        await this.save(store);
        throw Object.assign(new Error("The account-link code is invalid, expired or already used."), { status: 404, code: "IDENTITY_LINK_CODE_INVALID" });
      }
      const existing = store.links.find((item) => item.providerId === providerId && item.canonicalUserId === pending.canonicalUserId);
      if (existing) {
        throw Object.assign(new Error("A different account for this identity provider is already linked to this user."), { status: 409, code: "IDENTITY_PROVIDER_ALREADY_LINKED" });
      }
      store.codes = store.codes.filter((item) => item.id !== pending.id);
      store.attempts = store.attempts.filter((item) => !(item.providerId === providerId && item.subjectId === subjectId));
      store.links.push({
        id: randomUUID(), providerId, subjectId,
        canonicalUserId: pending.canonicalUserId,
        linkedAt: new Date(now).toISOString()
      });
      await this.save(store);
      return { linked: true };
    });
  }

  async resolve(providerId, subjectId) {
    assertUserId(subjectId);
    return this.exclusive(async () => {
      const store = await this.load();
      return store.links.find((item) => item.providerId === providerId && item.subjectId === subjectId)?.canonicalUserId || null;
    });
  }

  async unlink(providerId, subjectId) {
    assertUserId(subjectId);
    return this.exclusive(async () => {
      const store = await this.load();
      const before = store.links.length;
      store.links = store.links.filter((item) => !(item.providerId === providerId && item.subjectId === subjectId));
      if (before !== store.links.length) await this.save(store);
      return { unlinked: before !== store.links.length };
    });
  }
}
