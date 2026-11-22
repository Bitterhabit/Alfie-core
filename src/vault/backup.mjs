import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { readUserJsonDocument, writeUserJsonDocuments } from "../storage/userJsonStore.mjs";

export const VAULT_FORMAT = "alfie-sovereign-vault";
export const VAULT_FORMAT_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_VAULT_BYTES = 16 * 1024 * 1024; // 16 MiB safety cap

export const VAULT_COLLECTIONS = Object.freeze([
  "memories.json",
  "projects.json",
  "ideas.json",
  "conversations.json",
  "permissions.json",
  "watchers.json",
  "watcher-events.json",
  "workflow-profile.json",
  "context-capsules.json",
  "jobs.json",
  "reflections.json",
  "playbooks.json"
]);

const VAULT_COLLECTION_SET = new Set(VAULT_COLLECTIONS);
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function validatePassphrase(passphrase) {
  const clean = String(passphrase || "");
  if (clean.length < MIN_PASSPHRASE_LENGTH) {
    throw Object.assign(
      new Error(`Vault passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`),
      { status: 400, code: "WEAK_PASSPHRASE" }
    );
  }
  if (clean.length > 512) {
    throw Object.assign(new Error("Vault passphrase is too long."), { status: 400, code: "INVALID_PASSPHRASE" });
  }
  return clean;
}

function deriveVaultKey(passphrase, saltBuffer) {
  return scryptSync(passphrase, saltBuffer, 32, SCRYPT_PARAMS);
}

function buildAad(userId, formatVersion) {
  return Buffer.from(`${VAULT_FORMAT}:v${formatVersion}:${String(userId || "")}`, "utf8");
}

function summarizeCollectionCount(collection, doc) {
  if (!doc || typeof doc !== "object") return 0;
  if (collection === "memories.json") return Array.isArray(doc.memories) ? doc.memories.length : 0;
  if (collection === "projects.json") return Array.isArray(doc.projects) ? doc.projects.length : 0;
  if (collection === "ideas.json") return Array.isArray(doc.ideas) ? doc.ideas.length : 0;
  if (collection === "conversations.json") return Array.isArray(doc.conversations) ? doc.conversations.length : 0;
  if (collection === "permissions.json") return Array.isArray(doc.leases) ? doc.leases.length : (Array.isArray(doc.scopes) ? doc.scopes.length : 0);
  if (collection === "watchers.json") return Array.isArray(doc.watchers) ? doc.watchers.length : 0;
  if (collection === "watcher-events.json") return Array.isArray(doc.events) ? doc.events.length : 0;
  if (collection === "context-capsules.json") return Array.isArray(doc.capsules) ? doc.capsules.length : 0;
  if (collection === "jobs.json") return Array.isArray(doc.jobs) ? doc.jobs.length : 0;
  if (collection === "reflections.json") return Array.isArray(doc.snapshots) ? doc.snapshots.length : 0;
  if (collection === "playbooks.json") return Array.isArray(doc.playbooks) ? doc.playbooks.length : 0;
  if (collection === "workflow-profile.json") return 1;
  return 0;
}

/**
 * Exports all non-secret per-user workspace collections into an authenticated
 * AES-256-GCM + scrypt encrypted sovereign vault archive.
 */
export async function exportEncryptedVault({
  dataDirectory,
  userId,
  passphrase,
  now = () => new Date().toISOString()
}) {
  const cleanPass = validatePassphrase(passphrase);
  const exportedAt = now();
  const collections = {};
  const counts = {};

  for (const name of VAULT_COLLECTIONS) {
    const doc = await readUserJsonDocument(dataDirectory, userId, name);
    if (doc && typeof doc === "object") {
      collections[name] = doc;
      counts[name] = summarizeCollectionCount(name, doc);
    }
  }

  const plaintextPayload = {
    format: VAULT_FORMAT,
    version: VAULT_FORMAT_VERSION,
    ownerId: userId,
    exportedAt,
    collections
  };
  const plaintextJson = JSON.stringify(plaintextPayload);
  const manifestSha256 = sha256Hex(plaintextJson);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveVaultKey(cleanPass, salt);
  const aad = buildAad(userId, VAULT_FORMAT_VERSION);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const archive = {
    format: VAULT_FORMAT,
    version: VAULT_FORMAT_VERSION,
    exportedAt,
    kdf: {
      algorithm: "scrypt",
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      salt: salt.toString("base64")
    },
    cipher: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64")
    },
    manifestSha256,
    collectionCount: Object.keys(collections).length,
    ciphertext: encrypted.toString("base64")
  };

  return {
    archive,
    summary: {
      exportedAt,
      collectionCount: Object.keys(collections).length,
      counts,
      manifestSha256,
      encryptedBytes: Buffer.byteLength(JSON.stringify(archive), "utf8")
    }
  };
}

function decryptVaultArchive(archive, userId, passphrase) {
  const cleanPass = validatePassphrase(passphrase);
  if (!archive || typeof archive !== "object") {
    throw Object.assign(new Error("Vault archive must be a JSON object."), { status: 400, code: "INVALID_VAULT" });
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(archive), "utf8");
  if (serializedSize > MAX_VAULT_BYTES) {
    throw Object.assign(new Error("Vault archive exceeds the maximum allowed size."), { status: 413, code: "VAULT_TOO_LARGE" });
  }
  if (archive.format !== VAULT_FORMAT || archive.version !== VAULT_FORMAT_VERSION) {
    throw Object.assign(new Error("Unsupported or unrecognized Alfie vault format."), { status: 400, code: "UNSUPPORTED_VAULT_FORMAT" });
  }
  if (!archive.kdf?.salt || !archive.cipher?.iv || !archive.cipher?.authTag || typeof archive.ciphertext !== "string") {
    throw Object.assign(new Error("Vault archive is missing required cryptographic envelope fields."), { status: 400, code: "MALFORMED_VAULT" });
  }

  const salt = Buffer.from(String(archive.kdf.salt), "base64");
  const iv = Buffer.from(String(archive.cipher.iv), "base64");
  const authTag = Buffer.from(String(archive.cipher.authTag), "base64");
  const ciphertext = Buffer.from(archive.ciphertext, "base64");

  if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16) {
    throw Object.assign(new Error("Vault envelope parameters have invalid lengths."), { status: 400, code: "MALFORMED_VAULT" });
  }

  const key = deriveVaultKey(cleanPass, salt);
  const aad = buildAad(userId, archive.version);

  let plaintextJson;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    plaintextJson = decrypted.toString("utf8");
  } catch {
    throw Object.assign(
      new Error("Vault decryption failed: wrong passphrase, tampered archive, or archive belongs to another user."),
      { status: 400, code: "VAULT_DECRYPT_FAILED" }
    );
  }

  const computedHash = sha256Hex(plaintextJson);
  const expectedHash = String(archive.manifestSha256 || "");
  if (
    expectedHash.length !== computedHash.length ||
    !timingSafeEqual(Buffer.from(computedHash, "utf8"), Buffer.from(expectedHash, "utf8"))
  ) {
    throw Object.assign(new Error("Vault manifest SHA-256 checksum mismatch."), { status: 400, code: "VAULT_CHECKSUM_MISMATCH" });
  }

  let payload;
  try {
    payload = JSON.parse(plaintextJson);
  } catch {
    throw Object.assign(new Error("Decrypted vault payload is not valid JSON."), { status: 400, code: "MALFORMED_VAULT" });
  }

  if (payload.ownerId !== userId || !payload.collections || typeof payload.collections !== "object") {
    throw Object.assign(new Error("Vault payload failed owner or structure validation."), { status: 400, code: "VAULT_OWNER_MISMATCH" });
  }

  const safeCollections = {};
  const counts = {};
  for (const [keyName, doc] of Object.entries(payload.collections)) {
    if (!VAULT_COLLECTION_SET.has(keyName)) continue;
    if (!doc || typeof doc !== "object") continue;
    if (doc.ownerId && doc.ownerId !== userId) continue;
    safeCollections[keyName] = doc;
    counts[keyName] = summarizeCollectionCount(keyName, doc);
  }

  return {
    exportedAt: payload.exportedAt || archive.exportedAt || null,
    manifestSha256: computedHash,
    collections: safeCollections,
    counts
  };
}

/**
 * Non-destructive dry-run verification of an encrypted Alfie vault archive.
 */
export function verifyEncryptedVault({ archive, userId, passphrase }) {
  const verified = decryptVaultArchive(archive, userId, passphrase);
  return {
    valid: true,
    format: VAULT_FORMAT,
    version: VAULT_FORMAT_VERSION,
    exportedAt: verified.exportedAt,
    manifestSha256: verified.manifestSha256,
    collectionCount: Object.keys(verified.collections).length,
    counts: verified.counts
  };
}

function recordTimestamp(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of ["updatedAt", "lastUpdatedAt", "timestamp", "occurredAt", "capturedAt", "createdAt"]) {
    const value = Date.parse(String(item[key] || ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function mergeArrayById(existingArr = [], incomingArr = []) {
  const byId = new Map();
  for (const item of Array.isArray(existingArr) ? existingArr : []) {
    if (item && typeof item === "object" && item.id) byId.set(item.id, item);
  }
  for (const item of Array.isArray(incomingArr) ? incomingArr : []) {
    if (!item || typeof item !== "object" || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const localTime = recordTimestamp(existing);
    const backupTime = recordTimestamp(item);
    // Ambiguous timestamps retain local data rather than overwrite it.
    if (backupTime !== null && (localTime === null || backupTime > localTime)) byId.set(item.id, item);
  }
  return Array.from(byId.values());
}

function mergePermissionLeases(existingArr = [], incomingArr = []) {
  const key = (lease) => lease && typeof lease === "object"
    ? `${lease.scope || ""}::${lease.projectId || "*"}`
    : "";
  const byKey = new Map();
  for (const lease of Array.isArray(existingArr) ? existingArr : []) {
    const id = key(lease);
    if (id && id !== "::") byKey.set(id, lease);
  }
  for (const lease of Array.isArray(incomingArr) ? incomingArr : []) {
    const id = key(lease);
    if (!id || id === "::") continue;
    const existing = byKey.get(id);
    if (!existing) byKey.set(id, lease);
    else {
      const localTime = recordTimestamp(existing);
      const backupTime = recordTimestamp(lease);
      if (backupTime !== null && (localTime === null || backupTime > localTime)) byKey.set(id, lease);
    }
  }
  return Array.from(byKey.values());
}

function mergeCollectionDocument(collection, existing, incoming) {
  if (!existing || typeof existing !== "object") return incoming;
  const listKeyMap = {
    "memories.json": "memories",
    "projects.json": "projects",
    "ideas.json": "ideas",
    "conversations.json": "conversations",
    "watchers.json": "watchers",
    "watcher-events.json": "events",
    "context-capsules.json": "capsules",
    "jobs.json": "jobs",
    "reflections.json": "snapshots",
    "playbooks.json": "playbooks"
  };
  const listKey = listKeyMap[collection];
  if (listKey) {
    return {
      ...existing,
      ...incoming,
      [listKey]: mergeArrayById(existing[listKey], incoming[listKey])
    };
  }
  if (collection === "permissions.json") {
    const mergedLeases = mergePermissionLeases(existing.leases, incoming.leases);
    return {
      ...existing,
      ...incoming,
      leases: mergedLeases
    };
  }
  return { ...existing, ...incoming };
}

/**
 * Restores a verified encrypted Alfie vault archive into the user's SQLite WAL store.
 * Supports `mode: "merge"` (default, preserves newer local entries) or `mode: "replace"`.
 */
export async function restoreEncryptedVault({
  dataDirectory,
  userId,
  archive,
  passphrase,
  mode = "merge"
}) {
  const cleanMode = mode === "replace" ? "replace" : "merge";
  const verified = decryptVaultArchive(archive, userId, passphrase);
  const restoreSet = cleanMode === "replace"
    ? VAULT_COLLECTIONS.map((collection) => [collection, verified.collections[collection] ?? null])
    : Object.entries(verified.collections);

  // Prepare every document before writing anything. SQLite applies the batch
  // transactionally; the JSON backend performs compensating rollback.
  const documents = [];
  for (const [collection, incomingDoc] of restoreSet) {
    let nextDoc = incomingDoc;
    if (cleanMode === "merge") {
      const existingDoc = await readUserJsonDocument(dataDirectory, userId, collection);
      nextDoc = mergeCollectionDocument(collection, existingDoc, incomingDoc);
    }
    documents.push({ filename: collection, data: nextDoc });
  }

  await writeUserJsonDocuments(dataDirectory, userId, documents);
  const restoredCollections = documents.map(({ filename }) => filename);

  return {
    restored: true,
    mode: cleanMode,
    exportedAt: verified.exportedAt,
    manifestSha256: verified.manifestSha256,
    restoredCollections,
    counts: verified.counts
  };
}
