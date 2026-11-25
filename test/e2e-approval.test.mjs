import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createAlfieCoreServer } from "../src/server.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { AuditStore } from "../src/audit/store.mjs";

async function withServer(options, run) {
  const server = createAlfieCoreServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("agent proposal stays pending until the owning Petrio user approves it, then executes once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-e2e-"));
  const serviceToken = "e2e-service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "e2e-identity-secret-".repeat(3) });
  const permissionStore = new PermissionStore({ dataDirectory: directory });
  const pendingActionStore = new PendingActionStore({ dataDirectory: directory });
  const toolRegistry = new ToolRegistry();
  let executions = 0;

  toolRegistry.register({
    id: "calendar.create",
    name: "Create calendar event",
    description: "Create a calendar event after explicit approval.",
    scope: "calendar:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
      required: ["title"],
      additionalProperties: false
    },
    handler: async ({ title }) => {
      executions += 1;
      return { created: true, title };
    }
  });
  await permissionStore.grant("user-a", "calendar:write");

  const providerRegistry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "mock-model" }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "tool_call",
                tool: "calendar.create",
                arguments: { title: "Evening workout" }
              })
            }
          }]
        })
      };
    }
  });

  try {
    await withServer({
      serviceToken,
      identityAuth,
      providerRegistry,
      providerConfig: {
        mode: "auto",
        endpoints: [{ id: "mock", provider: "openai-compatible", baseUrl: "http://mock-model/v1", model: "mock-model" }]
      },
      permissionStore,
      pendingActionStore,
      auditStore: new AuditStore({ dataDirectory: directory }),
      toolRegistry
    }, async (base) => {
      const headersFor = (userId, method, requestPath) => ({
        authorization: `Bearer ${serviceToken}`,
        ...identityAuth.sign(userId, { method, path: requestPath }),
        "content-type": "application/json"
      });

      const proposed = await fetch(`${base}/v1/agent/run`, {
        method: "POST",
        headers: headersFor("user-a", "POST", "/v1/agent/run"),
        body: JSON.stringify({ messages: [{ role: "user", content: "Add an evening workout to my calendar." }] })
      });
      assert.equal(proposed.status, 202);
      const proposal = await proposed.json();
      assert.equal(proposal.status, "awaiting_user_approval");
      assert.ok(proposal.actionId);
      assert.equal(executions, 0);

      const otherUserAttempt = await fetch(`${base}/v1/tools/approve`, {
        method: "POST",
        headers: headersFor("user-b", "POST", "/v1/tools/approve"),
        body: JSON.stringify({ actionId: proposal.actionId })
      });
      assert.equal(otherUserAttempt.status, 404);
      assert.equal(executions, 0);

      const approved = await fetch(`${base}/v1/tools/approve`, {
        method: "POST",
        headers: headersFor("user-a", "POST", "/v1/tools/approve"),
        body: JSON.stringify({ actionId: proposal.actionId })
      });
      assert.equal(approved.status, 200);
      assert.deepEqual((await approved.json()).result, { created: true, title: "Evening workout" });
      assert.equal(executions, 1);

      const replay = await fetch(`${base}/v1/tools/approve`, {
        method: "POST",
        headers: headersFor("user-a", "POST", "/v1/tools/approve"),
        body: JSON.stringify({ actionId: proposal.actionId })
      });
      assert.equal(replay.status, 404);
      assert.equal(executions, 1);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("external approval endpoint reports an uncertain side effect and prevents replay", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-e2e-unknown-"));
  const serviceToken = "e2e-service-token-unknown-" .repeat(2);
  const identityAuth = createPetrioIdentityAuth({ secret: "e2e-identity-secret-unknown-" .repeat(2) });
  const permissionStore = new PermissionStore({ dataDirectory: directory });
  const pendingActionStore = new PendingActionStore({ dataDirectory: directory });
  const auditStore = new AuditStore({ dataDirectory: directory });
  const toolRegistry = new ToolRegistry();
  let sideEffectStarted = false;

  toolRegistry.register({
    id: "external.publish",
    name: "Publish external item",
    description: "Publish an item to an external service",
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
      throw new Error("Remote service accepted the request but its response was lost.");
    }
  });
  await permissionStore.grant("user-a", "external:write");

  const providerRegistry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "mock-model" }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "tool_call",
                tool: "external.publish",
                arguments: { title: "Release notes" }
              })
            }
          }]
        })
      };
    }
  });

  try {
    await withServer({
      serviceToken,
      identityAuth,
      providerRegistry,
      providerConfig: {
        mode: "auto",
        endpoints: [{ id: "mock", provider: "openai-compatible", baseUrl: "http://mock-model/v1", model: "mock-model" }]
      },
      permissionStore,
      pendingActionStore,
      auditStore,
      toolRegistry
    }, async (base) => {
      const headersFor = (method, requestPath) => ({
        authorization: `Bearer ${serviceToken}`,
        ...identityAuth.sign("user-a", { method, path: requestPath }),
        "content-type": "application/json"
      });

      const proposedResponse = await fetch(`${base}/v1/agent/run`, {
        method: "POST",
        headers: headersFor("POST", "/v1/agent/run"),
        body: JSON.stringify({ messages: [{ role: "user", content: "Publish the release notes." }] })
      });
      assert.equal(proposedResponse.status, 202);
      const proposal = await proposedResponse.json();
      assert.equal(proposal.status, "awaiting_user_approval");
      assert.ok(proposal.actionId);
      assert.equal(sideEffectStarted, false);

      const approvalResponse = await fetch(`${base}/v1/tools/approve`, {
        method: "POST",
        headers: headersFor("POST", "/v1/tools/approve"),
        body: JSON.stringify({ actionId: proposal.actionId })
      });
      assert.equal(approvalResponse.status, 502);
      const failure = await approvalResponse.json();
      assert.equal(failure.actionConsumed, true);
      assert.equal(failure.actionOutcomeUnknown, true);
      assert.equal(failure.retryable, false);
      assert.equal(failure.code, "ACTION_OUTCOME_UNKNOWN");
      assert.equal(sideEffectStarted, true);

      const receiptResponse = await fetch(`${base}/v1/tools/receipts`, {
        headers: headersFor("GET", "/v1/tools/receipts")
      });
      const receipts = await receiptResponse.json();
      assert.equal(receipts.receipts[0].verificationState, "outcome_unknown");
      assert.match(receipts.receipts[0].verificationDetail, /check the destination before retrying/i);

      const replay = await fetch(`${base}/v1/tools/approve`, {
        method: "POST",
        headers: headersFor("POST", "/v1/tools/approve"),
        body: JSON.stringify({ actionId: proposal.actionId })
      });
      assert.equal(replay.status, 404);
      assert.equal(sideEffectStarted, true);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
