import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable, cross-process one-time nonce consumption for signed identity assertions.
 * The database must live on persistent local storage shared by every Core instance
 * that accepts assertions for the same identity provider.
 */
export class IdentityReplayStore {
  constructor({ filePath } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("A persistent identity replay database path is required.");
    }
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_replay_nonces (
        provider_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, user_id, nonce_hash)
      );
      CREATE INDEX IF NOT EXISTS identity_replay_expiry
        ON identity_replay_nonces (expires_at);
    `);
    try { fs.chmodSync(resolvedPath, 0o600); } catch {}
    this.deleteExpired = this.db.prepare("DELETE FROM identity_replay_nonces WHERE expires_at <= ?");
    this.countEntries = this.db.prepare("SELECT COUNT(*) AS count FROM identity_replay_nonces");
    this.insertNonce = this.db.prepare(`
      INSERT OR IGNORE INTO identity_replay_nonces
        (provider_id, user_id, nonce_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `);
  }

  consume({ providerId, userId, nonce, expiresAt, now, maxEntries = 100000 } = {}) {
    if (![providerId, userId, nonce].every((value) => typeof value === "string" && value.length > 0) ||
        !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now)) {
      throw new TypeError("A valid identity replay record is required.");
    }
    const limit = Math.max(1, Math.floor(Number(maxEntries) || 100000));
    const nonceHash = createHash("sha256").update(nonce, "utf8").digest("hex");

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.deleteExpired.run(now);
      const count = Number(this.countEntries.get().count);
      if (count >= limit) {
        throw Object.assign(new Error("The identity replay database is full; retry after older assertions expire."), {
          status: 503,
          code: "IDENTITY_REPLAY_CACHE_FULL"
        });
      }
      const result = this.insertNonce.run(providerId, userId, nonceHash, expiresAt);
      this.db.exec("COMMIT;");
      return Number(result.changes) === 1;
    } catch (error) {
      try { this.db.exec("ROLLBACK;"); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
