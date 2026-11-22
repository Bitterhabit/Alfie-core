import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readUserJsonDocument, writeUserJsonDocuments } from "../src/storage/userJsonStore.mjs";
import { restoreEncryptedVault, exportEncryptedVault } from "../src/vault/backup.mjs";

const PASSPHRASE = "correct horse battery staple";

describe("atomic vault restore", () => {
  it("rolls back every SQLite document when a later document cannot be serialized", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-atomic-"));
    try {
      await assert.rejects(
        writeUserJsonDocuments(dataDirectory, "alice", [
          { filename: "memories.json", data: { memories: [{ id: "one" }] } },
          { filename: "projects.json", data: { projects: [1n] } }
        ], { backend: "sqlite" }),
        /BigInt|serialize/i
      );
      assert.equal(await readUserJsonDocument(dataDirectory, "alice", "memories.json", { backend: "sqlite" }), null);
      assert.equal(await readUserJsonDocument(dataDirectory, "alice", "projects.json", { backend: "sqlite" }), null);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("restores a verified archive through the batch writer and clears absent replace collections", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-replace-"));
    try {
      await writeUserJsonDocuments(dataDirectory, "alice", [
        { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "old" }] } },
        { filename: "projects.json", data: { ownerId: "alice", projects: [{ id: "stale" }] } }
      ], { backend: "sqlite" });
      const exported = await exportEncryptedVault({ dataDirectory, userId: "alice", passphrase: PASSPHRASE });
      await restoreEncryptedVault({
        dataDirectory,
        userId: "alice",
        archive: exported.archive,
        passphrase: PASSPHRASE,
        mode: "replace"
      });
      const memories = await readUserJsonDocument(dataDirectory, "alice", "memories.json", { backend: "sqlite" });
      const projects = await readUserJsonDocument(dataDirectory, "alice", "projects.json", { backend: "sqlite" });
      assert.deepEqual(memories.memories, [{ id: "old" }]);
      assert.deepEqual(projects.projects, [{ id: "stale" }]);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
