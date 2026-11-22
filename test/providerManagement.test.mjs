import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  ProviderRegistry,
  validateProviderUrl,
  resolveAndValidateProviderTarget,
  redactProviderError
} from "../src/providers/registry.mjs";
import { ProviderStore } from "../src/providers/store.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { IdentityLinkStore } from "../src/auth/identityLinkStore.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { AuditStore } from "../src/audit/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { createAlfieInterfaceServer } from "../interface/src/server.mjs";
import { InterfaceAuthStore } from "../interface/src/auth/store.mjs";
import { readUserJsonDocument } from "../src/storage/userJsonStore.mjs";

function mockResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

async function withMockModelServers(run) {
  const receivedAuthHeaders = [];
  const ollamaServer = http.createServer((req, res) => {
    receivedAuthHeaders.push({ server: "ollama", auth: req.headers.authorization || null, url: req.url });
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "qwen2.5:14b" }, { name: "llama3.2:latest" }] }));
    }
    if (req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: { content: JSON.stringify({ type: "final", message: "Hello from persisted Ollama" }) } }));
    }
    res.writeHead(404);
    res.end();
  });

  const openaiServer = http.createServer((req, res) => {
    receivedAuthHeaders.push({ server: "openai", auth: req.headers.authorization || null, url: req.url });
    if (req.headers.authorization !== "Bearer super-secret-openai-key-999") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unauthorized for key super-secret-openai-key-999" } }));
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mistral-small" }, { id: "codestral" }] }));
    }
    res.writeHead(404);
    res.end();
  });

  await Promise.all([
    new Promise((resolve) => ollamaServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => openaiServer.listen(0, "127.0.0.1", resolve))
  ]);

  const ollamaUrl = `http://127.0.0.1:${ollamaServer.address().port}`;
  const openaiUrl = `http://127.0.0.1:${openaiServer.address().port}/v1`;
  try {
    await run({ ollamaUrl, openaiUrl, receivedAuthHeaders });
  } finally {
    await Promise.all([
      new Promise((resolve) => ollamaServer.close(resolve)),
      new Promise((resolve) => openaiServer.close(resolve))
    ]);
  }
}

test("provider URL validation enforces SSRF rules, metadata bans, and trustedLocal opt-in", async () => {
  // Invalid schemes, credentials, and fragments/queries
  assert.equal(validateProviderUrl("file:///etc/passwd", { trustedLocal: true }).valid, false);
  assert.equal(validateProviderUrl("http://user:pass@127.0.0.1:11434", { trustedLocal: true }).valid, false);
  assert.equal(validateProviderUrl("https://api.example.com/v1?foo=bar").valid, false);
  assert.equal(validateProviderUrl("https://api.example.com/v1#frag").valid, false);

  // Cloud metadata and link-local are ALWAYS blocked, even with trustedLocal: true
  for (const blocked of [
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal",
    "http://100.100.100.200",
    "http://[fe80::1]:8080",
    "http://[::ffff:169.254.169.254]",
    "http://0.0.0.0:11434",
    "http://224.0.0.1:11434"
  ]) {
    const res = validateProviderUrl(blocked, { trustedLocal: true });
    assert.equal(res.valid, false, `Expected ${blocked} to be blocked even with trustedLocal: true`);
    assert.equal(res.code, "PROVIDER_URL_BLOCKED");
  }

  // Local / private LAN requires explicit trustedLocal: true
  for (const localUrl of [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://192.168.1.50:11434",
    "http://ollama:11434"
  ]) {
    const denied = validateProviderUrl(localUrl, { trustedLocal: false });
    assert.equal(denied.valid, false, `Expected ${localUrl} to require trustedLocal`);
    assert.equal(denied.code, "PROVIDER_LOCAL_OPT_IN_REQUIRED");

    const allowed = validateProviderUrl(localUrl, { trustedLocal: true });
    assert.equal(allowed.valid, true, `Expected ${localUrl} to be allowed with trustedLocal: true`);
  }

  // DNS resolution checks reject rebinding to private/metadata IPs
  const dnsBlockedPrivate = await resolveAndValidateProviderTarget("https://rebind.example.com/v1", {
    trustedLocal: false,
    dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }]
  });
  assert.equal(dnsBlockedPrivate.valid, false);
  assert.equal(dnsBlockedPrivate.code, "PROVIDER_LOCAL_OPT_IN_REQUIRED");

  const dnsBlockedMetadata = await resolveAndValidateProviderTarget("http://local-alias.lan:11434", {
    trustedLocal: true,
    dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }]
  });
  assert.equal(dnsBlockedMetadata.valid, false);
  assert.equal(dnsBlockedMetadata.code, "PROVIDER_URL_BLOCKED");

  const dnsPublicOk = await resolveAndValidateProviderTarget("https://api.example.com/v1", {
    trustedLocal: false,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  assert.equal(dnsPublicOk.valid, true);
});

test("ProviderRegistry disables redirects and redacts secrets from error output", async () => {
  const seenOptions = [];
  const secret = "sk-very-private-token-abcdef123456";
  const registry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      seenOptions.push(options);
      return mockResponse({ error: { message: `Invalid key ${secret} with Bearer ${secret}` } }, 401);
    }
  });
  const result = await registry.inspect({
    id: "remote-1",
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    trustedLocal: false,
    model: "gpt-test",
    apiKey: secret
  });
  assert.equal(result.online, false);
  assert.equal(seenOptions[0].redirect, "error");
  assert.equal(result.error.includes(secret), false);
  assert.match(result.error, /\[redacted\]/);
  assert.equal(redactProviderError(`Leak Bearer ${secret}`, secret).includes(secret), false);
});

test("ProviderRegistry pins real HTTP requests to the exact DNS answers it validated", async () => {
  let dnsCalls = 0;
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    assert.equal(req.headers.host, `provider-rebind.test:${server.address().port}`);
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
    }
    if (req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: { content: "pinned response" } }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const registry = new ProviderRegistry({
    // A second DNS lookup would now resolve to the cloud metadata address.
    // The request must use the first, already-validated answer instead.
    dnsLookup: async () => {
      dnsCalls += 1;
      return dnsCalls === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    }
  });
  const endpoint = {
    id: "dns-pinned",
    provider: "ollama",
    baseUrl: `http://provider-rebind.test:${server.address().port}`,
    trustedLocal: true,
    model: "qwen3:8b",
    apiKey: ""
  };

  try {
    const health = await registry.inspect(endpoint);
    assert.equal(health.online, true);
    assert.deepEqual(health.models, ["qwen3:8b"]);
    assert.equal(dnsCalls, 1, "The socket must not perform a second DNS resolution after validation.");

    const chat = await registry.chat(endpoint, [{ role: "user", content: "hello" }]);
    assert.equal(chat.content, "pinned response");
    assert.equal(dnsCalls, 2, "Each request gets one fresh validation and uses that result for its socket.");
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ProviderStore encrypts API keys at rest, preserves env migration, and handles partial updates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-provider-store-"));
  const userId = "peter-v1";
  const secretKey = "unit-test-master-secret-key-for-provider-store";
  const apiKey = "sk-provider-secret-9876543210";

  try {
    const store = new ProviderStore({
      dataDirectory: dir,
      secretKey,
      fallbackConfig: {
        mode: "standard",
        endpoints: [
          { id: "env-ollama", name: "Env Ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:14b" }
        ]
      }
    });

    // Starts with environment defaults before any user save
    const initial = await store.getPublicState(userId);
    assert.equal(initial.source, "environment");
    assert.equal(initial.mode, "standard");
    assert.equal(initial.endpoints.length, 1);
    assert.equal(initial.endpoints[0].id, "env-ollama");
    assert.equal(initial.endpoints[0].trustedLocal, true);

    // Adding an endpoint persists encrypted credentials and keeps env endpoint migrated
    const added = await store.addEndpoint(userId, {
      name: "Studio OpenAI",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      trustedLocal: true,
      model: "mistral-small",
      priority: 85,
      apiKey
    });
    assert.equal(added.endpoint.apiKey, undefined);
    assert.equal(added.endpoint.apiKeyConfigured, true);
    assert.equal(added.config.source, "persisted");
    assert.equal(added.config.endpoints.length, 2);

    // Verify raw persisted document contains encrypted envelope and zero plaintext secret
    const rawDoc = await readUserJsonDocument(dir, userId, "providers.json");
    const serialized = JSON.stringify(rawDoc);
    assert.equal(serialized.includes(apiKey), false, "Plaintext API key must never be stored on disk");
    const rawEp = rawDoc.endpoints.find((ep) => ep.id === added.endpoint.id);
    assert.equal(rawEp.apiKeyEncrypted?.alg, "aes-256-gcm");

    // Effective config decrypts key server-side
    const effective = await store.getEffectiveConfig(userId);
    const hydrated = effective.config.endpoints.find((ep) => ep.id === added.endpoint.id);
    assert.equal(hydrated.apiKey, apiKey);

    // Partial update preserves existing key without re-submitting it
    const patched = await store.updateEndpoint(userId, added.endpoint.id, { model: "codestral", priority: 95 });
    assert.equal(patched.keyAction, "unchanged");
    assert.equal(patched.endpoint.apiKey, undefined);
    assert.equal(patched.endpoint.apiKeyConfigured, true);
    const afterPatch = (await store.getEffectiveConfig(userId)).config.endpoints.find((ep) => ep.id === added.endpoint.id);
    assert.equal(afterPatch.apiKey, apiKey);
    assert.equal(afterPatch.model, "codestral");

    // Explicit clearApiKey removes the secret
    const cleared = await store.updateEndpoint(userId, added.endpoint.id, { clearApiKey: true });
    assert.equal(cleared.keyAction, "cleared");
    assert.equal(cleared.endpoint.apiKeyConfigured, false);
    const afterClear = (await store.getEffectiveConfig(userId)).config.endpoints.find((ep) => ep.id === added.endpoint.id);
    assert.equal(afterClear.apiKey, "");

    // Strict boolean validation rejects string "false"
    await assert.rejects(
      store.updateEndpoint(userId, added.endpoint.id, { enabled: "false" }),
      { status: 400, code: "INVALID_PROVIDER_CONFIG" }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Core + Interface provider APIs enforce auth/CSRF, audit changes, route live chat, and preserve tool approvals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-v1-providers-e2e-"));
  const serviceToken = "service-token-v1-providers-".repeat(2);
  const identitySecret = "standalone-identity-secret-".repeat(2);
  const password = "v1-provider-setup-password-2026";

  await withMockModelServers(async ({ ollamaUrl, openaiUrl, receivedAuthHeaders }) => {
    const coreDir = path.join(dir, "core");
    const uiDir = path.join(dir, "ui");
    const identityAuth = createSignedIdentityAuth({ secret: identitySecret, providerId: "standalone-ui" });
    const memoryStore = new MemoryStore({ dataDirectory: coreDir });
    const auditStore = new AuditStore({ dataDirectory: coreDir });
    const permissionStore = new PermissionStore({ dataDirectory: coreDir });
    const pendingActionStore = new PendingActionStore({ dataDirectory: coreDir });
    const toolRegistry = new ToolRegistry();

    // Register a sample write tool requiring approval to verify provider changes never invalidate or bypass approvals
    toolRegistry.register({
      id: "demo.safe_write",
      name: "Demo Write",
      description: "Test write tool requiring user approval",
      scope: "demo:write",
      risk: "write",
      trust: "internal",
      network: false,
      externalAction: false,
      inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
      handler: async ({ note }) => ({ written: note }),
      verifyResult: async () => ({ verified: true, detail: "Verified write" })
    });

    const coreServer = createAlfieCoreServer({
      serviceToken,
      identityAuth,
      identityLinkStore: new IdentityLinkStore({ dataDirectory: coreDir }),
      memoryStore,
      auditStore,
      permissionStore,
      pendingActionStore,
      toolRegistry,
      providerConfig: { mode: "auto", endpoints: [] }
    });

    await new Promise((resolve) => coreServer.listen(0, "127.0.0.1", resolve));
    const coreUrl = `http://127.0.0.1:${coreServer.address().port}`;
    const coreClient = createAlfieCoreClient({ baseUrl: coreUrl, serviceToken, identityAuth });

    const authStore = new InterfaceAuthStore({ dataDirectory: uiDir });
    await authStore.bootstrap("peter-admin", password);

    const uiServer = createAlfieInterfaceServer({
      authStore,
      coreClient,
      cookieSecure: false,
      allowLocalHttpOrigin: true
    });
    await new Promise((resolve) => uiServer.listen(0, "127.0.0.1", resolve));
    const uiUrl = `http://127.0.0.1:${uiServer.address().port}`;

    try {
      // 1. Verify NO registered agent tool can touch provider configuration
      for (const tool of toolRegistry.tools.values()) {
        assert.doesNotMatch(tool.id, /provider|endpoint|llm/i, `Agent tool ${tool.id} must not manage provider config`);
      }

      // 2. Unauthenticated access to provider routes is rejected
      const unauthGet = await fetch(`${uiUrl}/api/core/providers`);
      assert.equal(unauthGet.status, 401);
      const unauthPost = await fetch(`${uiUrl}/api/core/providers/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: uiUrl },
        body: JSON.stringify({ name: "X", provider: "ollama", baseUrl: ollamaUrl, trustedLocal: true })
      });
      assert.equal(unauthPost.status, 401);

      // 3. Log in to standalone UI
      const loginRes = await fetch(`${uiUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: uiUrl },
        body: JSON.stringify({ username: "peter-admin", password })
      });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get("set-cookie").split(";")[0];
      const { csrfToken } = await loginRes.json();

      // 4. CSRF protection blocks mutations without CSRF token
      const noCsrfRes = await fetch(`${uiUrl}/api/core/providers/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: uiUrl },
        body: JSON.stringify({ name: "NoCSRF", provider: "ollama", baseUrl: ollamaUrl, trustedLocal: true })
      });
      assert.equal(noCsrfRes.status, 403);

      const authHeaders = {
        "content-type": "application/json",
        cookie,
        origin: uiUrl,
        "x-csrf-token": csrfToken
      };

      // 5. Ensure standalone account identity is linked
      const linkRes = await fetch(`${uiUrl}/api/auth/standalone`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({})
      });
      assert.equal(linkRes.status, 201);

      // 6. Test connection BEFORE saving (Ollama + OpenAI-compatible with API key)
      const blockedTest = await fetch(`${uiUrl}/api/core/providers/test`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ provider: "ollama", baseUrl: "http://169.254.169.254", trustedLocal: true })
      });
      assert.equal(blockedTest.status, 400);

      const ollamaTestRes = await fetch(`${uiUrl}/api/core/providers/test`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ provider: "ollama", baseUrl: ollamaUrl, trustedLocal: true })
      });
      assert.equal(ollamaTestRes.status, 200);
      const ollamaTest = await ollamaTestRes.json();
      assert.equal(ollamaTest.ok, true);
      assert.deepEqual(ollamaTest.models, ["qwen2.5:14b", "llama3.2:latest"]);

      // 7. Save Ollama endpoint and OpenAI-compatible endpoint with API key
      const addOllamaRes = await fetch(`${uiUrl}/api/core/providers/endpoints`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: "Local Ollama",
          provider: "ollama",
          baseUrl: ollamaUrl,
          trustedLocal: true,
          model: "qwen2.5:14b",
          mode: "standard",
          priority: 90
        })
      });
      assert.equal(addOllamaRes.status, 201);
      const addedOllama = await addOllamaRes.json();
      assert.equal(addedOllama.endpoint.model, "qwen2.5:14b");

      const addOpenAiRes = await fetch(`${uiUrl}/api/core/providers/endpoints`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: "Local vLLM",
          provider: "openai-compatible",
          baseUrl: openaiUrl,
          trustedLocal: true,
          model: "mistral-small",
          priority: 70,
          apiKey: "super-secret-openai-key-999"
        })
      });
      assert.equal(addOpenAiRes.status, 201);
      const addedOpenAi = await addOpenAiRes.json();
      assert.equal(addedOpenAi.endpoint.apiKey, undefined);
      assert.equal(addedOpenAi.endpoint.apiKeyConfigured, true);

      // 8. Test saved OpenAI-compatible endpoint by ID without resending API key (server hydrates encrypted secret)
      const savedTestRes = await fetch(`${uiUrl}/api/core/providers/test`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ id: addedOpenAi.endpoint.id })
      });
      assert.equal(savedTestRes.status, 200);
      const savedTest = await savedTestRes.json();
      assert.equal(savedTest.ok, true);
      assert.deepEqual(savedTest.models, ["mistral-small", "codestral"]);
      assert.ok(receivedAuthHeaders.some((h) => h.server === "openai" && h.auth === "Bearer super-secret-openai-key-999"));

      // 9. GET /api/core/providers never returns API key
      const listRes = await fetch(`${uiUrl}/api/core/providers`, { headers: { cookie } });
      const listJson = await listRes.json();
      assert.equal(JSON.stringify(listJson).includes("super-secret-openai-key-999"), false);
      assert.equal(listJson.endpoints.length, 2);

      // 10. Create a pending tool approval, then change routing mode & endpoint priority — approval remains intact and approvable!
      const whoRes = await fetch(`${uiUrl}/api/core/whoami`, { headers: { cookie } });
      const { userId } = await whoRes.json();
      await permissionStore.grant(userId, "demo:write");
      const { createHash } = await import("node:crypto");
      const { computeToolFingerprint } = await import("../src/agent/toolDispatcher.mjs");
      const demoArgs = { note: "still valid after provider change" };
      const pending = await pendingActionStore.create(userId, {
        toolId: "demo.safe_write",
        risk: "write",
        arguments: demoArgs,
        argumentsHash: createHash("sha256").update(JSON.stringify(["demo.safe_write", demoArgs])).digest("hex"),
        toolFingerprint: computeToolFingerprint(toolRegistry.tools.get("demo.safe_write")),
        preview: "Write demo note"
      });

      const routingRes = await fetch(`${uiUrl}/api/core/providers/settings`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ mode: "standard", healthIntervalSeconds: 20 })
      });
      assert.equal(routingRes.status, 200);
      assert.equal((await routingRes.json()).config.mode, "standard");

      const approveRes = await fetch(`${uiUrl}/api/core/tools/approve`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ actionId: pending.id })
      });
      assert.equal(approveRes.status, 200);
      const approveBody = await approveRes.json();
      assert.equal(approveBody.receipt.verified, true);
      assert.equal(approveBody.result.written, "still valid after provider change");

      // 11. Live chat immediately routes through the newly persisted Ollama endpoint
      const chatRes = await fetch(`${uiUrl}/api/core/agent/run`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ messages: [{ role: "user", content: "Say hello" }] })
      });
      assert.equal(chatRes.status, 200);
      const chatBody = await chatRes.json();
      assert.equal(chatBody.reply || chatBody.message, "Hello from persisted Ollama");
      assert.equal(chatBody.model || chatBody.routing?.model, "qwen2.5:14b");

      // 12. Audit log contains provider configuration events with zero secret leakage
      const auditRes = await fetch(`${uiUrl}/api/core/audit?limit=50`, { headers: { cookie } });
      const auditJson = await auditRes.json();
      const eventNames = (auditJson.events || []).map((e) => e.event);
      assert.ok(eventNames.includes("provider.endpoint_added"));
      assert.ok(eventNames.includes("provider.connection_tested"));
      assert.ok(eventNames.includes("provider.settings_updated"));
      assert.equal(JSON.stringify(auditJson).includes("super-secret-openai-key-999"), false);

      // 13. Delete endpoint cleanly
      const delRes = await fetch(`${uiUrl}/api/core/providers/endpoints/${encodeURIComponent(addedOpenAi.endpoint.id)}`, {
        method: "DELETE",
        headers: authHeaders
      });
      assert.equal(delRes.status, 200);
      assert.equal((await delRes.json()).config.endpoints.length, 1);
    } finally {
      await new Promise((resolve) => uiServer.close(resolve));
      await new Promise((resolve) => coreServer.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
