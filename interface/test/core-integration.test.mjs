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
    assert.equal(unlinked.status, 403);
    assert.equal((await unlinked.json()).code, "IDENTITY_LINK_REQUIRED");

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
      method: "PATCH", headers, body: JSON.stringify({ text: "The interface and Petrio share one canonical Garden." })
    });
    assert.equal(updated.status, 200);
  } finally {
    await close(ui);
    await close(core);
    await fs.rm(root, { recursive: true, force: true });
  }
});
