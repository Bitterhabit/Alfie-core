import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PeerTokenStore } from "../src/clients/tokenStore.mjs";

test("expired peer tokens no longer consume the active-token limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "alfie-peer-token-expiry-"));
  let now = "2026-11-22T12:00:00.000Z";
  const store = new PeerTokenStore({ dataDirectory: directory, now: () => now });

  try {
    const expiredTokens = [];
    for (let index = 0; index < 25; index += 1) {
      const minted = await store.create("user-peer-expiry", {
        name: `Temporary client ${index + 1}`,
        scopes: ["status:read"],
        expiresInDays: 1
      });
      expiredTokens.push(minted.token);
    }

    await assert.rejects(
      () => store.create("user-peer-expiry", { name: "Too many active", scopes: ["status:read"] }),
      (error) => error.status === 400
    );

    now = "2026-11-24T12:00:00.000Z";
    const replacement = await store.create("user-peer-expiry", {
      name: "Replacement client",
      scopes: ["status:read"],
      expiresInDays: 30
    });

    assert.equal(await store.authenticate(expiredTokens[0], "status:read"), null);
    assert.equal((await store.authenticate(replacement.token, "status:read")).name, "Replacement client");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("peer tokens with malformed expiry timestamps fail closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "alfie-peer-token-invalid-expiry-"));
  const store = new PeerTokenStore({ dataDirectory: directory });

  try {
    const minted = await store.create("user-peer-invalid-expiry", {
      name: "Corrupted expiry client",
      scopes: ["status:read"],
      expiresInDays: 30
    });
    const document = await store.load("user-peer-invalid-expiry");
    document.tokens[0].expiresAt = "not-a-valid-date";
    await store.save("user-peer-invalid-expiry", document);

    assert.equal(await store.authenticate(minted.token, "status:read"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
