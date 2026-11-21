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
