import test from "node:test";
import assert from "node:assert/strict";
import { createAlfieCoreServer } from "../src/server.mjs";
import { AuditStore } from "../src/audit/store.mjs";

async function withServer(options, run) {
  const server = createAlfieCoreServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health is public and reports the service identity", async () => {
  await withServer({ serviceToken: "a".repeat(40) }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "alfie-core", version: "0.3.0" });
  });
});

test("readiness fails closed until a sufficiently long service token is configured", async () => {
  await withServer({ serviceToken: "short" }, async (base) => {
    const response = await fetch(`${base}/ready`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, "configuration-required");
  });
});

test("readiness requires both the service token and signed Petrio identity secret", async () => {
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  await withServer({ serviceToken: "a".repeat(40) }, async (base) => {
    const response = await fetch(`${base}/ready`);
    assert.equal(response.status, 503);
    const checks = await response.json();
    assert.equal(checks.checks.serviceTokenConfigured, true);
    assert.equal(checks.checks.identitySecretConfigured, false);
  });
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  await withServer({ serviceToken: "a".repeat(40), identityAuth }, async (base) => {
    const response = await fetch(`${base}/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checks.identitySecretConfigured, true);
  });
});

test("versioned API rejects missing and incorrect service tokens", async () => {
  await withServer({ serviceToken: "a".repeat(40) }, async (base) => {
    const missing = await fetch(`${base}/v1/status`);
    assert.equal(missing.status, 401);
    const incorrect = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${"b".repeat(40)}` } });
    assert.equal(incorrect.status, 401);
  });
});

test("versioned API accepts the configured service token", async () => {
  const token = "test-token-".repeat(4);
  await withServer({ serviceToken: token }, async (base) => {
    const response = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, "alfie-core");
    assert.ok(body.implemented.includes("service-authentication"));
    assert.ok(!body.implemented.includes("provider-routing"));
  });
});

test("provider routes expose redacted configuration and health", async () => {
  const token = "service-token-".repeat(3);
  const { ProviderRegistry } = await import("../src/providers/registry.mjs");
  const registry = new ProviderRegistry({
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ models: [{ name: "qwen2.5:14b" }] }),
      json: async () => ({ message: { content: "hello" } })
    })
  });
  const config = {
    mode: "auto",
    endpoints: [{
      id: "thor", provider: "ollama", baseUrl: "http://thor:11434",
      model: "qwen2.5:14b", apiKey: "do-not-leak"
    }]
  };
  await withServer({ serviceToken: token, providerConfig: config, providerRegistry: registry }, async (base) => {
    const headers = { authorization: `Bearer ${token}` };
    const providers = await fetch(`${base}/v1/providers`, { headers });
    assert.equal(providers.status, 200);
    const publicBody = await providers.json();
    assert.equal(publicBody.endpoints[0].apiKey, undefined);
    assert.equal(publicBody.endpoints[0].apiKeyConfigured, true);
    const health = await fetch(`${base}/v1/providers/health`, { headers });
    assert.equal((await health.json()).endpoints[0].modelAvailable, true);
  });
});

test("chat endpoint selects a provider and returns model metadata", async () => {
  const token = "service-token-".repeat(3);
  const { ProviderRegistry } = await import("../src/providers/registry.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const registry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "test-model" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `{"type":"final","message":"Hello from Core"}` } }] }) };
    }
  });
  const providerConfig = {
    mode: "auto",
    endpoints: [{ id: "test", model: "test-model", baseUrl: "http://model:1234/v1" }]
  };
  await withServer({ serviceToken: token, identityAuth, providerConfig, providerRegistry: registry }, async (base) => {
    const response = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...identityAuth.sign("user-1", { method: "POST", path: "/v1/chat" }), "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message, "Hello from Core");
    assert.equal(body.endpointId, "test");
    assert.equal(body.provider, "openai-compatible");
  });
});

test("agent endpoints preserve authentication failures as HTTP 401", async () => {
  const token = "service-token-".repeat(3);
  await withServer({ serviceToken: token }, async (base) => {
    const response = await fetch(`${base}/v1/agent/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 401);
  });
});

test("chat endpoint rejects malformed and empty message requests", async () => {
  const token = "service-token-".repeat(3);
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  await withServer({ serviceToken: token, identityAuth }, async (base) => {
    const response = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...identityAuth.sign("user-1", { method: "POST", path: "/v1/chat" }), "content-type": "application/json" },
      body: JSON.stringify({ messages: [] })
    });
    assert.equal(response.status, 400);
  });
});

test("streaming chat returns newline-delimited meta, delta and done events", async () => {
  const token = "service-token-".repeat(3);
  const { ProviderRegistry } = await import("../src/providers/registry.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const registry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "stream-model" }] }) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"type":"final","message":"Hello"}' } }] })
      };
    }
  });
  const providerConfig = {
    mode: "auto",
    endpoints: [{ id: "stream", model: "stream-model", baseUrl: "http://stream-model/v1" }]
  };
  await withServer({ serviceToken: token, identityAuth, providerConfig, providerRegistry: registry }, async (base) => {
    const response = await fetch(`${base}/v1/chat/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...identityAuth.sign("user-1", { method: "POST", path: "/v1/chat/stream" }), "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["meta", "delta", "done"]);
    assert.equal(events.at(-1).message, "Hello");
  });
});

test("user-scoped Core routes require a signed Petrio identity assertion", async () => {
  const token = "service-token-".repeat(3);
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  await withServer({ serviceToken: token, identityAuth }, async (base) => {
    const missing = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(missing.status, 401);
    const identityHeaders = identityAuth.sign("petrio-user-42", { method: "GET", path: "/v1/whoami" });
    const accepted = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: `Bearer ${token}`, ...identityHeaders }
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      authenticated: true, userId: "petrio-user-42", identityProvider: "petrio", linked: true
    });
  });
});

test("conversation API persists data and isolates users using signed identities", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ConversationStore } = await import("../src/conversations/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-api-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const conversationStore = new ConversationStore({ dataDirectory: directory });
  try {
    await withServer({ serviceToken: token, identityAuth, conversationStore }, async (base) => {
      const headersFor = (userId, method, path) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign(userId, { method, path })
      });
      const created = await fetch(`${base}/v1/conversations`, {
        method: "POST", headers: headersFor("user-a", "POST", "/v1/conversations"),
        body: JSON.stringify({ title: "Project chat" })
      });
      assert.equal(created.status, 201);
      const { conversation } = await created.json();
      const appended = await fetch(`${base}/v1/conversations/${conversation.id}/messages`, {
        method: "POST", headers: { ...headersFor("user-a", "POST", `/v1/conversations/${conversation.id}/messages`), "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content: "Keep this private" })
      });
      assert.equal(appended.status, 201);
      const denied = await fetch(`${base}/v1/conversations/${conversation.id}`, {
        headers: headersFor("user-b", "GET", `/v1/conversations/${conversation.id}`)
      });
      assert.equal(denied.status, 404);
      const loaded = await fetch(`${base}/v1/conversations/${conversation.id}`, {
        headers: headersFor("user-a", "GET", `/v1/conversations/${conversation.id}`)
      });
      assert.equal((await loaded.json()).conversation.messages[0].content, "Keep this private");
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("memory API preserves Garden provenance and enforces user isolation", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { MemoryStore } = await import("../src/memory/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-memory-api-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const memoryStore = new MemoryStore({ dataDirectory: directory });
  try {
    await withServer({ serviceToken: token, identityAuth, memoryStore }, async (base) => {
      const headersFor = (userId, method, path) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign(userId, { method, path })
      });
      const seedResponse = await fetch(`${base}/v1/memories`, {
        method: "POST",
        headers: { ...headersFor("user-a", "POST", "/v1/memories"), "content-type": "application/json" },
        body: JSON.stringify({ text: "I prefer a calm interface", origin: "user-seeded" })
      });
      assert.equal(seedResponse.status, 201);
      const { memory: seed } = await seedResponse.json();
      assert.equal(seed.provenance.capturedBy, "user");
      const alfieResponse = await fetch(`${base}/v1/memories`, {
        method: "POST",
        headers: { ...headersFor("user-a", "POST", "/v1/memories"), "content-type": "application/json" },
        body: JSON.stringify({ text: "Petrio is a personal OS", origin: "alfie-created" })
      });
      assert.equal(alfieResponse.status, 201);
      const filtered = await fetch(`${base}/v1/memories?origin=user-seeded`, {
        headers: headersFor("user-a", "GET", "/v1/memories?origin=user-seeded")
      });
      assert.equal((await filtered.json()).memories.length, 1);
      const forbidden = await fetch(`${base}/v1/memories/${seed.id}`, {
        method: "PATCH",
        headers: { ...headersFor("user-b", "PATCH", `/v1/memories/${seed.id}`), "content-type": "application/json" },
        body: JSON.stringify({ text: "Not yours" })
      });
      assert.equal(forbidden.status, 404);
      const edited = await fetch(`${base}/v1/memories/${seed.id}`, {
        method: "PATCH",
        headers: { ...headersFor("user-a", "PATCH", `/v1/memories/${seed.id}`), "content-type": "application/json" },
        body: JSON.stringify({ text: "I prefer a calm pixel-art interface" })
      });
      assert.equal((await edited.json()).memory.origin, "user-seeded");
      const imported = await fetch(`${base}/v1/memories/import`, {
        method: "POST",
        headers: { ...headersFor("user-a", "POST", "/v1/memories/import"), "content-type": "application/json" },
        body: JSON.stringify({ memories: [{
          id: "123e4567-e89b-12d3-a456-426614174000",
          source: "alfie", type: "explicit", title: "Imported", text: "Legacy Alfie memory",
          tags: ["legacy"], importance: 7, metadata: { explicitRequest: true }, relationships: []
        }] })
      });
      assert.equal(imported.status, 200);
      assert.equal((await imported.json()).imported, 1);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("tool API enforces user scopes and explicit one-time write approvals", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ToolRegistry } = await import("../src/tools/registry.mjs");
  const { PermissionStore } = await import("../src/permissions/store.mjs");
  const { PendingActionStore } = await import("../src/agent/pendingActionStore.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-tools-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const permissionStore = new PermissionStore({ dataDirectory: directory });
  const pendingActionStore = new PendingActionStore({ dataDirectory: directory });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    id: "calendar.create",
    trust: "internal", network: false, externalAction: false,
    name: "Create calendar event",
    scope: "calendar:write",
    risk: "write",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    handler: async (args) => ({ saved: true, title: args.title })
  });
  try {
    await withServer({ serviceToken: token, identityAuth, permissionStore, pendingActionStore, auditStore: new AuditStore({ dataDirectory: directory }), toolRegistry }, async (base) => {
      const headersFor = (method, requestPath) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign("user-a", { method, path: requestPath })
      });
      const beforeGrant = await fetch(`${base}/v1/tools/plan`, {
        method: "POST", headers: { ...headersFor("POST", "/v1/tools/plan"), "content-type": "application/json" },
        body: JSON.stringify({ toolId: "calendar.create", args: { title: "Workout" } })
      });
      assert.equal(beforeGrant.status, 403);
      const grant = await fetch(`${base}/v1/permissions`, {
        method: "POST", headers: { ...headersFor("POST", "/v1/permissions"), "content-type": "application/json" },
        body: JSON.stringify({ scope: "calendar:write" })
      });
      assert.equal(grant.status, 200);
      const planned = await fetch(`${base}/v1/tools/plan`, {
        method: "POST", headers: { ...headersFor("POST", "/v1/tools/plan"), "content-type": "application/json" },
        body: JSON.stringify({ toolId: "calendar.create", args: { title: "Workout" } })
      });
      const plan = await planned.json();
      assert.equal(planned.status, 202);
      assert.equal(plan.status, "awaiting_user_approval");
      assert.ok(plan.actionId);
      const denied = await fetch(`${base}/v1/tools/execute`, {
        method: "POST", headers: { ...headersFor("POST", "/v1/tools/execute"), "content-type": "application/json" },
        body: JSON.stringify({ toolId: "calendar.create", args: { title: "Workout" }, actionId: plan.actionId })
      });
      assert.equal(denied.status, 410);
      const approved = await fetch(`${base}/v1/tools/approve`, {
        method: "POST", headers: { ...headersFor("POST", "/v1/tools/approve"), "content-type": "application/json" },
        body: JSON.stringify({ actionId: plan.actionId })
      });
      assert.equal(approved.status, 200);
      assert.deepEqual((await approved.json()).result, { saved: true, title: "Workout" });
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("conversation database endpoint imports and saves complete user-owned snapshots", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ConversationStore } = await import("../src/conversations/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-conversation-snapshot-api-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const conversationStore = new ConversationStore({ dataDirectory: directory });
  const id = "55555555-5555-4555-8555-555555555555";
  try {
    await withServer({ serviceToken: token, identityAuth, conversationStore }, async (base) => {
      const headersFor = (userId, method, requestPath) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign(userId, { method, path: requestPath }),
        "content-type": "application/json"
      });
      const snapshot = {
        activeConversationId: id,
        conversations: [{ id, title: "Migrated history", messages: [{ role: "user", content: "Old message" }] }]
      };
      const imported = await fetch(`${base}/v1/conversations/import`, {
        method: "POST",
        headers: headersFor("user-a", "POST", "/v1/conversations/import"),
        body: JSON.stringify({ database: snapshot })
      });
      assert.equal(imported.status, 200);
      assert.equal((await imported.json()).imported, true);

      const read = await fetch(`${base}/v1/conversations/database`, {
        headers: headersFor("user-a", "GET", "/v1/conversations/database")
      });
      assert.equal((await read.json()).database.conversations[0].title, "Migrated history");

      const denied = await fetch(`${base}/v1/conversations/database`, {
        headers: headersFor("user-b", "GET", "/v1/conversations/database")
      });
      assert.equal((await denied.json()).database.conversations.length, 0);

      const replacement = { activeConversationId: id, conversations: [{ id, title: "Saved by Core", messages: [] }] };
      const saved = await fetch(`${base}/v1/conversations/database`, {
        method: "PUT",
        headers: headersFor("user-a", "PUT", "/v1/conversations/database"),
        body: JSON.stringify({ database: replacement })
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).database.conversations[0].title, "Saved by Core");
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("conversation database endpoint imports legacy snapshots once and returns the Core-owned history", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ConversationStore } = await import("../src/conversations/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-conversation-import-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const conversationStore = new ConversationStore({ dataDirectory: directory });
  const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshot = {
    activeConversationId: conversationId,
    conversations: [{
      id: conversationId,
      title: "Imported Petrio history",
      messages: [
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "user", content: "Preserve this message" },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "assistant", content: "History now belongs to Core." }
      ]
    }]
  };
  try {
    await withServer({ serviceToken: token, identityAuth, conversationStore }, async (base) => {
      const headersFor = (method, requestPath) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign("user-a", { method, path: requestPath })
      });
      const imported = await fetch(`${base}/v1/conversations/import`, {
        method: "POST",
        headers: { ...headersFor("POST", "/v1/conversations/import"), "content-type": "application/json" },
        body: JSON.stringify({ database: snapshot })
      });
      assert.equal(imported.status, 200);
      assert.equal((await imported.json()).imported, true);

      const repeated = await fetch(`${base}/v1/conversations/import`, {
        method: "POST",
        headers: { ...headersFor("POST", "/v1/conversations/import"), "content-type": "application/json" },
        body: JSON.stringify({ database: { conversations: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Must not replace" }] } })
      });
      assert.equal((await repeated.json()).imported, false);

      const loaded = await fetch(`${base}/v1/conversations/database`, {
        headers: headersFor("GET", "/v1/conversations/database")
      });
      assert.equal(loaded.status, 200);
      const body = await loaded.json();
      assert.equal(body.database.activeConversationId, conversationId);
      assert.equal(body.database.conversations[0].title, "Imported Petrio history");
      assert.deepEqual(body.database.conversations[0].messages.map((message) => message.content), [
        "Preserve this message", "History now belongs to Core."
      ]);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("conversation snapshot API returns a structured conflict for stale revisions", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ConversationStore } = await import("../src/conversations/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-conversation-conflict-api-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const conversationStore = new ConversationStore({ dataDirectory: directory });
  const conversationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  try {
    await withServer({ serviceToken: token, identityAuth, conversationStore }, async (base) => {
      const headersFor = (method, requestPath) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign("user-a", { method, path: requestPath }),
        "content-type": "application/json"
      });
      await conversationStore.replaceDatabase("user-a", {
        activeConversationId: conversationId,
        conversations: [{ id: conversationId, title: "Shared", messages: [] }]
      });
      const stale = await conversationStore.database("user-a");
      await conversationStore.appendMessage("user-a", conversationId, {
        role: "user", content: "A newer message from another tab"
      });
      const response = await fetch(`${base}/v1/conversations/database`, {
        method: "PUT",
        headers: headersFor("PUT", "/v1/conversations/database"),
        body: JSON.stringify({
          expectedRevision: stale.revision,
          database: { activeConversationId: conversationId, conversations: [] }
        })
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "conversation_revision_conflict");
      assert.ok(body.revision > stale.revision);
      assert.equal((await conversationStore.get("user-a", conversationId)).messages[0].content, "A newer message from another tab");
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("audit history requires a signed identity and is isolated per user", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { AuditStore } = await import("../src/audit/store.mjs");
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-audit-api-"));
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const auditStore = new AuditStore({ dataDirectory: directory });
  try {
    await auditStore.record("user-a", {
      event: "tool.approval_completed", actor: "alfie", toolId: "memory.update",
      status: "completed", detail: "No private arguments"
    });
    await withServer({ serviceToken: token, identityAuth, auditStore }, async (base) => {
      const headersFor = (userId) => ({
        authorization: `Bearer ${token}`,
        ...identityAuth.sign(userId, { method: "GET", path: "/v1/audit" })
      });
      const denied = await fetch(`${base}/v1/audit`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(denied.status, 401);
      const own = await fetch(`${base}/v1/audit`, { headers: headersFor("user-a") });
      assert.equal(own.status, 200);
      assert.equal((await own.json()).events.length, 1);
      const other = await fetch(`${base}/v1/audit`, { headers: headersFor("user-b") });
      assert.deepEqual((await other.json()).events, []);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("Core registers scoped memory tools and keeps write tools approval-gated", async () => {
  const token = "service-token-".repeat(3);
  const { createPetrioIdentityAuth } = await import("../src/auth/petrioIdentity.mjs");
  const { PermissionStore } = await import("../src/permissions/store.mjs");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-core-memory-tools-api-"));
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const permissionStore = new PermissionStore({ dataDirectory: directory });
  try {
    await withServer({ serviceToken: token, identityAuth, permissionStore }, async (base) => {
      const response = await fetch(`${base}/v1/tools`, {
        headers: {
          authorization: `Bearer ${token}`,
          ...identityAuth.sign("user-a", { method: "GET", path: "/v1/tools" })
        }
      });
      assert.equal(response.status, 200);
      const tools = (await response.json()).tools;
      const memoryTools = tools.filter((tool) => tool.id.startsWith("memory."));
      assert.deepEqual(memoryTools.map((tool) => tool.id).sort(), [
        "memory.forget", "memory.get", "memory.remember", "memory.search", "memory.update"
      ]);
      assert.ok(memoryTools.filter((tool) => tool.risk === "write").every((tool) => tool.scope === "memory:write" && tool.requiresApproval));
      assert.ok(memoryTools.filter((tool) => tool.risk === "read").every((tool) => tool.scope === "memory:read"));
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
