import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeUserKey, userDataFile, UserMutex, atomicWriteJson } from "../src/storage/userJsonStore.mjs";

describe("Shared userJsonStore helpers", () => {
  it("validates user IDs and hashes them deterministically with SHA-256", () => {
    const key = safeUserKey("alice@petrio");
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(safeUserKey("alice@petrio"), key);
    assert.throws(() => safeUserKey("../etc/passwd"), /verified user identity/i);
    assert.throws(() => safeUserKey(""), /verified user identity/i);
    assert.throws(() => safeUserKey(null), /verified user identity/i);
  });

  it("serializes concurrent operations per key using UserMutex", async () => {
    const mutex = new UserMutex();
    const order = [];
    await Promise.all([
      mutex.run("user-a", async () => {
        order.push("start-1");
        await new Promise((r) => setTimeout(r, 20));
        order.push("end-1");
      }),
      mutex.run("user-a", async () => {
        order.push("start-2");
        order.push("end-2");
      })
    ]);
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  });

  it("writes JSON atomically with 0o700 dir, 0o600 file, and no leftover temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-storage-"));
    try {
      const target = userDataFile(dir, "alice", "sample.json");
      await atomicWriteJson(target, { ok: true, count: 3 });

      const raw = JSON.parse(await readFile(target, "utf8"));
      assert.deepEqual(raw, { ok: true, count: 3 });

      const fileStat = await stat(target);
      assert.equal(fileStat.mode & 0o777, 0o600);
      const dirStat = await stat(path.dirname(target));
      assert.equal(dirStat.mode & 0o777, 0o700);

      const entries = await readdir(path.dirname(target));
      assert.deepEqual(entries, ["sample.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
