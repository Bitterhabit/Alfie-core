import test from "node:test";
import assert from "node:assert/strict";
import { createAlfieCoreClient } from "../src/client.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";

const serviceToken = "test-service-token-with-at-least-32-characters";
const identityAuth = () => createSignedIdentityAuth({
  secret: "standalone-client-secret-with-at-least-32-characters",
  providerId: "standalone-ui"
});

test("generic Node client signs user identity and keeps service credentials server-side", async () => {
  let captured;
  const auth = identityAuth();
  const client = createAlfieCoreClient({
    baseUrl: "http://alfie-core:8780",
    serviceToken,
    identityAuth: auth,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ authenticated: true, userId: "user-1", identityProvider: "standalone-ui" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  });
  const result = await client.whoami("user-1");
  assert.equal(result.userId, "user-1");
  assert.equal(captured.url, "http://alfie-core:8780/v1/whoami");
  assert.equal(captured.options.headers.authorization, "Bearer " + serviceToken);
  assert.equal(captured.options.redirect, "error");
  assert.deepEqual(auth.verify(captured.options.headers, { method: "GET", path: "/v1/whoami" }), {
    userId: "user-1", providerId: "standalone-ui"
  });
});

test("generic Node client preserves Core conflict metadata", async () => {
  const client = createAlfieCoreClient({
    serviceToken,
    identityAuth: identityAuth(),
    fetchImpl: async () => new Response(JSON.stringify({
      error: "Conversation history changed.", code: "conversation_revision_conflict", revision: 9
    }), { status: 409, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(client.saveConversationsDatabase("user-1", { conversations: [] }, 8), {
    status: 409, code: "conversation_revision_conflict", revision: 9
  });
});

test("generic Node client refuses unversioned or cross-origin routes", async () => {
  assert.throws(() => createAlfieCoreClient({
    baseUrl: "http://alfie-core:8780/untrusted-prefix", serviceToken, identityAuth: identityAuth()
  }), { status: 503 });
  const client = createAlfieCoreClient({ serviceToken, identityAuth: identityAuth(), fetchImpl: async () => new Response("{}") });
  await assert.rejects(client.request("user-1", "/admin"), TypeError);
  await assert.rejects(client.request("user-1", "/v1/../../admin"), TypeError);
  await assert.rejects(client.request("user-1", "/v1/whoami#fragment"), TypeError);
});
