import fs from "node:fs/promises";
import path from "node:path";
import {
  createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const scryptAsync = promisify(scrypt);
const DUMMY_SALT = "alfie-interface-dummy-salt-v1";
const DUMMY_HASH = scryptSync("not-a-real-alfie-password", DUMMY_SALT, 64).toString("hex");

async function passwordDigest(password, salt) {
  return (await scryptAsync(password, salt, 64)).toString("hex");
}

function validateCredentials(username, password) {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    throw Object.assign(new Error("Username must be 3–32 characters using letters, numbers, dots, underscores or hyphens."), { status: 400 });
  }
  if (typeof password !== "string" || password.length < 16 || password.length > 256) {
    throw Object.assign(new Error("Choose a password between 16 and 256 characters."), { status: 400 });
  }
}

export class InterfaceAuthStore {
  constructor({ dataDirectory = process.env.ALFIE_UI_DATA_DIR || "/data", now = () => Date.now() } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.file = path.join(this.dataDirectory, "accounts.json");
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
      if (value.schemaVersion !== 1 || !Array.isArray(value.users) || !Array.isArray(value.sessions)) {
        throw new Error("Interface account store failed its integrity check.");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, users: [], sessions: [] };
      throw error;
    }
  }

  async save(value) {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDirectory, 0o700);
    const temporary = path.join(this.dataDirectory, "accounts." + randomUUID() + ".tmp");
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
  }

  async bootstrap(username, password) {
    return this.exclusive(async () => {
      const store = await this.load();
      if (store.users.length) return { created: false };
      validateCredentials(username, password);
      const salt = randomBytes(16).toString("hex");
      const user = {
        id: randomUUID(),
        username: username.trim(),
        displayName: username.trim(),
        passwordSalt: salt,
        passwordHash: await passwordDigest(password, salt),
        createdAt: new Date(this.now()).toISOString(),
        disabled: false
      };
      store.users.push(user);
      await this.save(store);
      return { created: true, user: this.publicUser(user) };
    });
  }

  async setupRequired() {
    return this.exclusive(async () => (await this.load()).users.length === 0);
  }

  publicUser(user) {
    return { id: user.id, username: user.username, displayName: user.displayName };
  }

  async login(username, password, { ip = "unknown" } = {}) {
    return this.exclusive(async () => {
      const store = await this.load();
      const user = store.users.find((item) => item.username.toLowerCase() === String(username || "").trim().toLowerCase());
      const validPasswordShape = typeof password === "string" && password.length >= 16 && password.length <= 256;
      const candidate = typeof password === "string" ? password.slice(0, 256) : "";
      // Always perform a password derivation, including for unknown/disabled users,
      // so account existence is not exposed by a cheap early-return path.
      const actual = Buffer.from(await passwordDigest(candidate, user?.passwordSalt || DUMMY_SALT), "hex");
      const expected = Buffer.from(user?.passwordHash || DUMMY_HASH, "hex");
      const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!user || user.disabled || !validPasswordShape || !matches) {
        throw Object.assign(new Error("Username or password was not accepted."), { status: 401 });
      }
      const now = this.now();
      store.sessions = store.sessions.filter((item) => item.absoluteExpiresAt > now && item.idleExpiresAt > now);
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      store.sessions.push({
        id: randomUUID(), tokenHash: digest(token), csrfToken,
        userId: user.id, createdAt: now, lastSeenAt: now,
        idleExpiresAt: now + SESSION_IDLE_MS,
        absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
        ip: String(ip).slice(0, 100)
      });
      await this.save(store);
      return { token, csrfToken, user: this.publicUser(user) };
    });
  }

  async authenticate(token) {
    if (typeof token !== "string" || token.length < 32) return null;
    return this.exclusive(async () => {
      const store = await this.load();
      const now = this.now();
      const hash = digest(token);
      const session = store.sessions.find((item) => item.tokenHash === hash);
      if (!session) return null;
      const user = store.users.find((item) => item.id === session.userId);
      if (!user || user.disabled || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
        store.sessions = store.sessions.filter((item) => item.id !== session.id);
        await this.save(store);
        return null;
      }
      if (now - session.lastSeenAt > 60_000) {
        session.lastSeenAt = now;
        session.idleExpiresAt = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt);
        await this.save(store);
      }
      return { user: this.publicUser(user), csrfToken: session.csrfToken, sessionId: session.id };
    });
  }

  async changePassword(currentPassword, newPassword) {
    return this.exclusive(async () => {
      const store = await this.load();
      const user = store.users[0];
      if (!user || user.disabled) throw Object.assign(new Error("The interface account is unavailable."), { status: 401 });
      const validCurrentShape = typeof currentPassword === "string" && currentPassword.length >= 16 && currentPassword.length <= 256;
      const candidate = typeof currentPassword === "string" ? currentPassword.slice(0, 256) : "";
      const actual = Buffer.from(await passwordDigest(candidate, user.passwordSalt), "hex");
      const expected = Buffer.from(user.passwordHash, "hex");
      const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!validCurrentShape || !matches) {
        throw Object.assign(new Error("Your current password was not accepted."), { status: 401 });
      }
      validateCredentials(user.username, newPassword);
      if (currentPassword === newPassword) {
        throw Object.assign(new Error("Choose a new password that is different from your current password."), { status: 400 });
      }
      const salt = randomBytes(16).toString("hex");
      user.passwordSalt = salt;
      user.passwordHash = await passwordDigest(newPassword, salt);
      store.sessions = [];
      await this.save(store);
      return { changed: true };
    });
  }

  async logout(token) {
    if (typeof token !== "string" || token.length < 32) return;
    await this.exclusive(async () => {
      const store = await this.load();
      const hash = digest(token);
      const before = store.sessions.length;
      store.sessions = store.sessions.filter((item) => item.tokenHash !== hash);
      if (store.sessions.length !== before) await this.save(store);
    });
  }
}
