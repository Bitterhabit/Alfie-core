import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";
import { registerMemoryTools } from "../src/integrations/memoryTools.mjs";

test("Simulation dry-run previews and verified Action Receipts work for memory.remember, memory.update, and memory.forget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-sim-receipts-"));
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const registry = new ToolRegistry();
  registerMemoryTools(registry, memoryStore);
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });

  await permissionStore.grant("alice", "memory:write");

  // 1. memory.remember -> medium risk, no backup required, rollback mentions archive/delete
  const proposeRemember = await dispatcher.dispatch({
    userId: "alice",
    toolId: "memory.remember",
    args: { kind: "decision", text: "Prefer deterministic watchers over LLM polling.", importance: 5 },
    turnId: "turn-remember"
  });
  assert.equal(proposeRemember.status, "awaiting_user_approval");
  assert.ok(proposeRemember.simulation);
  assert.equal(proposeRemember.simulation.riskLevel, "low");
  assert.equal(proposeRemember.simulation.backupRequired, false);
  assert.match(proposeRemember.simulation.summary, /decision/i);
  assert.ok(proposeRemember.simulation.validationSteps.length >= 1);

  const approvedRemember = await dispatcher.approve("alice", proposeRemember.actionId);
  assert.equal(approvedRemember.status, "completed");
  assert.ok(approvedRemember.receipt);
  assert.equal(approvedRemember.receipt.verified, true);
  assert.equal(approvedRemember.receipt.status, "completed");
  assert.equal(approvedRemember.receipt.toolId, "memory.remember");
  const allMemories = await memoryStore.list("alice");
  const memoryId = allMemories[0].id;

  // 2. memory.update -> medium risk, rollback preserves previous text snippet
  const proposeUpdate = await dispatcher.dispatch({
    userId: "alice",
    toolId: "memory.update",
    args: { memoryId, text: "Prefer deterministic watchers with 4-tier attention budgets." },
    turnId: "turn-update"
  });
  assert.equal(proposeUpdate.status, "awaiting_user_approval");
  assert.equal(proposeUpdate.simulation.riskLevel, "medium");
  assert.match(proposeUpdate.simulation.rollbackPlan, /Prefer deterministic watchers/i);

  const approvedUpdate = await dispatcher.approve("alice", proposeUpdate.actionId);
  assert.equal(approvedUpdate.status, "completed");
  assert.equal(approvedUpdate.receipt.verified, true);

  // 3. memory.forget -> high risk, backupRequired: true, rollback warns permanent removal
  const proposeForget = await dispatcher.dispatch({
    userId: "alice",
    toolId: "memory.forget",
    args: { memoryId },
    turnId: "turn-forget"
  });
  assert.equal(proposeForget.status, "awaiting_user_approval");
  assert.equal(proposeForget.simulation.riskLevel, "high");
  assert.equal(proposeForget.simulation.backupRequired, true);
  assert.match(proposeForget.simulation.rollbackPlan, /permanent|irreversible/i);

  const approvedForget = await dispatcher.approve("alice", proposeForget.actionId);
  assert.equal(approvedForget.status, "completed");
  assert.equal(approvedForget.receipt.verified, true);
  assert.equal(approvedForget.receipt.riskLevel, "high");

  // Persisted receipts are listed newest-first for alice and isolated from bob
  const aliceReceipts = await pendingActionStore.listReceipts("alice");
  assert.equal(aliceReceipts.length, 3);
  assert.equal(aliceReceipts[0].toolId, "memory.forget");
  assert.equal(aliceReceipts[1].toolId, "memory.update");
  assert.equal(aliceReceipts[2].toolId, "memory.remember");
  const bobReceipts = await pendingActionStore.listReceipts("bob");
  assert.equal(bobReceipts.length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Generic write tool without custom dryRun gets a safe normalized simulation and records failed receipts on execution errors", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-sim-generic-"));
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const registry = new ToolRegistry();

  registry.register({
    id: "ops.restart",
    name: "Restart Homelab Service",
    description: "Restart a service container",
    scope: "ops:write",
    risk: "write",
    trust: "internal",
    network: true,
    externalAction: true,
    inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"], additionalProperties: false },
    handler: async () => {
      throw new Error("Simulated container daemon offline");
    }
  });

  await permissionStore.grant("alice", "ops:write");
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });

  const proposed = await dispatcher.dispatch({
    userId: "alice",
    toolId: "ops.restart",
    args: { service: "caddy" },
    turnId: "t-ops"
  });
  assert.equal(proposed.status, "awaiting_user_approval");
  assert.equal(proposed.simulation.riskLevel, "high"); // externalAction defaults to high
  assert.match(proposed.simulation.rollbackPlan, /manual reversal/i);
  assert.ok(proposed.simulation.dependencies.includes("External network endpoint"));

  await assert.rejects(
    () => dispatcher.approve("alice", proposed.actionId),
    (error) => error.code === "ACTION_OUTCOME_UNKNOWN" && error.actionOutcomeUnknown === true
  );

  const receipts = await pendingActionStore.listReceipts("alice");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "failed");
  assert.equal(receipts[0].verified, false);
  assert.equal(receipts[0].verificationState, "outcome_unknown");
  assert.match(receipts[0].verificationDetail, /may have partially completed/i);
  assert.match(receipts[0].verificationDetail, /check the destination before retrying/i);

  await fs.rm(dir, { recursive: true, force: true });
});
