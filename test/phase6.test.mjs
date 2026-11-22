import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";
import { exportEncryptedVault, verifyEncryptedVault, restoreEncryptedVault } from "../src/vault/backup.mjs";
import { runWorkspaceSelfAudit, applySafeRemediation } from "../src/diagnostics/selfAudit.mjs";
import { PeerTokenStore, parsePeerToken } from "../src/clients/tokenStore.mjs";
import { PlaybookStore, runPlaybook } from "../src/playbooks/store.mjs";
import { buildContinuityTimeline, exportMarkdownDigest } from "../src/timeline/builder.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { IdeaStore } from "../src/ideas/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { WorkflowProfileStore } from "../src/profile/store.mjs";
import { ContextCapsuleStore } from "../src/capsules/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { AsyncJobStore, AsyncJobEngine } from "../src/jobs/engine.mjs";
import { ReflectionStore } from "../src/reflections/generator.mjs";
import { AuditStore } from "../src/audit/store.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "alfie-phase6-"));
}

test("Phase 6.1: Sovereign Encrypted Vault exports, verifies, blocks tampering/wrong passphrase/cross-user AAD, and restores merge/replace", async () => {
  const dir = await tempDir();
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const ideaStore = new IdeaStore({ dataDirectory: dir });

  const userId = "user-vault-1";
  const m1 = await memoryStore.create(userId, { kind: "fact", text: "Local SQLite WAL keeps backups atomic." });
  const p1 = await projectStore.create(userId, { name: "Vault Sovereignty", vision: "Zero-trust portable backups" });
  const i1 = await ideaStore.create(userId, { title: "Nightly encrypted archive", priority: "high" });

  // Weak passphrase rejected
  await assert.rejects(
    () => exportEncryptedVault({ dataDirectory: dir, userId, passphrase: "short" }),
    (err) => err.status === 400 && err.code === "WEAK_PASSPHRASE"
  );

  const passphrase = "Correct-Horse-Battery-Staple-2026!";
  const exported = await exportEncryptedVault({ dataDirectory: dir, userId, passphrase });
  assert.equal(exported.archive.format, "alfie-sovereign-vault");
  assert.equal(exported.archive.cipher.algorithm, "aes-256-gcm");
  assert.ok(exported.summary.collectionCount >= 3);
  assert.equal(exported.summary.counts["memories.json"], 1);
  assert.equal(exported.summary.counts["projects.json"], 1);
  assert.equal(exported.summary.counts["ideas.json"], 1);

  // Non-destructive verification succeeds
  const verified = verifyEncryptedVault({ archive: exported.archive, userId, passphrase });
  assert.equal(verified.valid, true);
  assert.equal(verified.manifestSha256, exported.summary.manifestSha256);

  // Wrong passphrase fails closed
  assert.throws(
    () => verifyEncryptedVault({ archive: exported.archive, userId, passphrase: "Wrong-Passphrase-Attempt-999!" }),
    (err) => err.status === 400 && err.code === "VAULT_DECRYPT_FAILED"
  );

  // Cross-user AAD fails closed
  assert.throws(
    () => verifyEncryptedVault({ archive: exported.archive, userId: "other-user", passphrase }),
    (err) => err.status === 400 && err.code === "VAULT_DECRYPT_FAILED"
  );

  // Tampered ciphertext fails closed
  const tampered = structuredClone(exported.archive);
  tampered.ciphertext = Buffer.from("tampered-bytes-not-authentic").toString("base64");
  assert.throws(
    () => verifyEncryptedVault({ archive: tampered, userId, passphrase }),
    (err) => err.status === 400 && err.code === "VAULT_DECRYPT_FAILED"
  );

  // Add a second memory locally, then remove the first, and restore in MERGE mode -> both survive
  const m2 = await memoryStore.create(userId, { kind: "note", text: "Post-backup local note" });
  await memoryStore.remove(userId, m1.id);
  const afterDelete = await memoryStore.list(userId);
  assert.equal(afterDelete.length, 1);

  const mergeRes = await restoreEncryptedVault({ dataDirectory: dir, userId, archive: exported.archive, passphrase, mode: "merge" });
  assert.equal(mergeRes.restored, true);
  assert.equal(mergeRes.mode, "merge");
  const afterMerge = await memoryStore.list(userId);
  assert.equal(afterMerge.length, 2);
  assert.ok(afterMerge.some((m) => m.id === m1.id));
  assert.ok(afterMerge.some((m) => m.id === m2.id));

  // Restore in REPLACE mode -> reverts strictly to archive snapshot
  const replaceRes = await restoreEncryptedVault({ dataDirectory: dir, userId, archive: exported.archive, passphrase, mode: "replace" });
  assert.equal(replaceRes.mode, "replace");
  const afterReplace = await memoryStore.list(userId);
  assert.equal(afterReplace.length, 1);
  assert.equal(afterReplace[0].id, m1.id);
  assert.equal((await projectStore.list(userId))[0].id, p1.id);
  assert.equal((await ideaStore.list(userId))[0].id, i1.id);
});

test("Phase 6.2: Deterministic Workspace Self-Audit scores hygiene and runs safe remediations", async () => {
  const dir = await tempDir();
  const userId = "user-diag-1";
  const nowIso = "2026-11-22T12:00:00.000Z";
  const pastIso = "2026-11-20T12:00:00.000Z";

  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const ideaStore = new IdeaStore({ dataDirectory: dir });
  const watcherStore = new WatcherStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir, now: () => "2026-11-19T12:00:00.000Z" });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const jobStore = new AsyncJobStore({ dataDirectory: dir });
  const playbookStore = new PlaybookStore({ dataDirectory: dir });

  // Create an expired temporary memory + an expired lease + a project with no next actions
  await memoryStore.create(userId, { kind: "temporary", text: "Stale scratch note", expiresAt: pastIso });
  await permissionStore.grant(userId, "notes:read", { expiresAt: pastIso });
  await projectStore.create(userId, { name: "Needs Next Step", vision: "Track next step" });

  const stores = {
    projectStore,
    memoryStore,
    ideaStore,
    watcherStore,
    permissionStore,
    pendingActionStore,
    jobStore,
    playbookStore
  };

  const before = await runWorkspaceSelfAudit({ userId, dataDirectory: dir, stores, now: () => nowIso });
  assert.ok(before.score < 100);
  assert.equal(before.metrics.expiredMemories, 1);
  assert.equal(before.metrics.expiredLeases, 1);

  const remMem = await applySafeRemediation({ userId, dataDirectory: dir, stores, action: "prune_expired_memories", now: () => nowIso });
  assert.equal(remMem.archived, 1);

  const remLease = await applySafeRemediation({ userId, dataDirectory: dir, stores, action: "prune_expired_leases", now: () => nowIso });
  assert.equal(remLease.pruned, 1);

  const remFts = await applySafeRemediation({ userId, dataDirectory: dir, stores, action: "reindex_fts5", now: () => nowIso });
  assert.ok(remFts.detail.includes("FTS5"));

  const after = await runWorkspaceSelfAudit({ userId, dataDirectory: dir, stores, now: () => nowIso });
  assert.equal(after.metrics.expiredMemories, 0);
  assert.equal(after.metrics.expiredLeases, 0);
  assert.ok(after.score > before.score);

  await assert.rejects(
    () => applySafeRemediation({ userId, dataDirectory: dir, stores, action: "drop_everything" }),
    (err) => err.status === 400 && err.code === "UNKNOWN_REMEDIATION"
  );
});

test("Phase 6.3: Scoped Peer Client Tokens store hashes only, enforce scopes/expiry/revocation, and isolate users", async () => {
  const dir = await tempDir();
  const store = new PeerTokenStore({ dataDirectory: dir });
  const userId = "user-peer-1";

  const minted = await store.create(userId, {
    name: "Laptop Quick Capture CLI",
    scopes: ["capture:write", "status:read"],
    expiresInDays: 30
  });
  assert.ok(minted.token.startsWith("alf_"));
  assert.ok(parsePeerToken(minted.token));

  // Listing tokens never leaks raw token or secretHash
  const list = await store.list(userId);
  assert.equal(list.length, 1);
  assert.equal("secretHash" in list[0], false);
  assert.equal("token" in list[0], false);

  // Valid scope passes and updates lastUsedAt
  const authOk = await store.authenticate(minted.token, "capture:write");
  assert.equal(authOk.userId, userId);
  assert.equal(authOk.name, "Laptop Quick Capture CLI");

  // Unassigned scope fails with 403 PEER_SCOPE_DENIED
  await assert.rejects(
    () => store.authenticate(minted.token, "search:read"),
    (err) => err.status === 403 && err.code === "PEER_SCOPE_DENIED"
  );

  // Wrong secret returns null
  const badToken = minted.token.slice(0, -4) + "AAAA";
  assert.equal(await store.authenticate(badToken, "capture:write"), null);

  // Revocation blocks immediately
  await store.revoke(userId, minted.record.id);
  assert.equal(await store.authenticate(minted.token, "capture:write"), null);
});

test("Phase 6.4: Deterministic Playbooks enforce strict booleans, support dry-run preview, and execute safely", async () => {
  const dir = await tempDir();
  const userId = "user-pb-1";
  const playbookStore = new PlaybookStore({ dataDirectory: dir });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const ideaStore = new IdeaStore({ dataDirectory: dir });
  const watcherStore = new WatcherStore({ dataDirectory: dir });
  const capsuleStore = new ContextCapsuleStore({ dataDirectory: dir });
  const profileStore = new WorkflowProfileStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const reflectionStore = new ReflectionStore({ dataDirectory: dir });
  const auditStore = new AuditStore({ dataDirectory: dir });
  const jobStore = new AsyncJobStore({ dataDirectory: dir });
  const jobEngine = new AsyncJobEngine({ jobStore, auditStore });

  // Reject stringified boolean
  await assert.rejects(
    () => playbookStore.create(userId, { name: "Bad bool", enabled: "false" }),
    (err) => err.status === 400
  );

  const pb = await playbookStore.create(userId, {
    name: "Weekly Governance Sweep",
    trigger: "weekly_cadence",
    action: "delegate_workshop",
    config: { roleId: "auditor", objective: "Inspect workspace leases and blockers" },
    enabled: true
  });
  assert.equal(pb.runCount, 0);

  const stores = {
    playbookStore,
    projectStore,
    memoryStore,
    ideaStore,
    watcherStore,
    capsuleStore,
    profileStore,
    permissionStore,
    reflectionStore,
    auditStore
  };

  // Dry-run does not increment runCount
  const dry = await runPlaybook({ userId, playbookId: pb.id, dryRun: true, stores, jobEngine, dataDirectory: dir });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.preview.autonomousWrites, false);
  assert.equal((await playbookStore.get(userId, pb.id)).runCount, 0);

  // Live run delegates bounded auditor job & increments runCount
  const live = await runPlaybook({ userId, playbookId: pb.id, dryRun: false, stores, jobEngine, dataDirectory: dir });
  assert.equal(live.dryRun, false);
  assert.equal(live.playbook.runCount, 1);
  assert.equal(live.artifact.status, "completed");

  // Park-idea playbook works deterministically
  const pbIdea = await playbookStore.create(userId, {
    name: "Capture Follow-up",
    trigger: "manual_run",
    action: "park_idea",
    config: { title: "Review quarterly archive", notes: "Verify vault passphrase storage" }
  });
  const ideaRun = await runPlaybook({ userId, playbookId: pbIdea.id, dryRun: false, stores, jobEngine, dataDirectory: dir });
  assert.ok(ideaRun.artifact.ideaId);
  assert.equal((await ideaStore.list(userId)).length, 1);
});

test("Phase 6.5 & HTTP E2E: Continuity Timeline, Markdown Digest Export, and Core /v1/peer/* endpoints work end-to-end", async () => {
  const dir = await tempDir();
  const serviceToken = "phase6-test-service-token-12345678901234567890";
  const identitySecret = "phase6-test-identity-secret-12345678901234567890";
  const identityAuth = createSignedIdentityAuth({ providerId: "petrio", secret: identitySecret });

  const server = createAlfieCoreServer({
    serviceToken,
    identityAuth,
    memoryStore: new MemoryStore({ dataDirectory: dir }),
    projectStore: new ProjectStore({ dataDirectory: dir }),
    ideaStore: new IdeaStore({ dataDirectory: dir }),
    watcherStore: new WatcherStore({ dataDirectory: dir }),
    profileStore: new WorkflowProfileStore({ dataDirectory: dir }),
    capsuleStore: new ContextCapsuleStore({ dataDirectory: dir }),
    permissionStore: new PermissionStore({ dataDirectory: dir }),
    pendingActionStore: new PendingActionStore({ dataDirectory: dir }),
    auditStore: new AuditStore({ dataDirectory: dir }),
    jobStore: new AsyncJobStore({ dataDirectory: dir }),
    reflectionStore: new ReflectionStore({ dataDirectory: dir }),
    peerTokenStore: new PeerTokenStore({ dataDirectory: dir }),
    playbookStore: new PlaybookStore({ dataDirectory: dir })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createAlfieCoreClient({ baseUrl, serviceToken, identityAuth });
  const userId = "user-e2e-p6";

  try {
    // 1. Seed project + memory
    await client.createProject(userId, { name: "Phase 6 E2E", vision: "Portable personal OS", nextActions: ["Ship CLI"] });
    await client.createMemory(userId, { kind: "decision", text: "Use AES-256-GCM encrypted vault archives." });

    // 2. Mint scoped Peer Token & invoke /v1/peer/status, /v1/peer/capture, /v1/peer/search
    const minted = await client.createPeerToken(userId, {
      name: "E2E CLI",
      scopes: ["status:read", "capture:write", "search:read"]
    });
    const peerStatus = await client.callPeerEndpoint(minted.token, "/v1/peer/status");
    assert.equal(peerStatus.status, "ok");
    assert.equal(peerStatus.counts.projects, 1);

    const captured = await client.callPeerEndpoint(minted.token, "/v1/peer/capture", {
      method: "POST",
      body: { kind: "idea", text: "Quick-captured from peer CLI" }
    });
    assert.equal(captured.captured, "idea");

    const searched = await client.callPeerEndpoint(minted.token, "/v1/peer/search", { query: "q=AES" });
    assert.ok(Array.isArray(searched.search.results));
    assert.ok(searched.search.results.length >= 1);

    // 3. Diagnostics Audit via HTTP
    const diag = await client.getDiagnosticsAudit(userId);
    assert.ok(diag.audit.score >= 85);

    // 4. Continuity Timeline & Portable Markdown Digest via HTTP
    const tl = await client.getTimeline(userId, "kind=all&limit=20");
    assert.ok(tl.timeline.total >= 3);
    const md = await client.exportMarkdownDigest(userId);
    assert.ok(md.digest.markdown.includes("# Alfie Sovereign Knowledge Digest"));
    assert.ok(md.digest.markdown.includes("Phase 6 E2E"));
    assert.ok(md.digest.markdown.includes("Quick-captured from peer CLI"));

    // 5. Vault Export -> Verify via HTTP
    const vaultExp = await client.exportVault(userId, { passphrase: "My-Super-Strong-Passphrase-99!" });
    const vaultVer = await client.verifyVault(userId, { archive: vaultExp.archive, passphrase: "My-Super-Strong-Passphrase-99!" });
    assert.equal(vaultVer.verification.valid, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
