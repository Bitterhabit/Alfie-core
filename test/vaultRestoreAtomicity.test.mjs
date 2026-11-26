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
    const sourceDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-source-"));
    try {
      await writeUserJsonDocuments(sourceDirectory, "alice", [
        { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "from-backup" }] } }
      ], { backend: "sqlite" });
      await writeUserJsonDocuments(dataDirectory, "alice", [
        { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "old" }] } },
        { filename: "projects.json", data: { ownerId: "alice", projects: [{ id: "stale" }] } }
      ], { backend: "sqlite" });
      const exported = await exportEncryptedVault({ dataDirectory: sourceDirectory, userId: "alice", passphrase: PASSPHRASE });
      await restoreEncryptedVault({
        dataDirectory,
        userId: "alice",
        archive: exported.archive,
        passphrase: PASSPHRASE,
        mode: "replace"
      });
      const memories = await readUserJsonDocument(dataDirectory, "alice", "memories.json", { backend: "sqlite" });
      const projects = await readUserJsonDocument(dataDirectory, "alice", "projects.json", { backend: "sqlite" });
      assert.deepEqual(memories.memories, [{ id: "from-backup" }]);
      assert.equal(projects, null);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });
  it("backs up audit history and receipts without restoring executable pending approvals", async () => {
    const sourceDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-audit-source-"));
    const targetDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-audit-target-"));
    try {
      await writeUserJsonDocuments(sourceDirectory, "alice", [
        {
          filename: "pending-actions.json",
          data: {
            schemaVersion: 1,
            ownerId: "alice",
            actions: [{ id: "must-not-return", toolId: "github.change.create_pr", arguments: { secret: "must-not-be-restored" } }],
            receipts: [{ id: "receipt-backup", actionId: "action-backup", toolId: "github.change.create_pr", status: "completed", verificationState: "verified", executedAt: "2026-11-26T20:00:00.000Z" }]
          }
        },
        {
          filename: "audit.json",
          data: { schemaVersion: 1, ownerId: "alice", events: [{ id: "audit-backup", at: "2026-11-26T20:00:00.000Z", event: "tool.approval_completed" }] }
        }
      ], { backend: "sqlite" });

      await writeUserJsonDocuments(targetDirectory, "alice", [
        {
          filename: "pending-actions.json",
          data: {
            schemaVersion: 1,
            ownerId: "alice",
            actions: [{ id: "live-pending", toolId: "notes.write", arguments: { text: "never replay" }, status: "pending" }],
            receipts: [{ id: "receipt-live", actionId: "action-live", toolId: "notes.write", status: "completed", verificationState: "verified", executedAt: "2026-11-26T19:00:00.000Z" }]
          }
        },
        {
          filename: "audit.json",
          data: { schemaVersion: 1, ownerId: "alice", events: [{ id: "audit-live", at: "2026-11-26T19:00:00.000Z", event: "tool.approval_created" }] }
        }
      ], { backend: "sqlite" });

      const exported = await exportEncryptedVault({ dataDirectory: sourceDirectory, userId: "alice", passphrase: PASSPHRASE });
      assert.equal(exported.summary.counts["pending-actions.json"], 1);
      assert.equal(exported.summary.counts["audit.json"], 1);

      await restoreEncryptedVault({
        dataDirectory: targetDirectory,
        userId: "alice",
        archive: exported.archive,
        passphrase: PASSPHRASE,
        mode: "merge"
      });

      const pending = await readUserJsonDocument(targetDirectory, "alice", "pending-actions.json", { backend: "sqlite" });
      const audit = await readUserJsonDocument(targetDirectory, "alice", "audit.json", { backend: "sqlite" });
      assert.deepEqual(pending.actions, [], "No pending executable approval may be restored or survive a vault merge");
      assert.deepEqual(pending.receipts.map((receipt) => receipt.id).sort(), ["receipt-backup", "receipt-live"]);
      assert.deepEqual(audit.events.map((event) => event.id).sort(), ["audit-backup", "audit-live"]);
      assert.doesNotMatch(JSON.stringify(pending), /must-not-be-restored/);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });

  it("refuses to export an encrypted vault larger than the supported restore limit", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-too-large-"));
    try {
      await writeUserJsonDocuments(dataDirectory, "alice", [
        { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "large", text: "x".repeat(13 * 1024 * 1024) }] } }
      ], { backend: "json" });
      await assert.rejects(
        () => exportEncryptedVault({ dataDirectory, userId: "alice", passphrase: PASSPHRASE }),
        (error) => error.status === 413 && error.code === "VAULT_TOO_LARGE"
      );
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("compensates JSON fallback writes when a later document fails", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "alfie-vault-json-rollback-"));
    try {
      await writeUserJsonDocuments(dataDirectory, "alice", [
        { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "original" }] } }
      ], { backend: "json" });

      await assert.rejects(
        writeUserJsonDocuments(dataDirectory, "alice", [
          { filename: "memories.json", data: { ownerId: "alice", memories: [{ id: "replacement" }] } },
          { filename: "projects.json", data: { ownerId: "alice", projects: [1n] } }
        ], { backend: "json" }),
        /BigInt|serialize/i
      );

      const memories = await readUserJsonDocument(dataDirectory, "alice", "memories.json", { backend: "json" });
      const projects = await readUserJsonDocument(dataDirectory, "alice", "projects.json", { backend: "json" });
      assert.deepEqual(memories.memories, [{ id: "original" }]);
      assert.equal(projects, null);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
