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


test("login throttling is bounded to the socket peer unless proxy headers are trusted", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-throttle-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const server = createAlfieInterfaceServer({ authStore, cookieSecure: false, trustProxyHeaders: false, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { origin: base, "content-type": "application/json", "cf-connecting-ip": "198.51.100." + (i + 1) },
        body: JSON.stringify({ username: "alfie-admin", password: "incorrect-password-123456" })
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", "cf-connecting-ip": "203.0.113.99" },
      body: JSON.stringify({ username: "alfie-admin", password: "incorrect-password-123456" })
    });
    assert.equal(limited.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("password endpoint requires CSRF, rotates credentials and clears the session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-password-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  const currentPassword = "test-password-for-ci-only-123456";
  const nextPassword = "new-password-for-ci-only-654321";
  await authStore.bootstrap("alfie-admin", currentPassword);
  const server = createAlfieInterfaceServer({ authStore, cookieSecure: false, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: currentPassword })
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await login.json();
    const blocked = await fetch(base + "/api/auth/password", {
      method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword: nextPassword })
    });
    assert.equal(blocked.status, 403);
    const changed = await fetch(base + "/api/auth/password", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ currentPassword, newPassword: nextPassword })
    });
    assert.deepEqual(await changed.json(), { changed: true });
    assert.equal(changed.headers.get("set-cookie").includes("Max-Age=0"), true);
    const stale = await fetch(base + "/api/auth/me", { headers: { cookie } });
    assert.equal((await stale.json()).authenticated, false);
    const oldLogin = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: currentPassword })
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: nextPassword })
    });
    assert.equal(newLogin.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("password change requires CSRF, revokes the session and accepts the new password", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-password-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  const currentPassword = "current-interface-password-2026";
  const newPassword = "new-interface-password-rotated-2026";
  await authStore.bootstrap("alfie-admin", currentPassword);
  const server = createAlfieInterfaceServer({ authStore, cookieSecure: false, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const loginResponse = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: currentPassword })
    });
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
    const login = await loginResponse.json();
    const blocked = await fetch(base + "/api/auth/password", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    assert.equal(blocked.status, 403);

    const changed = await fetch(base + "/api/auth/password", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": login.csrfToken },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    assert.deepEqual(await changed.json(), { changed: true });
    assert.match(changed.headers.get("set-cookie"), /Max-Age=0/);
    const oldSession = await fetch(base + "/api/auth/me", { headers: { cookie } });
    assert.equal((await oldSession.json()).authenticated, false);

    const newLogin = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: newPassword })
    });
    assert.equal(newLogin.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("standalone workspace setup requires CSRF and provisions an independent Core identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-standalone-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const calls = [];
  const coreClient = { createStandaloneWorkspace: async (userId) => { calls.push(userId); return { created: true, linked: true, mode: "standalone", userId: "core-" + userId }; } };
  const server = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await login.json();
    const blocked = await fetch(base + "/api/auth/standalone", {
      method: "POST", headers: { origin: base, cookie, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(blocked.status, 403);
    const created = await fetch(base + "/api/auth/standalone", {
      method: "POST", headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: "{}"
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).mode, "standalone");
    assert.deepEqual(calls, [session.user.id]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("generated image route requires authentication and uses private caching", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-images-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const coreClient = {
    getImage: async (name) => ({ buffer: Buffer.from(`png:${name}`), mimeType: "image/png" })
  };
  const server = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const unauth = await fetch(base + "/api/core/images/sprite-1.png");
    assert.equal(unauth.status, 401);

    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const authed = await fetch(base + "/api/core/images/sprite-1.png", { headers: { cookie } });
    assert.equal(authed.status, 200);
    assert.equal(authed.headers.get("content-type"), "image/png");
    assert.match(authed.headers.get("cache-control"), /^private,/);
    assert.equal(await authed.text(), "png:sprite-1.png");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("interface defaults enforce Secure SameSite=Strict cookies, strict security headers, and hardened origin validation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-hardening-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const prevSecure = process.env.ALFIE_UI_COOKIE_SECURE;
  const prevIframe = process.env.ALFIE_UI_ALLOW_IFRAME;
  const prevOrigin = process.env.ALFIE_UI_PUBLIC_ORIGIN;
  delete process.env.ALFIE_UI_COOKIE_SECURE;
  delete process.env.ALFIE_UI_ALLOW_IFRAME;
  delete process.env.ALFIE_UI_PUBLIC_ORIGIN;

  const server = createAlfieInterfaceServer({ authStore, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  try {
    const health = await fetch(base + "/health");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert.equal(health.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(health.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(health.headers.get("x-permitted-cross-domain-policies"), "none");
    const csp = health.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'none'/);

    // HTTP origin rejected when cookieSecure defaults to true
    const httpRejected = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(httpRejected.status, 403);

    // Spoofed x-forwarded-host rejected when trustProxyHeaders is false
    const spoofedProxy = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(spoofedProxy.status, 403);

    // Matching HTTPS host succeeds and emits Secure + SameSite=Strict
    const httpsLogin = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: `https://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(httpsLogin.status, 200);
    const setCookie = httpsLogin.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
  } finally {
    if (prevSecure !== undefined) process.env.ALFIE_UI_COOKIE_SECURE = prevSecure;
    if (prevIframe !== undefined) process.env.ALFIE_UI_ALLOW_IFRAME = prevIframe;
    if (prevOrigin !== undefined) process.env.ALFIE_UI_PUBLIC_ORIGIN = prevOrigin;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("first-run /api/auth/setup creates the initial admin once and rejects subsequent calls", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-setup-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  const server = createAlfieInterfaceServer({ authStore, cookieSecure: false, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const before = await (await fetch(base + "/api/auth/me")).json();
    assert.equal(before.setupRequired, true);

    const weak = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "short-password" })
    });
    assert.equal(weak.status, 400);

    // Wrong localhost port is rejected (no arbitrary localhost bypass)
    const wrongPort = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { origin: "http://localhost:9999", "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a-very-strong-first-run-password-2026" })
    });
    assert.equal(wrongPort.status, 403);

    const created = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a-very-strong-first-run-password-2026" })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.authenticated, true);
    assert.equal(createdBody.user.username, "owner");

    const second = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "another-very-strong-password-2026" })
    });
    assert.equal(second.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("projects, context handoff, and VRAM telemetry routes enforce CSRF and proxy cleanly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-projects-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const convId = "11111111-1111-1111-1111-111111111111";
  const projId = "22222222-2222-2222-2222-222222222222";
  const coreClient = {
    listProjects: async () => ({ projects: [{ id: projId, name: "Alpha", conversationCount: 1 }] }),
    createProject: async (_userId, body) => ({ project: { id: projId, name: body.name, color: body.color || "purple", conversationCount: 0 } }),
    updateProject: async (_userId, id, body) => ({ project: { id, ...body } }),
    deleteProject: async () => ({ deleted: true, unassignedConversations: 1 }),
    handoffConversation: async (_userId, id, body) => ({
      conversation: { id: "33333333-3333-3333-3333-333333333333", title: "Session (Part 2)", parentConversationId: id, projectId: body.projectId || null, handoffContext: "# Summary" }
    }),
    getVramStatus: async () => ({ vram: { available: true, percent: 84, warning: true, thresholdPercent: 80 } }),
    reportVramStatus: async (_userId, body) => ({ vram: { available: true, percent: body.percent, warning: body.percent >= 80, thresholdPercent: 80 } })
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
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await login.json();

    // POST /api/core/projects without CSRF blocked
    const blockedProject = await fetch(base + "/api/core/projects", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha" })
    });
    assert.equal(blockedProject.status, 403);

    // POST /api/core/projects with CSRF succeeds
    const createdProject = await fetch(base + "/api/core/projects", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ name: "Alpha", color: "cyan" })
    });
    assert.equal(createdProject.status, 201);
    assert.equal((await createdProject.json()).project.name, "Alpha");

    // GET /api/core/system/vram returns warning status
    const vramRes = await fetch(base + "/api/core/system/vram", { headers: { cookie } });
    assert.equal(vramRes.status, 200);
    assert.equal((await vramRes.json()).vram.warning, true);

    // POST /api/core/conversations/:id/handoff requires CSRF and returns continuation chat
    const blockedHandoff = await fetch(`${base}/api/core/conversations/${convId}/handoff`, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "vram_threshold" })
    });
    assert.equal(blockedHandoff.status, 403);

    const handoffRes = await fetch(`${base}/api/core/conversations/${convId}/handoff`, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ reason: "vram_threshold", projectId: projId })
    });
    assert.equal(handoffRes.status, 201);
    const handoffPayload = await handoffRes.json();
    assert.equal(handoffPayload.conversation.title, "Session (Part 2)");
    assert.equal(handoffPayload.conversation.projectId, projId);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud agent settings and privacy preview routes enforce auth and CSRF", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-cloud-agents-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const coreClient = {
    listCloudAgents: async () => ({
      agents: [
        { provider: "gemini", name: "Gemini API", enabled: false, privacyWarningAccepted: false, model: "gemini-4-hydrogen" },
        { provider: "openai", name: "ChatGPT (OpenAI)", enabled: false, privacyWarningAccepted: false, model: "gpt-4.1-mini" }
      ]
    }),
    updateCloudAgent: async (_userId, provider, body) => ({
      agent: { provider, enabled: Boolean(body.enabled), privacyWarningAccepted: Boolean(body.privacyWarningAccepted), model: body.model || "gemini-4-hydrogen" }
    }),
    previewCloudAgentPrivacy: async (_userId, provider) => ({
      provider,
      summary: { personalDataIsolated: true, blockedCategories: ["Emails & Inbox", "Calendar & Schedule"] }
    })
  };
  const server = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const unauth = await fetch(base + "/api/core/cloud-agents");
    assert.equal(unauth.status, 401);

    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await login.json();

    const listRes = await fetch(base + "/api/core/cloud-agents", { headers: { cookie } });
    assert.equal(listRes.status, 200);
    assert.equal((await listRes.json()).agents.length, 2);

    // PATCH without CSRF blocked
    const blockedPatch = await fetch(base + "/api/core/cloud-agents/gemini", {
      method: "PATCH",
      headers: { origin: base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ privacyWarningAccepted: true, enabled: true })
    });
    assert.equal(blockedPatch.status, 403);

    // PATCH with CSRF succeeds
    const okPatch = await fetch(base + "/api/core/cloud-agents/gemini", {
      method: "PATCH",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ privacyWarningAccepted: true, enabled: true, model: "gemini-4-hydrogen" })
    });
    assert.equal(okPatch.status, 200);
    assert.equal((await okPatch.json()).agent.enabled, true);

    // POST privacy-preview with CSRF succeeds
    const previewRes = await fetch(base + "/api/core/cloud-agents/openai/privacy-preview", {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({})
    });
    assert.equal(previewRes.status, 200);
    assert.equal((await previewRes.json()).summary.personalDataIsolated, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});





test("concurrent failed logins reserve throttle slots before password hashing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-concurrent-throttle-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const server = createAlfieInterfaceServer({ authStore, cookieSecure: false, coreClient: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: "alfie-admin", password: "incorrect-password-123456" })
    })));
    assert.equal(attempts.filter((response) => response.status === 429).length, 3);
    assert.equal(attempts.filter((response) => response.status === 401).length, 5);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("/api/health responds 200 and trusted HTTPS reverse proxy upgrades session cookies for iframes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-proxy-https-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  const prevSameSite = process.env.ALFIE_UI_COOKIE_SAMESITE;
  process.env.ALFIE_UI_COOKIE_SAMESITE = "none";
  const server = createAlfieInterfaceServer({
    authStore,
    coreClient: {},
    cookieSecure: false,
    trustProxyHeaders: true,
    allowLocalHttpOrigin: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const apiHealth = await fetch(base + "/api/health");
    assert.equal(apiHealth.status, 200);
    assert.deepEqual(await apiHealth.json(), { status: "ok", service: "alfie-interface" });

    // Trusted proxy HTTPS origin succeeds and upgrades cookie to Secure; SameSite=None; Partitioned
    const proxyHost = "alfie-prod.example.run.app";
    const httpsLogin = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        origin: `https://${proxyHost}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": proxyHost,
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(httpsLogin.status, 200);
    const setCookie = httpsLogin.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Partitioned/);

    // Mismatched external origin is still rejected
    const badOrigin = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": proxyHost,
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "alfie-admin", password: "test-password-for-ci-only-123456" })
    });
    assert.equal(badOrigin.status, 403);
  } finally {
    if (prevSameSite === undefined) delete process.env.ALFIE_UI_COOKIE_SAMESITE;
    else process.env.ALFIE_UI_COOKIE_SAMESITE = prevSameSite;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});



test("approval proxy preserves an uncertain external outcome and passes a cancellable signal", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ui-approval-outcome-"));
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  await authStore.bootstrap("alfie-admin", "test-password-for-ci-only-123456");
  let approvalCall = null;
  const coreClient = {
    approveAction: async (userId, actionId, options = {}) => {
      approvalCall = { userId, actionId, signal: options.signal };
      throw Object.assign(new Error("External action outcome is uncertain."), {
        status: 502,
        code: "ACTION_OUTCOME_UNKNOWN",
        actionConsumed: true,
        actionOutcomeUnknown: true,
        actionId,
        toolId: "external.publish"
      });
    }
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
    const response = await fetch(base + "/api/core/tools/approve", {
      method: "POST",
      headers: {
        origin: base,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken
      },
      body: JSON.stringify({ actionId: "action-outcome-1" })
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.actionConsumed, true);
    assert.equal(payload.actionOutcomeUnknown, true);
    assert.equal(payload.retryable, false);
    assert.equal(payload.code, "ACTION_OUTCOME_UNKNOWN");
    assert.equal(approvalCall.userId, session.user.id);
    assert.equal(approvalCall.actionId, "action-outcome-1");
    assert.ok(approvalCall.signal instanceof AbortSignal);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
