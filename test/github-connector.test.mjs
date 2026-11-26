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
});
