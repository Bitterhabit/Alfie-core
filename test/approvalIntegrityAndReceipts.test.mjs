import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { AuditStore } from "../src/audit/store.mjs";
import { readUserJsonDocument, writeUserJsonDocument } from "../src/storage/userJsonStore.mjs";
import { ToolDispatcher, computeToolFingerprint } from "../src/agent/toolDispatcher.mjs";
import { ConversationStore } from "../src/conversations/store.mjs";

test("Action receipts accurately distinguish all four execution & verification outcomes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-receipt-states-"));
  const registry = new ToolRegistry();
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });

  const baseSchema = { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false };

  // 1. Execution fails
  registry.register({
    id: "ops.fail_exec",
    name: "Failing execution tool",
    description: "Throws during execution",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: baseSchema,
    handler: async () => { throw new Error("Disk read-only"); }
  });

  // 2. Execution succeeds, NO verifyResult hook (verification unavailable -> verified MUST be false!)
  registry.register({
    id: "ops.no_verifier",
    name: "Unverified write tool",
    description: "Succeeds without verifyResult",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: baseSchema,
    handler: async ({ target }) => ({ ok: true, target })
  });

  // 3a. Execution succeeds, verifyResult returns verified: false
  registry.register({
    id: "ops.verify_false",
    name: "Verification mismatch tool",
    description: "Verifier flags state mismatch",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: baseSchema,
    handler: async ({ target }) => ({ ok: true, target }),
    verifyResult: async () => ({ verified: false, detail: "Target checksum did not match expected state." })
  });

  // 3b. Execution succeeds, verifyResult throws
  registry.register({
    id: "ops.verify_throws",
    name: "Verification error tool",
    description: "Verifier throws an error",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: baseSchema,
    handler: async ({ target }) => ({ ok: true, target }),
    verifyResult: async () => { throw new Error("Verification endpoint unreachable"); }
  });

  // 4. Execution succeeds, verifyResult explicitly returns verified: true
  registry.register({
    id: "ops.verify_pass",
    name: "Verified write tool",
    description: "Verifier confirms final state",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: baseSchema,
    handler: async ({ target }) => ({ ok: true, target }),
    verifyResult: async ({ target }) => ({ verified: true, detail: `Confirmed ${target} persisted on disk.` })
  });

  await permissionStore.grant("alice", "ops:write");

  try {
    // Scenario 1: Execution failed
    const p1 = await dispatcher.dispatch({ userId: "alice", toolId: "ops.fail_exec", args: { target: "vol-1" }, turnId: "t1" });
    await assert.rejects(
      () => dispatcher.approve("alice", p1.actionId),
      (error) => /Disk read-only/.test(error.message) && error.actionConsumed === true && error.actionId === p1.actionId
    );
    await assert.rejects(
      () => dispatcher.approve("alice", p1.actionId),
      (error) => error.status === 404,
      "A consumed approval must not execute twice after a failure"
    );

    // Scenario 2: Execution succeeded, verification unavailable
    const p2 = await dispatcher.dispatch({ userId: "alice", toolId: "ops.no_verifier", args: { target: "vol-2" }, turnId: "t2" });
    const r2 = await dispatcher.approve("alice", p2.actionId);
    assert.equal(r2.status, "completed");
    assert.equal(r2.receipt.status, "completed");
    assert.equal(r2.receipt.verified, false, "Tools without verifyResult MUST NOT default to verified: true");
    assert.equal(r2.receipt.verificationState, "unverified");
    assert.match(r2.receipt.verificationDetail, /Execution succeeded/i);
    assert.match(r2.receipt.verificationDetail, /verification is not available/i);

    // Scenario 3a: Execution succeeded, verification returned false
    const p3a = await dispatcher.dispatch({ userId: "alice", toolId: "ops.verify_false", args: { target: "vol-3a" }, turnId: "t3a" });
    const r3a = await dispatcher.approve("alice", p3a.actionId);
    assert.equal(r3a.receipt.status, "completed");
    assert.equal(r3a.receipt.verified, false);
    assert.equal(r3a.receipt.verificationState, "verification_failed");
    assert.match(r3a.receipt.verificationDetail, /checksum/i);

    // Scenario 3b: Execution succeeded, verification threw
    const p3b = await dispatcher.dispatch({ userId: "alice", toolId: "ops.verify_throws", args: { target: "vol-3b" }, turnId: "t3b" });
    const r3b = await dispatcher.approve("alice", p3b.actionId);
    assert.equal(r3b.receipt.status, "completed");
    assert.equal(r3b.receipt.verified, false);
    assert.equal(r3b.receipt.verificationState, "verification_failed");
    assert.match(r3b.receipt.verificationDetail, /Verification endpoint unreachable/i);

    // Scenario 4: Execution succeeded, verification passed
    const p4 = await dispatcher.dispatch({ userId: "alice", toolId: "ops.verify_pass", args: { target: "vol-4" }, turnId: "t4" });
    const r4 = await dispatcher.approve("alice", p4.actionId);
    assert.equal(r4.receipt.status, "completed");
    assert.equal(r4.receipt.verified, true);
    assert.equal(r4.receipt.verificationState, "verified");
    assert.match(r4.receipt.verificationDetail, /Confirmed vol-4/i);

    // Verify all 5 persisted receipts carry the exact expected states
    const receipts = await pendingActionStore.listReceipts("alice");
    assert.equal(receipts.length, 5);
    const byTool = Object.fromEntries(receipts.map((r) => [r.toolId, r]));
    assert.equal(byTool["ops.fail_exec"].status, "failed");
    assert.equal(byTool["ops.fail_exec"].verified, false);
    assert.equal(byTool["ops.fail_exec"].verificationState, "execution_failed");

    assert.equal(byTool["ops.no_verifier"].status, "completed");
    assert.equal(byTool["ops.no_verifier"].verified, false);
    assert.equal(byTool["ops.no_verifier"].verificationState, "unverified");

    assert.equal(byTool["ops.verify_false"].verificationState, "verification_failed");
    assert.equal(byTool["ops.verify_throws"].verificationState, "verification_failed");
    assert.equal(byTool["ops.verify_pass"].verificationState, "verified");
    assert.equal(byTool["ops.verify_pass"].verified, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Approval integrity binds pending actions to exact security-relevant tool definition fingerprint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-tool-fp-"));
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const auditStore = new AuditStore({ dataDirectory: dir });

  await permissionStore.grant("alice", "notes:write");
  await permissionStore.grant("alice", "notes:admin");

  const registerTool = (registry, overrides = {}, handlerRef = { called: 0 }) => {
    registry.register({
      id: "notes.save",
      name: "Save Note",
      description: "Saves a local note",
      scope: "notes:write",
      risk: "write",
      trust: "internal",
      network: false,
      externalAction: false,
      tags: ["notes"],
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 500 } },
        required: ["text"],
        additionalProperties: false
      },
      handler: async ({ text }) => {
        handlerRef.called += 1;
        return { saved: text };
      },
      approvalGuard: async ({ text }) => ({ allowed: Boolean(text) }),
      ...overrides
    });
  };

  try {
    // 1. Cosmetic metadata change (name, description, tags) MUST NOT invalidate approval
    const regA = new ToolRegistry();
    const dispA = new ToolDispatcher({ registry: regA, permissionStore, pendingActionStore, auditStore });
    registerTool(regA);

    const proposedCosmetic = await dispA.dispatch({
      userId: "alice",
      toolId: "notes.save",
      args: { text: "hello" },
      turnId: "t-cosmetic"
    });

    const regCosmetic = new ToolRegistry();
    const cosmeticCalls = { called: 0 };
    registerTool(regCosmetic, {
      name: "Save Personal Note (Updated Copy)",
      description: "Updated friendly description text",
      tags: ["notes", "journal", "v2"]
    }, cosmeticCalls);
    assert.equal(
      computeToolFingerprint(regA.tools.get("notes.save")),
      computeToolFingerprint(regCosmetic.tools.get("notes.save")),
      "Cosmetic metadata edits must produce identical tool fingerprint"
    );

    const dispCosmetic = new ToolDispatcher({ registry: regCosmetic, permissionStore, pendingActionStore, auditStore });
    const approvedCosmetic = await dispCosmetic.approve("alice", proposedCosmetic.actionId);
    assert.equal(approvedCosmetic.status, "completed");
    assert.equal(cosmeticCalls.called, 1);

    // 2. Security/execution-relevant mutations MUST reject with 409 STALE_APPROVAL
    const securityMutations = [
      { label: "externalAction changed", overrides: { externalAction: true } },
      { label: "network changed", overrides: { network: true } },
      { label: "scope changed", overrides: { scope: "notes:admin" } },
      { label: "trust changed", overrides: { trust: "external" } },
      { label: "risk changed", overrides: { risk: "draft", externalAction: true } },
      {
        label: "approval guard implementation changed without changing its result",
        overrides: { approvalGuard: async ({ text }) => ({ allowed: text.length > 0 }) }
      },
      {
        label: "inputSchema changed",
        overrides: {
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", maxLength: 1000 }, extra: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        }
      }
    ];

    for (const [idx, mutation] of securityMutations.entries()) {
      const regOrig = new ToolRegistry();
      registerTool(regOrig);
      const dispOrig = new ToolDispatcher({ registry: regOrig, permissionStore, pendingActionStore, auditStore });
      const proposed = await dispOrig.dispatch({
        userId: "alice",
        toolId: "notes.save",
        args: { text: `case-${idx}` },
        turnId: `t-mut-${idx}`
      });

      const regChanged = new ToolRegistry();
      const changedCalls = { called: 0 };
      registerTool(regChanged, mutation.overrides, changedCalls);
      const dispChanged = new ToolDispatcher({ registry: regChanged, permissionStore, pendingActionStore, auditStore });

      await assert.rejects(
        () => dispChanged.approve("alice", proposed.actionId),
        (err) => err.status === 409 && err.code === "STALE_APPROVAL",
        `Expected 409 STALE_APPROVAL when ${mutation.label}`
      );
      assert.equal(changedCalls.called, 0, `Handler must not execute when ${mutation.label}`);
    }

    // 3. Pending action missing toolFingerprint (e.g. legacy or tampered record) fails closed with 409 STALE_APPROVAL
    const legacyAction = await pendingActionStore.create("alice", {
      toolId: "notes.save",
      arguments: { text: "legacy" },
      argumentsHash: "unused",
      risk: "write"
    });
    // Patch exact argumentsHash so only missing toolFingerprint triggers
    const regCheck = new ToolRegistry();
    registerTool(regCheck);
    const dispCheck = new ToolDispatcher({ registry: regCheck, permissionStore, pendingActionStore, auditStore });
    const validProposed = await dispCheck.dispatch({
      userId: "alice",
      toolId: "notes.save",
      args: { text: "tamper-fp" },
      turnId: "t-tamper-fp"
    });
    const rawPending = await readUserJsonDocument(dir, "alice", "pending-actions.json");
    const targetEntry = rawPending.actions.find((a) => a.id === validProposed.actionId);
    targetEntry.toolFingerprint = null;
    await writeUserJsonDocument(dir, "alice", "pending-actions.json", rawPending);

    await assert.rejects(
      () => dispCheck.approve("alice", validProposed.actionId),
      (err) => err.status === 409 && err.code === "STALE_APPROVAL"
    );

    // Clean up unused legacy action reference
    assert.ok(legacyAction.id);

    // Audit log recorded tool.approval_stale events
    const auditEvents = await auditStore.list("alice", { limit: 50 });
    assert.ok(auditEvents.some((e) => e.event === "tool.approval_stale"));
    const staleReceipts = await pendingActionStore.listReceipts("alice", { limit: 100 });
    assert.ok(staleReceipts.some((receipt) => receipt.toolId === "notes.save" && receipt.verificationState === "execution_failed"), "Consumed stale approvals must leave a durable failure receipt.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("Network-enabled draft tools always require explicit approval before execution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-network-draft-"));
  const registry = new ToolRegistry();
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const calls = { count: 0 };
  registry.register({
    id: "web.draft_publish",
    name: "Prepare external draft",
    description: "Creates a draft on a network service",
    scope: "web:write",
    risk: "draft",
    trust: "external",
    network: true,
    externalAction: false,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    handler: async ({ text }) => { calls.count += 1; return { saved: text }; }
  });
  await permissionStore.grant("alice", "web:write");
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });
  try {
    const planned = await dispatcher.dispatch({ userId: "alice", toolId: "web.draft_publish", args: { text: "hello" }, turnId: "network-draft" });
    assert.equal(planned.status, "awaiting_user_approval");
    assert.equal(calls.count, 0, "The handler must not run before explicit approval");
    const result = await dispatcher.approve("alice", planned.actionId);
    assert.equal(result.status, "completed");
    assert.equal(calls.count, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Failed approval card state survives conversation reload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-failed-approval-card-"));
  const store = new ConversationStore({ dataDirectory: dir });
  try {
    const conversation = await store.create("alice");
    const actionId = "approval-action-1";
    await store.appendMessage("alice", conversation.id, {
      role: "assistant",
      content: "I need approval to continue.",
      actionCard: { actionId, toolId: "web.draft_publish", state: "approval", label: "External draft" }
    });
    const updated = await store.updateActionCardState("alice", actionId, {
      state: "failed",
      detail: "The approval was consumed; check the destination before retrying."
    });
    assert.equal(updated.updated, true);
    const reloaded = new ConversationStore({ dataDirectory: dir });
    const restored = await reloaded.get("alice", conversation.id);
    assert.equal(restored.messages[0].actionCard.state, "failed");
    assert.match(restored.messages[0].actionCard.detail, /consumed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("External approval interruption records an unknown outcome and forbids blind retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-approval-unknown-"));
  const registry = new ToolRegistry();
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const auditStore = new AuditStore({ dataDirectory: dir });
  let sideEffectStarted = false;

  registry.register({
    id: "external.publish",
    name: "Publish external item",
    description: "Publishes an item to an external service",
    scope: "external:write",
    risk: "write",
    trust: "external",
    network: true,
    externalAction: true,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
      additionalProperties: false
    },
    handler: async () => {
      sideEffectStarted = true;
      throw new Error("Connection dropped after the remote service accepted the request.");
    }
  });
  await permissionStore.grant("alice", "external:write");
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore, auditStore });

  try {
    const proposal = await dispatcher.dispatch({
      userId: "alice",
      toolId: "external.publish",
      args: { title: "Release notes" },
      turnId: "unknown-outcome"
    });
    assert.equal(proposal.status, "awaiting_user_approval");

    await assert.rejects(
      () => dispatcher.approve("alice", proposal.actionId),
      (error) => error.actionConsumed === true
        && error.actionOutcomeUnknown === true
        && error.code === "ACTION_OUTCOME_UNKNOWN"
    );

    assert.equal(sideEffectStarted, true);
    const [receipt] = await pendingActionStore.listReceipts("alice");
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.verified, false);
    assert.equal(receipt.verificationState, "outcome_unknown");
    assert.match(receipt.verificationDetail, /may have partially completed/i);
    assert.match(receipt.verificationDetail, /check the destination before retrying/i);
    const events = await auditStore.list("alice", { limit: 20 });
    assert.ok(events.some((event) => event.event === "tool.approval_outcome_unknown"));
    await assert.rejects(
      () => dispatcher.approve("alice", proposal.actionId),
      (error) => error.status === 404,
      "A consumed uncertain action must never execute a second time"
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("Concurrent approval requests can consume and execute one pending action only once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-concurrent-approval-"));
  const registry = new ToolRegistry();
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  let executions = 0;
  let releaseExecution;
  let signalExecutionStarted;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const executionStarted = new Promise((resolve) => { signalExecutionStarted = resolve; });
  registry.register({
    id: "ops.concurrent_write",
    name: "Concurrent write",
    description: "A write used to verify approval single-consumption.",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"],
      additionalProperties: false
    },
    handler: async ({ value }) => {
      executions += 1;
      signalExecutionStarted();
      await executionGate;
      return { saved: value };
    }
  });
  await permissionStore.grant("alice", "ops:write");
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });
  try {
    const proposal = await dispatcher.dispatch({
      userId: "alice",
      toolId: "ops.concurrent_write",
      args: { value: "once" },
      turnId: "concurrent-approval"
    });
    assert.equal(proposal.status, "awaiting_user_approval");

    const first = dispatcher.approve("alice", proposal.actionId);
    const second = dispatcher.approve("alice", proposal.actionId);
    // Attach rejection handlers immediately, then wait for the winner to enter
    // the handler before releasing it and collecting both outcomes.
    const resultsPromise = Promise.allSettled([first, second]);
    await executionStarted;
    releaseExecution();

    const results = await resultsPromise;
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = results.find((item) => item.status === "rejected");
    assert.equal(rejected.reason.status, 404);
    assert.equal(executions, 1);

    const receipts = await pendingActionStore.listReceipts("alice");
    assert.equal(receipts.filter((item) => item.actionId === proposal.actionId).length, 1);
  } finally {
    releaseExecution();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Pending approvals fail closed after permission revocation or capability lease expiry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-approval-permission-revoked-"));
  let now = Date.parse("2026-11-26T22:00:00.000Z");
  const registry = new ToolRegistry();
  const permissionStore = new PermissionStore({ dataDirectory: dir, now: () => now });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir, now: () => now });
  let executions = 0;

  registry.register({
    id: "ops.permission_checked_write",
    name: "Permission-checked write",
    description: "A write used to verify capability revocation at approval time.",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"],
      additionalProperties: false
    },
    handler: async ({ value }) => {
      executions += 1;
      return { saved: value };
    }
  });

  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });
  try {
    await permissionStore.grant("alice", "ops:write");
    const revokedProposal = await dispatcher.dispatch({
      userId: "alice",
      toolId: "ops.permission_checked_write",
      args: { value: "revoked" },
      turnId: "permission-revoked"
    });
    assert.equal(revokedProposal.status, "awaiting_user_approval");

    await permissionStore.revoke("alice", "ops:write");
    await assert.rejects(
      () => dispatcher.approve("alice", revokedProposal.actionId),
      (error) => error.status === 403
    );
    assert.equal(executions, 0, "Revoked permissions must prevent the pending action from executing");

    await permissionStore.grant("alice", "ops:write", { ttlMinutes: 1 });
    const expiringProposal = await dispatcher.dispatch({
      userId: "alice",
      toolId: "ops.permission_checked_write",
      args: { value: "expired" },
      turnId: "permission-expiry"
    });
    assert.equal(expiringProposal.status, "awaiting_user_approval");

    now += 60 * 1000;
    await assert.rejects(
      () => dispatcher.approve("alice", expiringProposal.actionId),
      (error) => error.status === 403
    );
    assert.equal(executions, 0, "Expired capability leases must prevent the pending action from executing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a Core restart recovers an in-flight approval as outcome_unknown and never makes it replayable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-approval-restart-recovery-"));
  try {
    const beforeRestart = new PendingActionStore({ dataDirectory: dir });
    const proposal = await beforeRestart.create("alice", {
      toolId: "github.change.create_pr",
      risk: "write",
      arguments: { repo: "acme/demo", branch: "alfie/recovery" },
      argumentsHash: "stable-args-hash",
      toolFingerprint: "stable-tool-fingerprint",
      preview: "Create reviewed branch and draft PR",
      simulation: {
        riskLevel: "high",
        summary: "Create a reviewed GitHub change",
        affectedResource: "github:acme/demo:branch:alfie/recovery",
        rollbackPlan: "Inspect and close any created pull request"
      }
    });

    const executing = await beforeRestart.take("alice", proposal.id);
    assert.equal(executing.status, "executing");
    assert.ok(executing.executionInstanceId);

    // Creating another proposal must not discard the durable in-flight marker.
    const secondProposal = await beforeRestart.create("alice", {
      toolId: "notes.save",
      risk: "write",
      arguments: { text: "second proposal" },
      argumentsHash: "second-args-hash",
      toolFingerprint: "second-tool-fingerprint",
      preview: "Save a second note"
    });

    // A fresh store instance represents a Core process restart.
    const afterRestart = new PendingActionStore({ dataDirectory: dir });
    const receipts = await afterRestart.listReceipts("alice");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].actionId, proposal.id);
    assert.equal(receipts[0].status, "failed");
    assert.equal(receipts[0].verified, false);
    assert.equal(receipts[0].verificationState, "outcome_unknown");
    assert.match(receipts[0].verificationDetail, /Core restarted/i);

    const pendingAfterRestart = await afterRestart.list("alice");
    assert.deepEqual(pendingAfterRestart.map((item) => item.id), [secondProposal.id]);
    await assert.rejects(
      () => afterRestart.take("alice", proposal.id),
      (error) => error.status === 404
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

