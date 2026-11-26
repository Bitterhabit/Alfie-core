import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { registerModularConnectorTools, getModularIntegrationsStatus } from "../src/integrations/modularConnectors.mjs";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("GitHub connector registers bounded read-only repository browsing tools", () => {
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async () => json({}) });
  const github = registry.list(["github:read"]).filter((tool) => tool.id.startsWith("github."));
  for (const id of ["github.repo.inspect", "github.repo.tree", "github.file.read", "github.commits.list", "github.pull_requests.list"]) {
    const tool = github.find((item) => item.id === id);
    assert.ok(tool, id);
    assert.equal(tool.scope, "github:read");
    assert.equal(tool.risk, "read");
    assert.equal(tool.trust, "external");
    assert.equal(tool.network, true);
    assert.equal(tool.externalAction, false);
    assert.equal(tool.permitted, true);
  }
});

test("github.repo.tree lists bounded files from the pinned GitHub API", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/repos/acme/demo")) return json({ default_branch: "main" });
    return json({ tree: [
      { type: "blob", path: "src/index.mjs", size: 100, sha: "abc" },
      { type: "tree", path: "src", sha: "def" },
      { type: "blob", path: "README.md", size: 20, sha: "ghi" }
    ] });
  } });
  const result = await registry.tools.get("github.repo.tree").handler({ repo: "acme/demo", path: "src" });
  assert.equal(result.branch, "main");
  assert.deepEqual(result.files.map((item) => item.path), ["src/index.mjs"]);
  assert.ok(calls.every((url) => url.startsWith("https://api.github.com/")));
});

test("github.file.read decodes bounded text and blocks sensitive or traversing paths", async () => {
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async () => json({
    type: "file", size: 12, path: "src/app.mjs", sha: "abc",
    content: Buffer.from("export const ok = true;").toString("base64")
  }) });
  const tool = registry.tools.get("github.file.read");
  const result = await tool.handler({ repo: "acme/demo", path: "src/app.mjs" });
  assert.match(result.content, /export const ok/);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: ".env" }), (error) => error.status === 403);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: ".envrc" }), (error) => error.status === 403);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: "production.env" }), (error) => error.status === 403);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: ".aws/credentials" }), (error) => error.status === 403);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: ".npmrc" }), (error) => error.status === 403);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: "../secret.txt" }), (error) => error.status === 400);
  await assert.rejects(() => tool.handler({ repo: "acme/demo", path: "src\\\\..\\\\secret.txt" }), (error) => error.status === 400);
});

test("GitHub commit and pull request readers return compact summaries", async () => {
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async (url) => {
    if (String(url).includes("/commits?")) return json([{ sha: "12345678901234567890", commit: { message: "Fix tests", author: { name: "Dev", date: "2026-11-26T12:00:00Z" } }, html_url: "https://github.com/acme/demo/commit/123" }]);
    if (String(url).includes("/pulls?")) return json([{ number: 7, title: "Add feature", state: "open", draft: true, user: { login: "dev" }, html_url: "https://github.com/acme/demo/pull/7" }]);
    throw new Error("Unexpected URL");
  } });
  const commits = await registry.tools.get("github.commits.list").handler({ repo: "acme/demo" });
  const pulls = await registry.tools.get("github.pull_requests.list").handler({ repo: "acme/demo" });
  assert.equal(commits.commits[0].message, "Fix tests");
  assert.equal(pulls.pullRequests[0].number, 7);
  assert.equal(pulls.pullRequests[0].draft, true);
});

test("GitHub integration status describes the expanded capabilities", () => {
  const status = getModularIntegrationsStatus({ env: {} }).find((item) => item.id === "github");
  assert.ok(status.tools.includes("github.repo.tree"));
  assert.ok(status.tools.includes("github.file.read"));
  assert.ok(status.tools.includes("github.pull_requests.list"));
  assert.ok(status.tools.includes("github.change.create_pr"));
  assert.ok(status.scopes.includes("github:write"));
});


test("GitHub project change tool is approval-gated and only creates Alfie draft branches and PRs", async () => {
  const previousToken = process.env.ALFIE_GITHUB_TOKEN;
  process.env.ALFIE_GITHUB_TOKEN = "test-github-token";
  const calls = [];
  const jsonReply = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: options.method || "GET", path: parsed.pathname, body: options.body ? JSON.parse(options.body) : null, auth: options.headers?.authorization });
    const method = options.method || "GET";
    if (method === "GET" && parsed.pathname === "/repos/acme/demo") return jsonReply({ default_branch: "main" });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/git/ref/heads/main") return jsonReply({ object: { sha: "base-commit" } });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/git/commits/base-commit") return jsonReply({ tree: { sha: "base-tree" } });
    if (method === "GET" && parsed.pathname.startsWith("/repos/acme/demo/git/ref/heads/alfie/")) return jsonReply({ message: "Not Found" }, 404);
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/contents/README.md") return jsonReply({ message: "Not Found" }, 404);
    if (method === "POST" && parsed.pathname === "/repos/acme/demo/git/blobs") return jsonReply({ sha: "blob-sha" });
    if (method === "POST" && parsed.pathname === "/repos/acme/demo/git/trees") return jsonReply({ sha: "tree-sha" });
    if (method === "POST" && parsed.pathname === "/repos/acme/demo/git/commits") return jsonReply({ sha: "new-commit-sha" });
    if (method === "POST" && parsed.pathname === "/repos/acme/demo/git/refs") return jsonReply({ ref: "refs/heads/alfie/feature-one" }, 201);
    if (method === "POST" && parsed.pathname === "/repos/acme/demo/pulls") return jsonReply({ number: 12, html_url: "https://github.com/acme/demo/pull/12" }, 201);
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/pulls/12") return jsonReply({ number: 12, state: "open", head: { ref: "alfie/feature-one" }, base: { ref: "main" } });
    throw new Error(`Unexpected GitHub API request: ${method} ${parsed.pathname}`);
  } });
  try {
    const tool = registry.tools.get("github.change.create_pr");
    assert.ok(tool);
    assert.equal(tool.scope, "github:write");
    assert.equal(tool.risk, "write");
    assert.equal(tool.requiresApproval, true);
    assert.equal(tool.externalAction, true);
    assert.equal(tool.network, true);
    assert.equal(tool.trust, "external");
    assert.match(tool.approvalPreview({ repo: "acme/demo", branch: "alfie/feature-one", title: "Add readme", files: [{ path: "README.md" }] }), /alfie\/feature-one/);
    const result = await tool.handler({
      repo: "acme/demo",
      branch: "alfie/feature-one",
      title: "Add readme",
      body: "A proposed project change.",
      commitMessage: "Add project readme",
      files: [{ path: "README.md", content: "# Demo\\n" }]
    });
    assert.equal(result.verified, true);
    assert.equal(result.draft, true);
    assert.equal(result.pullRequest, 12);
    assert.ok(calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs")));
    assert.ok(calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")));
    assert.ok(calls.every((call) => call.auth === "Bearer test-github-token"));
    await assert.rejects(() => tool.handler({
      repo: "acme/demo", branch: "main", title: "Bad", body: "No", commitMessage: "No",
      files: [{ path: "README.md", content: "overwrite" }]
    }), (error) => error.status === 400);
    await assert.rejects(() => tool.handler({
      repo: "acme/demo", branch: "alfie/bad", title: "Bad", body: "No", commitMessage: "No",
      files: [{ path: "secrets.env", content: "secret" }]
    }), (error) => error.status === 403);
    await assert.rejects(() => tool.handler({
      repo: "acme/demo", branch: "alfie/bad", title: "Bad", body: "No", commitMessage: "No",
      files: [{ path: ".aws/credentials", content: "secret" }]
    }), (error) => error.status === 403);
    await assert.rejects(() => tool.handler({
      repo: "acme/demo", branch: "alfie/bad", title: "Bad", body: "No", commitMessage: "No",
      files: [{ path: "production.env", content: "secret" }]
    }), (error) => error.status === 403);
  } finally {
    if (previousToken === undefined) delete process.env.ALFIE_GITHUB_TOKEN;
    else process.env.ALFIE_GITHUB_TOKEN = previousToken;
  }
});


test("GitHub project changes require the exact existing-file SHA at the pinned base commit", async () => {
  const previousToken = process.env.ALFIE_GITHUB_TOKEN;
  process.env.ALFIE_GITHUB_TOKEN = "test-github-token";
  const calls = [];
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    calls.push({ method, path: parsed.pathname, ref: parsed.searchParams.get("ref") });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo") return json({ default_branch: "main" });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/git/ref/heads/main") return json({ object: { sha: "pinned-base-commit" } });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/git/commits/pinned-base-commit") return json({ tree: { sha: "pinned-base-tree" } });
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/git/ref/heads/alfie/change") return json({ message: "Not Found" }, 404);
    if (method === "GET" && parsed.pathname === "/repos/acme/demo/contents/README.md") return json({ type: "file", size: 12, sha: "current-blob-sha" });
    throw new Error(`Unexpected GitHub API request: ${method} ${parsed.pathname}`);
  } });
  try {
    const tool = registry.tools.get("github.change.create_pr");
    const base = {
      repo: "acme/demo",
      branch: "alfie/change",
      title: "Update README",
      body: "Reviewed update",
      commitMessage: "Update README",
    };
    await assert.rejects(
      () => tool.handler({ ...base, files: [{ path: "README.md", content: "# Updated" }] }),
      (error) => error.status === 409
    );
    await assert.rejects(
      () => tool.handler({ ...base, files: [{ path: "README.md", content: "# Updated", expectedSha: "stale-blob-sha" }] }),
      (error) => error.status === 409
    );
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    const contentReads = calls.filter((call) => call.path === "/repos/acme/demo/contents/README.md");
    assert.equal(contentReads.length, 2);
    assert.ok(contentReads.every((call) => call.ref === "pinned-base-commit"));
  } finally {
    if (previousToken === undefined) delete process.env.ALFIE_GITHUB_TOKEN;
    else process.env.ALFIE_GITHUB_TOKEN = previousToken;
  }
});


test("GitHub connector rejects dot-segment repository names and malformed Git refs", async () => {
  const previousToken = process.env.ALFIE_GITHUB_TOKEN;
  process.env.ALFIE_GITHUB_TOKEN = "test-github-token";
  const calls = [];
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return json({ default_branch: "main" });
  } });
  try {
    const tree = registry.tools.get("github.repo.tree");
    await assert.rejects(() => tree.handler({ repo: "../demo" }), (error) => error.status === 400);
    await assert.rejects(() => tree.handler({ repo: "acme/.." }), (error) => error.status === 400);
    assert.equal(calls.length, 0);

    const change = registry.tools.get("github.change.create_pr");
    const base = {
      repo: "acme/demo",
      branch: "alfie/safe-change",
      title: "Test",
      body: "Test",
      commitMessage: "Test",
      files: [{ path: "README.md", content: "test" }]
    };
    await assert.rejects(() => change.handler({ ...base, base: "../main" }), (error) => error.status === 400);
    await assert.rejects(() => change.handler({ ...base, base: "release//candidate" }), (error) => error.status === 400);
    await assert.rejects(() => change.handler({ ...base, base: "release/@{bad" }), (error) => error.status === 400);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    assert.ok(calls.every((call) => new URL(call.url).hostname === "api.github.com"));
  } finally {
    if (previousToken === undefined) delete process.env.ALFIE_GITHUB_TOKEN;
    else process.env.ALFIE_GITHUB_TOKEN = previousToken;
  }
});
