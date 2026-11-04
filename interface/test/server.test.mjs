import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InterfaceAuthStore } from "../src/auth/store.mjs";
import { createAlfieInterfaceServer } from "../src/server.mjs";

test("interface login requires CSRF and links the authenticated local account", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-server-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const coreCalls = [];
  const coreClient = {
    linkIdentity: async (userId, code) => { coreCalls.push([userId, code]); return { linked: true }; },
    whoami: async () => ({ authenticated: true, userId: "canonical-user", identityProvider: "standalone-ui", linked: true })
  };
  const server = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await login.json();
    const blocked = await fetch(base + "/api/auth/link", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "23456789AB" })
    });
    assert.equal(blocked.status, 403);
    const linked = await fetch(base + "/api/auth/link", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ code: "23456789AB" })
    });
    assert.deepEqual(await linked.json(), { linked: true });
    assert.equal(coreCalls[0][1], "23456789AB");
    const who = await fetch(base + "/api/core/whoami", { headers: { cookie } });
    assert.equal((await who.json()).linked, true);
    const logout = await fetch(base + "/api/auth/logout", {
      method: "POST", headers: { origin: base, cookie, "x-csrf-token": session.csrfToken }
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(base + "/api/auth/me", { headers: { cookie } });
    assert.equal((await afterLogout.json()).authenticated, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
