import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { IdentityReplayStore } from "../src/auth/identityReplayStore.mjs";

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alfie-identity-replay-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "identity-replay.sqlite");
}


test("replay storage enforces private directory and database permissions", (t) => {
  const databasePath = temporaryDatabase(t);
  const store = new IdentityReplayStore({ filePath: databasePath });
  t.after(() => store.close());
  const directoryMode = fs.statSync(path.dirname(databasePath)).mode & 0o777;
  const databaseMode = fs.statSync(databasePath).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(databaseMode, 0o600);
});

test("identity assertion replay protection survives verifier recreation", (t) => {
  const databasePath = temporaryDatabase(t);
  const now = () => 1_800_000_000_000;
  const options = { secret: "identity-secret-".repeat(3), now, replayDatabasePath: databasePath };
  const first = createSignedIdentityAuth(options);
  const headers = first.sign("user-1", { method: "GET", path: "/v1/whoami" });
  assert.equal(first.verify(headers, { method: "GET", path: "/v1/whoami" }).userId, "user-1");

  const afterRestart = createSignedIdentityAuth(options);
  assert.throws(
    () => afterRestart.verify(headers, { method: "GET", path: "/v1/whoami" }),
    { status: 401 }
  );
});

test("separate replay-store connections atomically reject the same nonce", (t) => {
  const databasePath = temporaryDatabase(t);
  const first = new IdentityReplayStore({ filePath: databasePath });
  const second = new IdentityReplayStore({ filePath: databasePath });
  t.after(() => { first.close(); second.close(); });
  const record = {
    providerId: "petrio",
    userId: "user-1",
    nonce: "nonce-value-that-is-long-enough",
    expiresAt: 1_800_000_060,
    now: 1_800_000_000,
    maxEntries: 100
  };
  assert.equal(first.consume(record), true);
  assert.equal(second.consume(record), false);
});

test("expired nonce rows are pruned and replay capacity fails closed", (t) => {
  const store = new IdentityReplayStore({ filePath: temporaryDatabase(t) });
  t.after(() => store.close());
  const base = { providerId: "petrio", userId: "user-1", now: 100, maxEntries: 1 };
  assert.equal(store.consume({ ...base, nonce: "first-nonce-value-1234", expiresAt: 101 }), true);
  assert.throws(
    () => store.consume({ ...base, nonce: "second-nonce-value-1234", expiresAt: 102 }),
    { status: 503, code: "IDENTITY_REPLAY_CACHE_FULL" }
  );
  assert.equal(store.consume({ ...base, now: 101, nonce: "second-nonce-value-1234", expiresAt: 102 }), true);
});
