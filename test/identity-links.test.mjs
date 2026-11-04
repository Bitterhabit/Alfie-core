import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdentityLinkStore } from "../src/auth/identityLinkStore.mjs";

async function withStore(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-identity-links-"));
  try { await run(new IdentityLinkStore({ dataDirectory: directory, ...options }), directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("one-time link code maps standalone subject to canonical Petrio user", async () => {
  await withStore(async (store) => {
    const created = await store.createCode("petrio-user-123");
    assert.match(created.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/);
    assert.equal(await store.resolve("standalone-ui", "local-account-1"), null);
    assert.deepEqual(await store.consumeCode("standalone-ui", "local-account-1", created.code), { linked: true });
    assert.equal(await store.resolve("standalone-ui", "local-account-1"), "petrio-user-123");
    await assert.rejects(store.consumeCode("standalone-ui", "local-account-2", created.code), { status: 404, code: "IDENTITY_LINK_CODE_INVALID" });
  });
});

test("identity link codes are single-use and one standalone account can link only once", async () => {
  await withStore(async (store) => {
    const first = await store.createCode("petrio-user-123");
    await store.consumeCode("standalone-ui", "local-account-1", first.code);
    const second = await store.createCode("another-petrio-user");
    await assert.rejects(store.consumeCode("standalone-ui", "local-account-1", second.code), { status: 409, code: "IDENTITY_ALREADY_LINKED" });
  });
});

test("invalid link codes are rate limited per standalone subject", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(store.consumeCode("standalone-ui", "local-account-1", "23456789AB"), { status: 404 });
    }
    await assert.rejects(store.consumeCode("standalone-ui", "local-account-1", "23456789AB"), { status: 429, code: "IDENTITY_LINK_RATE_LIMITED" });
  });
});

test("link codes expire and are stored as hashes with restrictive permissions", async () => {
  let now = 1_800_000_000_000;
  await withStore(async (store, directory) => {
    const created = await store.createCode("petrio-user-123", { ttlMs: 30_000 });
    const stat = await fs.stat(path.join(directory, "identity-links.json"));
    assert.equal(stat.mode & 0o777, 0o600);
    const raw = await fs.readFile(path.join(directory, "identity-links.json"), "utf8");
    assert.equal(raw.includes(created.code), false);
    now += 31_000;
    await assert.rejects(store.consumeCode("standalone-ui", "local-account-1", created.code), { status: 404 });
  }, { now: () => now });
});
