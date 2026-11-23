import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAlfieCoreServer } from "../../src/server.mjs";
import { createAlfieCoreClient } from "../../src/client.mjs";
import { createPetrioIdentityAuth } from "../../src/auth/petrioIdentity.mjs";
import { createIdentityAuthRegistry, createSignedIdentityAuth } from "../../src/auth/signedIdentity.mjs";
import { IdentityLinkStore } from "../../src/auth/identityLinkStore.mjs";
import { ConversationStore } from "../../src/conversations/store.mjs";
import { ProjectStore } from "../../src/projects/store.mjs";
import { IdeaStore } from "../../src/ideas/store.mjs";
import { WatcherStore } from "../../src/watchers/store.mjs";
import { WorkflowProfileStore } from "../../src/profile/store.mjs";
import { ContextCapsuleStore } from "../../src/capsules/store.mjs";
import { MemoryStore } from "../../src/memory/store.mjs";
import { AuditStore } from "../../src/audit/store.mjs";
import { PermissionStore } from "../../src/permissions/store.mjs";
import { PendingActionStore } from "../../src/agent/pendingActionStore.mjs";
import { InterfaceAuthStore } from "../src/auth/store.mjs";
import { createAlfieInterfaceServer } from "../src/server.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
}

async function close(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("standalone interface links to Core and uses the same conversations and Garden data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-interface-core-e2e-"));
  const coreData = path.join(root, "core");
  const interfaceData = path.join(root, "interface");
  const serviceToken = "e2e-core-service-token-with-more-than-32-characters";
  const petrio = createPetrioIdentityAuth({ secret: "e2e-petrio-identity-secret-with-32-characters" });
  const standaloneSecret = "e2e-standalone-identity-secret-with-32-characters";
  const standaloneIdentity = createSignedIdentityAuth({ secret: standaloneSecret, providerId: "standalone-ui" });
  const identityAuth = createIdentityAuthRegistry([petrio, standaloneIdentity]);
  const core = createAlfieCoreServer({
    serviceToken,
    identityAuth,
    identityLinkStore: new IdentityLinkStore({ dataDirectory: coreData }),
    conversationStore: new ConversationStore({ dataDirectory: coreData }),
    memoryStore: new MemoryStore({ dataDirectory: coreData }),
    auditStore: new AuditStore({ dataDirectory: coreData }),
    permissionStore: new PermissionStore({ dataDirectory: coreData }),
    pendingActionStore: new PendingActionStore({ dataDirectory: coreData }),
    petrioHarnessClient: { enabled: false }
  });
  let ui;
  try {
    const coreUrl = await listen(core);
    const coreClient = createAlfieCoreClient({
      baseUrl: coreUrl,
      serviceToken,
      identityAuth: standaloneIdentity
    });
    const authStore = new InterfaceAuthStore({ dataDirectory: interfaceData });
    await authStore.bootstrap("alfie-admin", "integration-test-password-2026-strong");
    ui = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
    const uiUrl = await listen(ui);

    const loginResponse = await fetch(uiUrl + "/api/auth/login", {
      method: "POST",
      headers: { origin: uiUrl, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "integration-test-password-2026-strong" })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
    const login = await loginResponse.json();
    const headers = { origin: uiUrl, cookie, "content-type": "application/json", "x-csrf-token": login.csrfToken };

    const unlinked = await fetch(uiUrl + "/api/core/whoami", { headers: { cookie } });
    assert.equal(unlinked.status, 200);
    assert.equal((await unlinked.json()).linked, false);
    const blockedData = await fetch(uiUrl + "/api/core/conversations", { headers: { cookie } });
    assert.equal(blockedData.status, 403);
    assert.equal((await blockedData.json()).code, "IDENTITY_LINK_REQUIRED");

    const linkHeaders = {
      authorization: "Bearer " + serviceToken,
      ...petrio.sign("petrio-canonical-user", { method: "POST", path: "/v1/identity/link-codes" })
    };
    const codeResponse = await fetch(coreUrl + "/v1/identity/link-codes", { method: "POST", headers: linkHeaders });
    assert.equal(codeResponse.status, 201);
    const { code } = await codeResponse.json();

    const linkResponse = await fetch(uiUrl + "/api/auth/link", {
      method: "POST", headers,
      body: JSON.stringify({ code })
    });
    assert.equal(linkResponse.status, 200);
    assert.deepEqual(await linkResponse.json(), { linked: true });

    const who = await fetch(uiUrl + "/api/core/whoami", { headers: { cookie } });
    assert.deepEqual(await who.json(), {
      authenticated: true, userId: "petrio-canonical-user", identityProvider: "standalone-ui", linked: true
    });

    const createdConversation = await fetch(uiUrl + "/api/core/conversations", {
      method: "POST", headers, body: JSON.stringify({ title: "Shared history" })
    });
    assert.equal(createdConversation.status, 201);
    const conversation = (await createdConversation.json()).conversation;
    const history = await fetch(uiUrl + "/api/core/conversations", { headers: { cookie } });
    assert.equal((await history.json()).conversations[0].title, "Shared history");

    const appended = await fetch(uiUrl + "/api/core/conversations/" + conversation.id + "/messages", {
      method: "POST", headers, body: JSON.stringify({ role: "user", content: "Hello Alfie" })
    });
    assert.equal(appended.status, 201);
    const loaded = await fetch(uiUrl + "/api/core/conversations/" + conversation.id, { headers: { cookie } });
    assert.equal((await loaded.json()).conversation.messages[0].content, "Hello Alfie");

    const planted = await fetch(uiUrl + "/api/core/memories", {
      method: "POST", headers,
      body: JSON.stringify({ text: "The interface and Petrio share one Garden.", origin: "user-seeded", source: "user", type: "note" })
    });
    assert.equal(planted.status, 201);
    const memory = (await planted.json()).memory;
    const garden = await fetch(uiUrl + "/api/core/memories?q=share", { headers: { cookie } });
    assert.equal((await garden.json()).memories[0].id, memory.id);
    const updated = await fetch(uiUrl + "/api/core/memories/" + memory.id, {
      method: "PATCH", headers, body: JSON.stringify({ text: "The interface and Petrio share one canonical Garden.", importance: 8 })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).memory.importance, 8);
  } finally {
    await close(ui);
    await close(core);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workshop delegation returns immediately and completes in the background worker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-workshop-worker-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serviceToken = "workshop-worker-service-token-with-more-than-32-characters";
  const identityAuth = createPetrioIdentityAuth({ secret: "workshop-worker-identity-secret-with-more-than-32-characters" });
  const stores = {
    memoryStore: new MemoryStore({ dataDirectory: root }),
    projectStore: new ProjectStore({ dataDirectory: root }),
    ideaStore: new IdeaStore({ dataDirectory: root }),
    watcherStore: new WatcherStore({ dataDirectory: root }),
    profileStore: new WorkflowProfileStore({ dataDirectory: root }),
    capsuleStore: new ContextCapsuleStore({ dataDirectory: root }),
    permissionStore: new PermissionStore({ dataDirectory: root }),
    auditStore: new AuditStore({ dataDirectory: root })
  };
  const core = createAlfieCoreServer({ serviceToken, identityAuth, ...stores, petrioHarnessClient: { enabled: false } });
  try {
    const base = await listen(core);
    const submitPath = "/v1/workshop/delegate";
    const submit = await fetch(base + submitPath, {
      method: "POST",
      headers: { authorization: "Bearer " + serviceToken, "content-type": "application/json", ...identityAuth.sign("worker-user", { method: "POST", path: submitPath }) },
      body: JSON.stringify({ role: "auditor", objective: "Check the current workspace state" })
    });
    assert.equal(submit.status, 202);
    const { job } = await submit.json();
    assert.ok(job.id);
    assert.ok(["queued", "running", "completed"].includes(job.status));

    const jobPath = "/v1/jobs/" + job.id;
    let result = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await fetch(base + jobPath, {
        headers: { authorization: "Bearer " + serviceToken, ...identityAuth.sign("worker-user", { method: "GET", path: jobPath }) }
      });
      assert.equal(response.status, 200);
      result = (await response.json()).job;
      if (["completed", "failed", "interrupted"].includes(result.status)) break;
    }
    assert.equal(result.status, "completed", result.error || "Workshop job did not complete.");
    assert.equal(result.progress, 100);
    assert.ok(result.artifact?.summary);
  } finally {
    await close(core);
  }
});

test("background chat tasks survive the submit request and attach one result to the original conversation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-background-chat-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serviceToken = "background-chat-service-token-with-more-than-32-characters";
  const identityAuth = createPetrioIdentityAuth({ secret: "background-chat-identity-secret-with-more-than-32-characters" });
  const conversationStore = new ConversationStore({ dataDirectory: root });
  const conversation = await conversationStore.create("chat-task-user", "Background HTML task");
  const providerConfig = { mode: "auto", endpoints: [{ id: "test-local", name: "Test local", provider: "ollama", baseUrl: "http://localhost:11434", model: "test-model", enabled: true, trustedLocal: true }] };
  const stores = {
    conversationStore,
    memoryStore: new MemoryStore({ dataDirectory: root }),
    projectStore: new ProjectStore({ dataDirectory: root }),
    ideaStore: new IdeaStore({ dataDirectory: root }),
    watcherStore: new WatcherStore({ dataDirectory: root }),
    profileStore: new WorkflowProfileStore({ dataDirectory: root }),
    capsuleStore: new ContextCapsuleStore({ dataDirectory: root }),
    permissionStore: new PermissionStore({ dataDirectory: root }),
    auditStore: new AuditStore({ dataDirectory: root })
  };
  const providerRegistry = { complete: async () => ({ result: { content: JSON.stringify({ type: "final", message: "The HTML page is ready." }) }, endpoint: { model: "test-model", provider: "ollama" } }) };
  const providerStore = { getEffectiveConfig: async () => ({ config: providerConfig }) };
  const core = createAlfieCoreServer({ serviceToken, identityAuth, providerConfig, providerRegistry, providerStore, ...stores, petrioHarnessClient: { enabled: false } });
  try {
    const base = await listen(core);
    const turnId = "44444444-4444-4444-8444-444444444444";
    const submitPath = "/v1/chat/tasks";
    const body = { conversationId: conversation.id, turnId, messages: [{ role: "user", content: "Create a simple HTML page" }], mode: "work", workingMode: "engineer", agentProvider: "local" };
    const submit = await fetch(base + submitPath, {
      method: "POST",
      headers: { authorization: "Bearer " + serviceToken, "content-type": "application/json", ...identityAuth.sign("chat-task-user", { method: "POST", path: submitPath }) },
      body: JSON.stringify(body)
    });
    assert.equal(submit.status, 202);
    const { job } = await submit.json();
    assert.equal(job.kind, "chat_turn");
    assert.equal(job.conversationId, conversation.id);
    assert.equal(Object.hasOwn(job, "payload"), false);
    let current = job;
    for (let attempt = 0; attempt < 100 && !["completed", "failed", "interrupted"].includes(current.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await (await fetch(base + "/v1/jobs/" + job.id, { headers: { authorization: "Bearer " + serviceToken, ...identityAuth.sign("chat-task-user", { method: "GET", path: "/v1/jobs/" + job.id }) } })).json().then((payload) => payload.job);
    }
    assert.equal(current.status, "completed", current.error || "Background chat did not complete.");
    assert.equal(Object.hasOwn(current, "payload"), false);
    const saved = await conversationStore.get("chat-task-user", conversation.id);
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[0].taskId, turnId);
    assert.equal(saved.messages[1].taskId, job.id);
    assert.equal(saved.messages[1].content, "The HTML page is ready.");
    const duplicate = await fetch(base + submitPath, {
      method: "POST",
      headers: { authorization: "Bearer " + serviceToken, "content-type": "application/json", ...identityAuth.sign("chat-task-user", { method: "POST", path: submitPath }) },
      body: JSON.stringify(body)
    });
    assert.equal((await duplicate.json()).job.id, job.id);
    assert.equal((await conversationStore.get("chat-task-user", conversation.id)).messages.length, 2);
  } finally {
    await close(core);
  }
});
