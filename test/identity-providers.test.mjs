import test from "node:test";
import assert from "node:assert/strict";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { createIdentityAuthRegistry, createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";

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
      authenticated: true, userId: "standalone-user", identityProvider: "standalone-ui"
    });
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
