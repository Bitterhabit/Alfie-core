import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InterfaceAuthStore } from "../src/auth/store.mjs";

async function withStore(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-auth-"));
  try { await run(new InterfaceAuthStore({ dataDirectory: directory, ...options }), directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

const password = "correct-horse-battery-staple-2026";

test("first-run bootstrap creates one private administrator and cannot overwrite it", async () => {
  await withStore(async (store, directory) => {
    assert.equal(await store.setupRequired(), true);
    const first = await store.bootstrap("alfie-admin", password);
    assert.equal(first.created, true);
    assert.equal(await store.setupRequired(), false);
    const second = await store.bootstrap("other-admin", "another-long-password-12345");
    assert.equal(second.created, false);
    const file = await fs.readFile(path.join(directory, "accounts.json"), "utf8");
    assert.equal(file.includes(password), false);
    assert.equal((await fs.stat(path.join(directory, "accounts.json"))).mode & 0o777, 0o600);
  });
});

test("login issues a hashed opaque session and CSRF token; logout revokes it", async () => {
  await withStore(async (store) => {
    await store.bootstrap("alfie-admin", password);
    const login = await store.login("alfie-admin", password, { ip: "127.0.0.1" });
    assert.ok(login.token.length >= 40);
    assert.ok(login.csrfToken.length >= 40);
    const session = await store.authenticate(login.token);
    assert.equal(session.user.username, "alfie-admin");
    assert.equal(session.csrfToken, login.csrfToken);
    await store.logout(login.token);
    assert.equal(await store.authenticate(login.token), null);
  });
});

test("invalid credentials and weak bootstrap passwords are rejected", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.bootstrap("ab", "short"), { status: 400 });
    await store.bootstrap("alfie-admin", password);
    await assert.rejects(store.login("alfie-admin", "incorrect-password"), { status: 401 });
    await assert.rejects(store.login("unknown-user", password), { status: 401 });
  });
});

test("idle sessions expire and cannot be refreshed after expiry", async () => {
  let now = 1_800_000_000_000;
  await withStore(async (store) => {
    await store.bootstrap("alfie-admin", password);
    const login = await store.login("alfie-admin", password);
    now += 31 * 60 * 1000;
    assert.equal(await store.authenticate(login.token), null);
  }, { now: () => now });
});
