import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextCapsuleStore } from "../src/capsules/store.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { WorkflowProfileStore } from "../src/profile/store.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { AuditStore } from "../src/audit/store.mjs";

test("ContextCapsuleStore validates scopes, TTL bounds, project IDs, and isolates users", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-capsules-"));
  const store = new ContextCapsuleStore({ dataDirectory: dir });
  const allowedScopes = new Set(["memory:read", "memory:write"]);
  const projectId = "11111111-1111-4111-8111-111111111111";

  // Reject unknown scope or out-of-range TTL
  await assert.rejects(
    () => store.create("alice", { name: "Bad Scope", leaseTemplate: [{ scope: "shell:exec", ttlMinutes: 60 }] }, { allowedScopes }),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => store.create("alice", { name: "Bad TTL", leaseTemplate: [{ scope: "memory:read", ttlMinutes: 2 }] }, { allowedScopes }),
    (err) => err.status === 400
  );

  const created = await store.create("alice", {
    name: "Architecture Deep Work",
    description: "Focused systems design posture",
    projectId,
    workingMode: "engineer",
    learningMode: "explain",
    privacyPosture: "local_only",
    leaseTemplate: [{ scope: "memory:read", ttlMinutes: 60 }]
  }, { allowedScopes });

  assert.equal(created.name, "Architecture Deep Work");
  assert.equal(created.workingMode, "engineer");
  assert.equal(created.leaseTemplate.length, 1);

  const activated = await store.markActivated("alice", created.id);
  assert.equal(activated.activeCapsuleId, created.id);
  assert.ok(activated.capsule.lastActivatedAt);

  // User isolation
  const bobList = await store.list("bob");
  assert.equal(bobList.capsules.length, 0);
  assert.equal(bobList.activeCapsuleId, null);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Core server POST /v1/capsules/:id/activate updates profile learningMode, grants project-scoped capability leases, and records audit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-capsules-srv-"));
  const serviceToken = "service-token-".repeat(3);
  const identitySecret = "identity-secret-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: identitySecret });
  const server = createAlfieCoreServer({
    serviceToken,
    identityAuth,
    projectStore: new ProjectStore({ dataDirectory: dir }),
    permissionStore: new PermissionStore({ dataDirectory: dir }),
    profileStore: new WorkflowProfileStore({ dataDirectory: dir }),
    capsuleStore: new ContextCapsuleStore({ dataDirectory: dir }),
    auditStore: new AuditStore({ dataDirectory: dir })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const authHeaders = (method, reqPath, userId = "alice") => ({
    authorization: `Bearer ${serviceToken}`,
    "content-type": "application/json",
    ...identityAuth.sign(userId, { method, path: reqPath })
  });

  try {
    // 1. Create a project
    const projRes = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: authHeaders("POST", "/v1/projects"),
      body: JSON.stringify({ name: "Homelab Migration", description: "Proxmox cluster" })
    });
    assert.equal(projRes.status, 201);
    const { project } = await projRes.json();

    // 2. Create a Context Capsule bound to that project + engineer + tutor + memory:read 60m lease
    const capRes = await fetch(`${base}/v1/capsules`, {
      method: "POST",
      headers: authHeaders("POST", "/v1/capsules"),
      body: JSON.stringify({
        name: "Homelab Review",
        description: "Scoped read-only review",
        projectId: project.id,
        workingMode: "engineer",
        learningMode: "tutor",
        privacyPosture: "local_only",
        leaseTemplate: [{ scope: "memory:read", ttlMinutes: 60 }]
      })
    });
    assert.equal(capRes.status, 201);
    const { capsule } = await capRes.json();

    // 3. Activate capsule
    const actPath = `/v1/capsules/${capsule.id}/activate`;
    const actRes = await fetch(`${base}${actPath}`, {
      method: "POST",
      headers: authHeaders("POST", actPath),
      body: JSON.stringify({})
    });
    assert.equal(actRes.status, 200);
    const actBody = await actRes.json();
    assert.equal(actBody.activeCapsuleId, capsule.id);
    assert.equal(actBody.profile.learningMode, "tutor");
    assert.equal(actBody.grantedLeases.length, 1);
    assert.equal(actBody.grantedLeases[0].scope, "memory:read");
    assert.equal(actBody.grantedLeases[0].projectId, project.id);

    // 4. Verify PermissionStore now holds the project-scoped lease
    const permRes = await fetch(`${base}/v1/permissions`, { headers: authHeaders("GET", "/v1/permissions") });
    assert.equal(permRes.status, 200);
    const permBody = await permRes.json();
    const lease = permBody.leases.find((l) => l.scope === "memory:read");
    assert.ok(lease);
    assert.equal(lease.projectId, project.id);
    assert.ok(lease.expiresAt);

    // 5. Verify Audit log recorded capsule.activated
    const auditRes = await fetch(`${base}/v1/audit`, { headers: authHeaders("GET", "/v1/audit") });
    assert.equal(auditRes.status, 200);
    const auditBody = await auditRes.json();
    const auditEvents = auditBody.events || auditBody.entries || [];
    assert.ok(auditEvents.some((e) => e.event === "capsule.activated"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
