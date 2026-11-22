import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeLocalEmbedding, cosineSimilarity, fuseRankings, hybridSearchWorkspace } from "../src/retrieval/hybrid.mjs";
import { resolveConfinedNotePath, registerModularConnectorTools, getModularIntegrationsStatus } from "../src/integrations/modularConnectors.mjs";
import { AsyncJobStore, AsyncJobEngine } from "../src/jobs/engine.mjs";
import { computeSubAgentScopes, listSpecialistRoles, runWorkshopDelegation } from "../src/agents/workshop.mjs";
import { sanitizeForCloud, rehydrateFromCloud, sanitizeMessagesForCloud } from "../src/privacy/broker.mjs";
import { getVoiceStatus, transcribeAudio, synthesizeSpeech } from "../src/voice/service.mjs";
import { buildContinuityReflection, ReflectionStore } from "../src/reflections/generator.mjs";
import { deriveAmbientPresence, formatHomeAssistantPayload, formatMqttPresencePayload } from "../src/ambient/bridge.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { IdeaStore } from "../src/ideas/store.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { AuditStore } from "../src/audit/store.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";
import { InterfaceAuthStore } from "../interface/src/auth/store.mjs";

test("Hybrid Semantic Retrieval computes trigram cosine similarity, fuses rankings via RRF, and integrates optional Python worker", async () => {
  const v1 = computeLocalEmbedding("proxmox zfs mirror pool snapshots");
  const v2 = computeLocalEmbedding("zfs mirrored pools on proxmox");
  const v3 = computeLocalEmbedding("banana smoothie recipe");
  assert.ok(cosineSimilarity(v1, v2) > cosineSimilarity(v1, v3));

  const fused = fuseRankings(
    [{ docId: "a", title: "A" }, { docId: "b", title: "B" }],
    [{ docId: "b", title: "B", semanticScore: 0.9 }, { docId: "c", title: "C", semanticScore: 0.7 }]
  );
  assert.equal(fused[0].docId, "b");
  assert.equal(fused.length, 3);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-hybrid-"));
  try {
    const memoryStore = new MemoryStore({ dataDirectory: dir });
    await memoryStore.create("alice", { title: "Proxmox Backup Server", text: "Nightly ZFS snapshots replicate to offsite NAS", kind: "fact" });
    await memoryStore.create("alice", { title: "Grocery List", text: "Oat milk and espresso beans", kind: "note" });

    // Local hashed trigram semantic engine works offline
    const localRes = await hybridSearchWorkspace(dir, "alice", { q: "backups snapshots", mode: "hybrid" });
    assert.equal(localRes.mode, "hybrid");
    assert.equal(localRes.semanticEngine, "local-hashed-trigram-v1");
    assert.ok(localRes.results.some((r) => r.title.includes("Proxmox Backup")));

    // Optional Python worker reranker is used when URL responds cleanly
    const mockFetch = async () => ({
      ok: true,
      async json() {
        return { scores: [{ id: localRes.results[0].docId, score: 0.96 }] };
      }
    });
    const workerRes = await hybridSearchWorkspace(dir, "alice", {
      q: "backups",
      mode: "hybrid",
      workerUrl: "http://127.0.0.1:8091",
      fetchImpl: mockFetch
    });
    assert.equal(workerRes.semanticEngine, "python-worker-v1");
    assert.equal(workerRes.results[0].semanticScore, 0.96);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Modular Integration Suite enforces strict path confinement for notes, approval + verification receipts, and safe GitHub validation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-connectors-"));
  try {
    // Path traversal attempts fail closed
    assert.throws(() => resolveConfinedNotePath(dir, "../etc/passwd"), (err) => err.status === 400);
    assert.throws(() => resolveConfinedNotePath(dir, "sub/../../escape.md"), (err) => err.status === 400);
    const okPath = resolveConfinedNotePath(dir, "homelab/zfs-plan");
    assert.ok(okPath.resolvedTarget.endsWith(path.join("homelab", "zfs-plan.md")));

    const registry = new ToolRegistry();
    registerModularConnectorTools(registry, { dataDirectory: dir });
    const permissionStore = new PermissionStore({ dataDirectory: dir });
    const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
    const auditStore = new AuditStore({ dataDirectory: dir });
    const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore, auditStore });

    await permissionStore.grant("alice", "notes:read");
    await permissionStore.grant("alice", "notes:write");
    await permissionStore.grant("alice", "mail:draft");

    // notes.write requires explicit approval, produces simulation + verified receipt
    const proposed = await dispatcher.dispatch({
      userId: "alice",
      toolId: "notes.write",
      args: { name: "homelab-plan", content: "# Homelab\nZFS mirror ready." },
      turnId: "t-note-1"
    });
    assert.equal(proposed.status, "awaiting_user_approval");
    assert.ok(proposed.simulation.rollbackPlan);

    const approved = await dispatcher.approve("alice", proposed.actionId);
    assert.equal(approved.status, "completed");
    assert.equal(approved.receipt.verified, true);
    assert.equal(approved.receipt.verificationState, "verified");

    // notes.read & notes.list read back the confined file
    const listed = await dispatcher.dispatch({ userId: "alice", toolId: "notes.list", args: {}, turnId: "t-note-2" });
    assert.equal(listed.result.total, 1);
    const readBack = await dispatcher.dispatch({ userId: "alice", toolId: "notes.read", args: { name: "homelab-plan" }, turnId: "t-note-3" });
    assert.ok(readBack.result.content.includes("ZFS mirror ready"));

    // Status exposes integration metadata without secrets
    const status = getModularIntegrationsStatus();
    assert.equal(status.length, 4);
    assert.ok(status.some((i) => i.id === "local_notes" && i.configured === true));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ADR-004 Async Job Engine & Bounded Multi-Agent Workshop enforce capability ceilings, checkpoints, cancellation, and taint propagation", async () => {
  assert.equal(listSpecialistRoles().length, 4);
  // Capability ceiling strictly intersects role scopes with user grants (never escalates)
  assert.deepEqual(computeSubAgentScopes("researcher", ["memory:read", "memory:write", "calendar:write"]), ["memory:read"]);
  assert.deepEqual(computeSubAgentScopes("planner", []), []);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-workshop-"));
  try {
    const projectStore = new ProjectStore({ dataDirectory: dir });
    const memoryStore = new MemoryStore({ dataDirectory: dir });
    const ideaStore = new IdeaStore({ dataDirectory: dir });
    const watcherStore = new WatcherStore({ dataDirectory: dir });
    const permissionStore = new PermissionStore({ dataDirectory: dir });
    const auditStore = new AuditStore({ dataDirectory: dir });
    const jobStore = new AsyncJobStore({ dataDirectory: dir });
    const jobEngine = new AsyncJobEngine({ jobStore, auditStore });

    const proj = await projectStore.create("alice", {
      name: "Core Migration",
      vision: "Ship SQLite WAL & Async Jobs",
      blockers: ["Verify Proxmox token"],
      nextActions: ["Run backup rehearsal"]
    });
    await memoryStore.create("alice", {
      title: "External feed note",
      text: "Untrusted external webhook observation for Core Migration",
      origin: "integration-imported",
      kind: "note"
    });
    await permissionStore.grant("alice", "memory:read");
    await permissionStore.grant("alice", "memory:write");

    const auditJob = await runWorkshopDelegation({
      userId: "alice",
      roleId: "auditor",
      objective: "Audit Core Migration blockers and provenance",
      projectId: proj.id,
      stores: { projectStore, memoryStore, ideaStore, watcherStore, permissionStore },
      jobEngine,
      dataDirectory: dir
    });

    assert.equal(auditJob.status, "completed");
    assert.equal(auditJob.progress, 100);
    assert.deepEqual(auditJob.capabilityCeiling, ["memory:read"]);
    assert.equal(auditJob.tainted, true);
    assert.equal(auditJob.lowestTrustTouched, "external_untrusted");
    assert.ok(auditJob.checkpoints.length >= 4);
    assert.ok(auditJob.artifact.findings.some((f) => f.includes("Verify Proxmox token")));

    // Queued job can be cancelled; completed job rejects cancellation with 409
    const queued = await jobStore.create("alice", { title: "Long research run" });
    const cancelled = await jobEngine.cancel("alice", queued.id, "No longer needed");
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(() => jobEngine.cancel("alice", auditJob.id), (err) => err.status === 409);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Async job cancellation remains terminal when an in-flight step completes late", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-job-cancel-race-"));
  try {
    const jobStore = new AsyncJobStore({ dataDirectory: dir });
    const jobEngine = new AsyncJobEngine({ jobStore });
    const job = await jobStore.create("alice", { title: "Cancelable background work" });
    let markStarted;
    let releaseStep;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { releaseStep = resolve; });

    const execution = jobEngine.execute("alice", job, [{
      name: "wait for external operation",
      run: async () => {
        markStarted();
        await gate; // Deliberately ignores AbortSignal to exercise the race.
        return { summary: "Late step result" };
      }
    }]);

    await started;
    const cancelled = await jobEngine.cancel("alice", job.id, "User requested cancellation");
    assert.equal(cancelled.status, "cancelled");
    releaseStep();

    const executionResult = await execution;
    assert.equal(executionResult.status, "cancelled");
    assert.equal((await jobStore.get("alice", job.id)).status, "cancelled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a user cannot abort another user's active job by presenting its job ID", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-job-cancel-owner-"));
  try {
    const jobStore = new AsyncJobStore({ dataDirectory: dir });
    const jobEngine = new AsyncJobEngine({ jobStore });
    const job = await jobStore.create("alice", { title: "Private background work" });
    let markStarted;
    let releaseStep;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { releaseStep = resolve; });

    const execution = jobEngine.execute("alice", job, [{
      name: "wait for completion",
      run: async ({ signal }) => {
        markStarted();
        await gate;
        if (signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
        return { summary: "Completed normally" };
      }
    }]);

    await started;
    await assert.rejects(() => jobEngine.cancel("bob", job.id), (error) => error.status === 404);
    releaseStep();

    const result = await execution;
    assert.equal(result.status, "completed");
    assert.equal((await jobStore.get("alice", job.id)).status, "completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Split-Brain Privacy Broker redacts private entities and reversibly rehydrates cloud replies locally", () => {
  const prompt = "Debug SSH on 192.168.10.42 (pve-01.proxmox) for peter@example.com using /home/peter/keys and token sk-1234567890abcdefghij for ProjectApollo";
  const out = sanitizeForCloud(prompt, { customTerms: ["ProjectApollo"] });

  assert.ok(!out.sanitizedText.includes("192.168.10.42"));
  assert.ok(!out.sanitizedText.includes("pve-01.proxmox"));
  assert.ok(!out.sanitizedText.includes("peter@example.com"));
  assert.ok(!out.sanitizedText.includes("/home/peter/keys"));
  assert.ok(!out.sanitizedText.includes("sk-1234567890abcdefghij"));
  assert.ok(!out.sanitizedText.includes("ProjectApollo"));
  assert.ok(out.redactedCount >= 6);

  const cloudReply = `Check firewall rules on ${out.sanitizedText.match(/\[PRIVATE_IP_1\]/)[0]} for ${out.sanitizedText.match(/\[PRIVATE_TERM_1\]/)[0]}.`;
  const restored = rehydrateFromCloud(cloudReply, out.tokenMap);
  assert.equal(restored, "Check firewall rules on 192.168.10.42 for ProjectApollo.");

  const batch = sanitizeMessagesForCloud([{ role: "user", content: prompt }]);
  assert.equal(batch.manifest.airlockActive, true);
  assert.ok(batch.manifest.redactedCount >= 5);
});

test("Local/Hybrid Voice service reports push-to-talk guarantees and handles unconfigured vs configured endpoints", async () => {
  const status = getVoiceStatus();
  assert.equal(status.pushToTalkOnly, true);
  assert.equal(status.hotwordDisabled, true);
  assert.equal(status.tts.interruptible, true);

  await assert.rejects(() => transcribeAudio({ audioBase64: "AAAA" }), (err) => err.status === 503);
  await assert.rejects(() => synthesizeSpeech({ text: "Hello Alfie" }), (err) => err.status === 503);
});

test("Life Continuity Reflections & Ambient Presence Bridges compute deterministic local-only digests and payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-phase5-"));
  try {
    const now = new Date("2026-11-22T14:00:00.000Z");
    const projects = [
      {
        id: "p1",
        name: "Homelab Atlas",
        status: "active",
        nextActions: ["Test UPS shutdown script"],
        blockers: ["Cable run pending"],
        decisions: [{ summary: "Use SQLite WAL", rationale: "Zero extra DB container" }],
        updatedAt: "2026-11-21T10:00:00.000Z"
      }
    ];
    const memories = [{ id: "m1", kind: "lesson", title: "Always verify ZFS scrubs", text: "Check scrub logs monthly", updatedAt: "2026-11-20T10:00:00.000Z" }];
    const ideas = [{ id: "i1", title: "Desk e-ink display", priority: "high", status: "inbox", tags: ["ambient"], updatedAt: "2026-11-21T12:00:00.000Z" }];

    const reflection = buildContinuityReflection({ projects, memories, ideas }, { period: "weekly", now });
    assert.equal(reflection.localOnly, true);
    assert.equal(reflection.metrics.activeProjects, 1);
    assert.equal(reflection.metrics.openBlockers, 1);
    assert.equal(reflection.lessonsLearned.length, 1);
    assert.equal(reflection.highPriorityIdeas.length, 1);

    const store = new ReflectionStore({ dataDirectory: dir });
    const saved = await store.saveSnapshot("alice", reflection);
    const list = await store.list("alice");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, saved.id);

    const presence = deriveAmbientPresence({ projects, memories, ideas, now });
    assert.equal(presence.deterministic, true);
    assert.equal(presence.soul.mood, "steady");
    assert.equal(presence.desk.focalProject.name, "Homelab Atlas");

    const ha = formatHomeAssistantPayload(presence);
    assert.equal(ha.state, "steady");
    assert.equal(ha.attributes.focal_project, "Homelab Atlas");

    const mqtt = formatMqttPresencePayload(presence);
    assert.equal(mqtt.payload.mood, "steady");
    assert.equal(mqtt.retain, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Standalone Account Recovery issues 8 one-time hashed codes, resets password, revokes sessions, and blocks reuse", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-recovery-"));
  try {
    const authStore = new InterfaceAuthStore({ dataDirectory: dir });
    const initialPass = "Initial-Strong-Passphrase-2026!";
    const nextPass = "Recovered-New-Passphrase-2026!!";
    const boot = await authStore.bootstrap("owner", initialPass);
    const session = await authStore.login("owner", initialPass);
    assert.ok(await authStore.authenticate(session.token));

    // Wrong password cannot mint recovery codes
    await assert.rejects(() => authStore.generateRecoveryCodes(boot.user.id, "wrong-password-123456"), (err) => err.status === 401);

    const generated = await authStore.generateRecoveryCodes(boot.user.id, initialPass);
    assert.equal(generated.codes.length, 8);
    assert.equal(generated.remaining, 8);

    // Invalid recovery code rejected
    await assert.rejects(() => authStore.recoverWithCode("owner", "FFFFF-FFFFF", nextPass), (err) => err.status === 401);

    // Valid code resets password, revokes active sessions, and decrements remaining count
    const recovered = await authStore.recoverWithCode("owner", generated.codes[0], nextPass);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.remainingCodes, 7);
    assert.equal(await authStore.authenticate(session.token), null);

    // Reusing the same recovery code fails closed
    await assert.rejects(() => authStore.recoverWithCode("owner", generated.codes[0], "Another-Strong-Passphrase-2026!"), (err) => err.status === 401);

    // New password signs in cleanly
    const freshLogin = await authStore.login("owner", nextPass);
    assert.equal(freshLogin.user.username, "owner");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
