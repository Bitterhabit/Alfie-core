import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionStore } from "../src/permissions/store.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";

test("PermissionStore enforces time-bounded and project-scoped Capability Leases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-leases-"));
  let currentMs = Date.parse("2026-06-01T10:00:00.000Z");
  const now = () => currentMs;
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const permissionStore = new PermissionStore({ dataDirectory: dir, now });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir, now });
  const registry = new ToolRegistry();

  registry.register({
    id: "demo.read",
    name: "Demo read",
    description: "Read demo value",
    scope: "demo:read",
    risk: "read",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true })
  });

  registry.register({
    id: "demo.write",
    name: "Demo write",
    description: "Write demo value",
    scope: "demo:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ written: true })
  });

  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore, now });

  // Grant demo:read for 60 minutes locked to projectA
  await permissionStore.grant("alice", "demo:read", { ttlMinutes: 60, projectId: projectA });

  // Denied without project or in projectB
  await assert.rejects(
    () => dispatcher.dispatch({ userId: "alice", toolId: "demo.read", args: {}, turnId: "t1", projectId: null }),
    (err) => err.status === 403
  );
  await assert.rejects(
    () => dispatcher.dispatch({ userId: "alice", toolId: "demo.read", args: {}, turnId: "t2", projectId: projectB }),
    (err) => err.status === 403
  );

  // Allowed inside projectA before expiry
  const res = await dispatcher.dispatch({ userId: "alice", toolId: "demo.read", args: {}, turnId: "t3", projectId: projectA });
  assert.equal(res.status, "completed");

  // Grant demo:write for 2 minutes, propose an approval, then let lease expire (while pending action is still valid)
  await permissionStore.grant("alice", "demo:write", { ttlMinutes: 2, projectId: projectA });
  const proposed = await dispatcher.dispatch({ userId: "alice", toolId: "demo.write", args: {}, turnId: "t4", projectId: projectA });
  assert.equal(proposed.status, "awaiting_user_approval");

  // Advance clock 3 minutes -> demo:write lease has expired, approval MUST be rejected with 403
  currentMs += 3 * 60 * 1000;
  await assert.rejects(
    () => dispatcher.approve("alice", proposed.actionId),
    (err) => err.status === 403
  );

  // Advance clock 60 more minutes (63 total) -> demo:read lease also auto-expires
  currentMs += 60 * 60 * 1000;
  const detailed = await permissionStore.listDetailed("alice");
  assert.equal(detailed.scopes.length, 0);
  assert.equal(detailed.leases.length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});
