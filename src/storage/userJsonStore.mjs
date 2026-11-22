import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;

export function safeUserKey(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

export function userDataFile(dataDirectory, userId, filename) {
  return path.join(path.resolve(dataDirectory), "users", safeUserKey(userId), filename);
}

export class UserMutex {
  constructor() {
    this.queues = new Map();
  }

  async run(key, operation) {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const queued = current.catch(() => {});
    this.queues.set(key, queued);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === queued) {
        this.queues.delete(key);
      }
    }
  }
}

export async function atomicWriteJson(filePath, data, { uuid = randomUUID, pretty = true } = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${filePath}.${uuid()}.tmp`;
  const payload = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readUserJsonDocument(dataDirectory, userId, filename, { backend } = {}) {
  const { resolveStorageBackend, readUserSqliteDocument } = await import("./sqliteStore.mjs");
  if (resolveStorageBackend(backend) === "sqlite") {
    return readUserSqliteDocument(dataDirectory, userId, filename);
  }
  const filePath = userDataFile(dataDirectory, userId, filename);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeUserJsonDocument(dataDirectory, userId, filename, data, { backend, uuid = randomUUID, pretty = true } = {}) {
  const { resolveStorageBackend, writeUserSqliteDocument } = await import("./sqliteStore.mjs");
  if (resolveStorageBackend(backend) === "sqlite") {
    return writeUserSqliteDocument(dataDirectory, userId, filename, data);
  }
  const filePath = userDataFile(dataDirectory, userId, filename);
  await atomicWriteJson(filePath, data, { uuid, pretty });
  return { revision: 1, updatedAt: new Date().toISOString(), indexedRows: 0 };
}


const documentBatchMutex = new UserMutex();

/**
 * Writes multiple user documents as one SQLite transaction. The JSON fallback
 * uses atomic per-file replacements with compensating rollback on failure.
 */
export async function writeUserJsonDocuments(dataDirectory, userId, documents, { backend } = {}) {
  const key = safeUserKey(userId);
  if (!Array.isArray(documents) || documents.some((entry) =>
    !entry || typeof entry.filename !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.filename) ||
    !Object.prototype.hasOwnProperty.call(entry, "data")
  ) || new Set(documents.map((entry) => entry.filename)).size !== documents.length) {
    throw new TypeError("A valid, unique user document batch is required.");
  }
  return documentBatchMutex.run(key, async () => {
    const { resolveStorageBackend, writeUserSqliteDocuments } = await import("./sqliteStore.mjs");
    if (resolveStorageBackend(backend) === "sqlite") {
      return writeUserSqliteDocuments(dataDirectory, userId, documents.map(({ filename, data }) => ({
        collection: filename, payload: data
      })));
    }

    const snapshots = [];
    for (const { filename } of documents) {
      const filePath = userDataFile(dataDirectory, userId, filename);
      try {
        snapshots.push({ filePath, existed: true, data: JSON.parse(await fs.readFile(filePath, "utf8")) });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        snapshots.push({ filePath, existed: false });
      }
    }

    const written = [];
    try {
      for (const entry of documents) {
        const filePath = userDataFile(dataDirectory, userId, entry.filename);
        // Track before the write: atomicWriteJson can rename successfully and
        // then fail during its final chmod, leaving this path modified.
        written.push(filePath);
        await atomicWriteJson(filePath, entry.data);
      }
    } catch (writeError) {
      const rollbackErrors = [];
      for (const snapshot of snapshots.filter((item) => written.includes(item.filePath)).reverse()) {
        try {
          if (snapshot.existed) await atomicWriteJson(snapshot.filePath, snapshot.data);
          else await fs.unlink(snapshot.filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw Object.assign(new Error("Document batch failed and rollback was incomplete; inspect workspace storage before retrying.", {
          cause: writeError
        }), { code: "DOCUMENT_BATCH_ROLLBACK_FAILED", rollbackErrors });
      }
      throw writeError;
    }
    return documents.map(({ filename }) => ({ collection: filename, revision: 1, indexedRows: 0 }));
  });
}

export async function searchUserWorkspace(dataDirectory, userId, options = {}) {
  const { resolveStorageBackend, searchUserSqlite, searchUserJsonFallback } = await import("./sqliteStore.mjs");
  if (resolveStorageBackend(options.backend) === "sqlite") {
    return searchUserSqlite(dataDirectory, userId, options);
  }
  return searchUserJsonFallback(dataDirectory, userId, options);
}

