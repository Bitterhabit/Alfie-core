import test from "node:test";
import assert from "node:assert/strict";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";

test("signs and verifies a Petrio user identity", () => {
  const auth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3), now: () => 1_800_000_000_000 });
  const headers = auth.sign("petrio-user-123", { method: "GET", path: "/v1/whoami" });
  assert.equal(auth.verify(headers, { method: "GET", path: "/v1/whoami" }).userId, "petrio-user-123");
});

test("rejects unsigned, tampered and replayed identity assertions", () => {
  const auth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3), now: () => 1_800_000_000_000 });
  assert.throws(() => auth.verify({}), { status: 401 });
  const headers = auth.sign("user-1", { method: "GET", path: "/v1/whoami" });
  assert.throws(() => auth.verify({ ...headers, "x-petrio-user-id": "user-2" }, { method: "GET", path: "/v1/whoami" }), { status: 401 });
  assert.throws(() => auth.verify(headers, { method: "POST", path: "/v1/whoami" }), { status: 401 });
  assert.equal(auth.verify(headers, { method: "GET", path: "/v1/whoami" }).userId, "user-1");
  assert.throws(() => auth.verify(headers, { method: "GET", path: "/v1/whoami" }), { status: 401 });
});

test("rejects expired assertions and weak secrets", () => {
  let now = 1_800_000_000_000;
  const auth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3), now: () => now });
  const headers = auth.sign("user-1", { method: "GET", path: "/v1/whoami" });
  now += 120_000;
  assert.throws(() => auth.verify(headers, { method: "GET", path: "/v1/whoami" }), { status: 401 });
  const unconfigured = createPetrioIdentityAuth({ secret: "short" });
  assert.equal(unconfigured.configured, false);
  assert.throws(() => unconfigured.sign("user-1"));
});

test("does not accept malformed user identifiers", () => {
  const auth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  assert.throws(() => auth.sign("../other-user"), TypeError);
});
