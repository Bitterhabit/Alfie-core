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

test("Capability leases coexist independently across Global, Project A, and Project B with scoped revocation and safe legacy migration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-leases-iso-"));
  let currentMs = Date.parse("2026-06-01T10:00:00.000Z");
  const now = () => currentMs;
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const projectC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const store = new PermissionStore({ dataDirectory: dir, now });

  try {
    // 1. Project A and Project B grants for the SAME scope coexist without clobbering each other
    await store.grant("alice", "memory:read", { projectId: projectA, ttlMinutes: 30, note: "Project A lease" });
    await store.grant("alice", "memory:read", { projectId: projectB, ttlMinutes: 90, note: "Project B lease" });

    assert.deepEqual(await store.list("alice", { projectId: projectA }), ["memory:read"]);
    assert.deepEqual(await store.list("alice", { projectId: projectB }), ["memory:read"]);
    assert.deepEqual(await store.list("alice", { projectId: projectC }), []);
    assert.deepEqual(await store.list("alice", { projectId: null }), []); // Still NOT granted globally!

    const detailed2 = await store.listDetailed("alice");
    assert.equal(detailed2.leases.length, 2);
    assert.deepEqual(detailed2.scopes, ["memory:read"]); // Deduplicated

    // 2. Add a Global grant for the same scope — all three coexist
    await store.grant("alice", "memory:read", { ttlMinutes: 120, note: "Global lease" });
    const detailed3 = await store.listDetailed("alice");
    assert.equal(detailed3.leases.length, 3);
    assert.deepEqual(await store.list("alice", { projectId: projectC }), ["memory:read"]); // Covered by global

    // 3. Project-specific revocation removes ONLY Project A; Project B & Global stay intact
    await store.revoke("alice", "memory:read", { projectId: projectA });
    const afterRevokeA = await store.listDetailed("alice");
    assert.equal(afterRevokeA.leases.length, 2);
    assert.equal(afterRevokeA.leases.some((l) => l.projectId === projectA), false);
    assert.equal(afterRevokeA.leases.some((l) => l.projectId === projectB), true);
    assert.equal(afterRevokeA.leases.some((l) => l.projectId === null), true);

    // 4. Global-only revocation ({ projectId: null }) removes ONLY Global; Project B stays intact
    await store.revoke("alice", "memory:read", { projectId: null });
    const afterRevokeGlobal = await store.listDetailed("alice");
    assert.equal(afterRevokeGlobal.leases.length, 1);
    assert.equal(afterRevokeGlobal.leases[0].projectId, projectB);
    assert.deepEqual(await store.list("alice", { projectId: null }), []);
    assert.deepEqual(await store.list("alice", { projectId: projectC }), []);
    assert.deepEqual(await store.list("alice", { projectId: projectB }), ["memory:read"]);

    // 5. Expiry of one project lease does not expire another project's lease
    await store.grant("alice", "memory:read", { projectId: projectA, ttlMinutes: 10 });
    currentMs += 15 * 60 * 1000; // 15m elapsed -> projectA (10m) expired, projectB (90m) still valid
    assert.deepEqual(await store.list("alice", { projectId: projectA }), []);
    assert.deepEqual(await store.list("alice", { projectId: projectB }), ["memory:read"]);

    // 6. Revoking scope WITHOUT projectId revokes ALL matching grants (Global + all projects)
    await store.grant("alice", "memory:read", { projectId: projectA, ttlMinutes: 60 });
    await store.grant("alice", "memory:read", { ttlMinutes: 60 });
    await store.grant("alice", "calendar:read"); // Unrelated scope must remain
    await store.revoke("alice", "memory:read");
    const afterRevokeAll = await store.listDetailed("alice");
    assert.deepEqual(afterRevokeAll.scopes, ["calendar:read"]);
    assert.equal(afterRevokeAll.leases.length, 1);

    // 7. Legacy store migration (no `leases` array) migrates scopes cleanly as global grants
    const legacyFile = store.fileFor("legacy-user");
    await fs.mkdir(path.dirname(legacyFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "legacy-user",
      scopes: ["calendar:read"],
      updatedAt: "2026-01-01T00:00:00.000Z"
    }), "utf8");
    const legacyList = await store.listDetailed("legacy-user");
    assert.deepEqual(legacyList.scopes, ["calendar:read"]);
    assert.equal(legacyList.leases.length, 1);
    assert.equal(legacyList.leases[0].projectId, null);

    // 8. Modern store with project-scoped lease MUST NOT widen permissions from `scopes`
    const modernFile = store.fileFor("modern-user");
    await fs.mkdir(path.dirname(modernFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(modernFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "modern-user",
      scopes: ["memory:write"],
      leases: [{
        scope: "memory:write",
        grantedAt: "2026-06-01T09:00:00.000Z",
        expiresAt: "2026-06-01T12:00:00.000Z",
        projectId: projectA,
        note: "Project A only"
      }],
      updatedAt: "2026-06-01T09:00:00.000Z"
    }), "utf8");
    assert.deepEqual(await store.list("modern-user", { projectId: projectA }), ["memory:write"]);
    assert.deepEqual(await store.list("modern-user", { projectId: projectB }), [], "Project A lease must never widen to Project B");
    assert.deepEqual(await store.list("modern-user", { projectId: null }), [], "Project A lease must never widen to global");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

