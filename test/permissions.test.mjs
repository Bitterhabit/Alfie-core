import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionStore } from "../src/permissions/store.mjs";

test("persists permission grants per user and supports revocation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-permissions-"));
  try {
    const store = new PermissionStore({ dataDirectory: directory });
    assert.deepEqual(await store.list("user-1"), []);
    assert.deepEqual(await store.grant("user-1", "calendar:read"), ["calendar:read"]);
    assert.deepEqual(await store.grant("user-1", "calendar:write"), ["calendar:read", "calendar:write"]);
    assert.deepEqual(await store.list("user-2"), []);
    assert.deepEqual(await store.revoke("user-1", "calendar:read"), ["calendar:write"]);
    const stat = await fs.stat(store.fileFor("user-1"));
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed permission scopes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-permissions-"));
  try {
    const store = new PermissionStore({ dataDirectory: directory });
    await assert.rejects(store.grant("user-1", "Calendar Read"), { status: 400 });
    await assert.rejects(store.revoke("user-1", "bad/scope"), { status: 400 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
