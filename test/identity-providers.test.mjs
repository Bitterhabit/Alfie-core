import test from "node:test";
import assert from "node:assert/strict";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { createIdentityAuthRegistry, createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { IdentityLinkStore } from "../src/auth/identityLinkStore.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const secret = "test-only-identity-secret-with-at-least-32-bytes";

test("generic signed identity providers bind identity to method and path", () => {
  const auth = createSignedIdentityAuth({ secret, providerId: "standalone-ui", now: () => 1_800_000_000_000 });
  const options = { method: "GET", path: "/v1/whoami" };
  const headers = auth.sign("user-123", options);
  assert.equal(headers["x-alfie-identity-user-id"], "user-123");
  assert.deepEqual(auth.verify(headers, options), { userId: "user-123", providerId: "standalone-ui" });
  assert.throws(() => auth.verify(headers, { method: "POST", path: "/v1/whoami" }), { status: 401 });
  const putRequest = { method: "PUT", path: "/v1/conversations/database" };
  assert.deepEqual(auth.verify(auth.sign("user-123", putRequest), putRequest), { userId: "user-123", providerId: "standalone-ui" });
});

test("Petrio identity adapter retains its existing header contract", () => {
  const auth = createPetrioIdentityAuth({ secret, now: () => 1_800_000_000_000 });
  const options = { method: "POST", path: "/v1/conversations/database" };
  const headers = auth.sign("petrio-user-1", options);
  assert.equal(headers["x-petrio-user-id"], "petrio-user-1");
  assert.ok(headers["x-petrio-auth-signature"]);
  assert.deepEqual(auth.verify(headers, options), { userId: "petrio-user-1", providerId: "petrio" });
});

test("signed identity assertions cannot be replayed", () => {
  const auth = createSignedIdentityAuth({ secret, now: () => 1_800_000_000_000 });
  const options = { method: "GET", path: "/v1/whoami" };
  const headers = auth.sign("user-123", options);
  auth.verify(headers, options);
  assert.throws(() => auth.verify(headers, options), { status: 401 });
});


test("Core readiness and user identity do not require Petrio to be configured", async () => {
  const identityAuth = createSignedIdentityAuth({ secret, providerId: "standalone-ui" });
  const server = createAlfieCoreServer({
    serviceToken: "test-service-token-that-is-long-enough-32",
    identityAuth,
    petrioHarnessClient: { enabled: false }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    const ready = await fetch(baseUrl + "/ready");
    assert.equal(ready.status, 200);
    const options = { method: "GET", path: "/v1/whoami" };
    const response = await fetch(baseUrl + "/v1/whoami", {
      headers: {
        authorization: "Bearer test-service-token-that-is-long-enough-32",
        ...identityAuth.sign("standalone-user", options)
      }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true, userId: "standalone-user", identityProvider: "standalone-ui", linked: false
    });
    const blocked = await fetch(baseUrl + "/v1/conversations", {
      headers: {
        authorization: "Bearer test-service-token-that-is-long-enough-32",
        ...identityAuth.sign("standalone-user", { method: "GET", path: "/v1/conversations" })
      }
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "IDENTITY_LINK_REQUIRED");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("identity registry accepts Petrio and standalone clients at the same time", () => {
  const petrio = createPetrioIdentityAuth({ secret, now: () => 1_800_000_000_000 });
  const standalone = createSignedIdentityAuth({
    secret: "standalone-ui-identity-secret-that-is-different",
    providerId: "standalone-ui",
    now: () => 1_800_000_000_000
  });
  const registry = createIdentityAuthRegistry([petrio, standalone]);
  const request = { method: "GET", path: "/v1/whoami" };
  const petrioHeaders = petrio.sign("petrio-user", request);
  const standaloneHeaders = standalone.sign("standalone-user", request);
  assert.deepEqual(registry.verify(petrioHeaders, request), { userId: "petrio-user", providerId: "petrio" });
  assert.deepEqual(registry.verify(standaloneHeaders, request), { userId: "standalone-user", providerId: "standalone-ui" });
});

test("signed identity replay protection has a bounded cache and fails closed", () => {
  const auth = createSignedIdentityAuth({
    secret, providerId: "standalone-ui", maxReplayEntries: 1, now: () => 1_800_000_000_000
  });
  const options = { method: "GET", path: "/v1/whoami" };
  auth.verify(auth.sign("user-1", options), options);
  assert.throws(() => auth.verify(auth.sign("user-2", options), options), {
    status: 503, code: "IDENTITY_REPLAY_CACHE_FULL"
  });
});


test("standalone identity can provision its own isolated Core workspace without Petrio", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-standalone-identity-"));
  const identityAuth = createSignedIdentityAuth({ secret, providerId: "standalone-ui" });
  const identityLinkStore = new IdentityLinkStore({ dataDirectory: directory });
  const token = "test-service-token-that-is-long-enough-32";
  const server = createAlfieCoreServer({ serviceToken: token, identityAuth, identityLinkStore, petrioHarnessClient: { enabled: false } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (userId, method, requestPath, body) => fetch(base + requestPath, {
    method,
    headers: { authorization: "Bearer " + token, ...identityAuth.sign(userId, { method, path: requestPath }), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  try {
    const created = await call("local-user-1", "POST", "/v1/identity/standalone", {});
    assert.equal(created.status, 201);
    const workspace = await created.json();
    assert.equal(workspace.created, true);
    assert.equal(workspace.mode, "standalone");
    const who = await call("local-user-1", "GET", "/v1/whoami");
    assert.deepEqual(await who.json(), { authenticated: true, userId: workspace.userId, identityProvider: "standalone-ui", linked: true });
    const conversations = await call("local-user-1", "GET", "/v1/conversations");
    assert.equal(conversations.status, 200);
    const other = await call("local-user-2", "GET", "/v1/conversations");
    assert.equal(other.status, 403);
    assert.equal((await other.json()).code, "IDENTITY_LINK_REQUIRED");
    const repeated = await call("local-user-1", "POST", "/v1/identity/standalone", {});
    assert.equal((await repeated.json()).userId, workspace.userId);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
