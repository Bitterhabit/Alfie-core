import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createIdentityAuthRegistry, createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { IdentityLinkStore } from "../src/auth/identityLinkStore.mjs";
import { ConversationStore } from "../src/conversations/store.mjs";

test("Petrio-issued one-time link joins standalone interface to the same Core user data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-identity-link-api-"));
  const serviceToken = "identity-link-service-token-with-32-chars";
  const petrio = createPetrioIdentityAuth({ secret: "petrio-identity-secret-with-at-least-32-bytes" });
  const standalone = createSignedIdentityAuth({
    secret: "standalone-identity-secret-with-at-least-32-bytes",
    providerId: "standalone-ui"
  });
  const identityAuth = createIdentityAuthRegistry([petrio, standalone]);
  const identityLinkStore = new IdentityLinkStore({ dataDirectory: directory });
  const conversationStore = new ConversationStore({ dataDirectory: directory });
  const server = createAlfieCoreServer({
    serviceToken, identityAuth, identityLinkStore, conversationStore,
    petrioHarnessClient: { enabled: false }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const headersFor = (auth, userId, method, requestPath) => ({
    authorization: "Bearer " + serviceToken,
    ...auth.sign(userId, { method, path: requestPath })
  });
  try {
    const codeResponse = await fetch(base + "/v1/identity/link-codes", {
      method: "POST",
      headers: headersFor(petrio, "petrio-canonical-user", "POST", "/v1/identity/link-codes")
    });
    assert.equal(codeResponse.status, 201);
    const { code } = await codeResponse.json();
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/);

    const unlinkedAccess = await fetch(base + "/v1/conversations", {
      headers: headersFor(standalone, "standalone-local-user", "GET", "/v1/conversations")
    });
    assert.equal(unlinkedAccess.status, 403);

    const linked = await fetch(base + "/v1/identity/link", {
      method: "POST",
      headers: { ...headersFor(standalone, "standalone-local-user", "POST", "/v1/identity/link"), "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    assert.equal(linked.status, 200);
    assert.deepEqual(await linked.json(), { linked: true });

    const whoami = await fetch(base + "/v1/whoami", {
      headers: headersFor(standalone, "standalone-local-user", "GET", "/v1/whoami")
    });
    assert.deepEqual(await whoami.json(), {
      authenticated: true, userId: "petrio-canonical-user", identityProvider: "standalone-ui", linked: true
    });

    const created = await fetch(base + "/v1/conversations", {
      method: "POST",
      headers: { ...headersFor(petrio, "petrio-canonical-user", "POST", "/v1/conversations"), "content-type": "application/json" },
      body: JSON.stringify({ title: "Shared Alfie history" })
    });
    assert.equal(created.status, 201);
    const standaloneHistory = await fetch(base + "/v1/conversations", {
      headers: headersFor(standalone, "standalone-local-user", "GET", "/v1/conversations")
    });
    assert.equal((await standaloneHistory.json()).conversations[0].title, "Shared Alfie history");

    const unlinked = await fetch(base + "/v1/identity/unlink", {
      method: "POST",
      headers: headersFor(standalone, "standalone-local-user", "POST", "/v1/identity/unlink")
    });
    assert.deepEqual(await unlinked.json(), { unlinked: true });
    const accessAfterUnlink = await fetch(base + "/v1/conversations", {
      headers: headersFor(standalone, "standalone-local-user", "GET", "/v1/conversations")
    });
    assert.equal(accessAfterUnlink.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
