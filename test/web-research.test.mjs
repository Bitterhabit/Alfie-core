import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { registerWebResearchTools, validatePublicWebUrl, extractReadableText } from "../src/integrations/webResearch.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("web reader extracts title, description and readable text without scripts", () => {
  const result = extractReadableText('<html><head><title>Example &amp; Test</title><meta name="description" content="A page"></head><body><nav>Menu</nav><h1>Hello</h1><script>ignoreThis()</script><p>Useful content.</p></body></html>');
  assert.equal(result.title, "Example & Test");
  assert.equal(result.description, "A page");
  assert.match(result.text, /Hello/);
  assert.match(result.text, /Useful content/);
  assert.doesNotMatch(result.text, /ignoreThis|Menu/);
});

test("web URL validation allows public HTTPS and blocks local or non-HTTPS destinations", async () => {
  const url = await validatePublicWebUrl("https://example.com/article#section", { lookupImpl: publicLookup });
  assert.equal(url.hash, "");
  await assert.rejects(() => validatePublicWebUrl("http://example.com", { lookupImpl: publicLookup }), /HTTPS/);
  await assert.rejects(() => validatePublicWebUrl("https://localhost", { lookupImpl: publicLookup }), /Local and internal/);
  await assert.rejects(() => validatePublicWebUrl("https://192.168.1.1", { lookupImpl: publicLookup }), /public IP/);
  await assert.rejects(() => validatePublicWebUrl("https://example.com", { lookupImpl: async () => [{ address: "10.0.0.2", family: 4 }] }), /public IP/);
});

test("registers three read-only external web tools under one permission scope", () => {
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, { fetchImpl: async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } }), lookupImpl: publicLookup });
  const tools = registry.list(["web:read"]);
  assert.deepEqual(tools.map((tool) => tool.id), ["web.search", "web.open", "web.research"]);
  for (const tool of tools) {
    assert.equal(tool.scope, "web:read");
    assert.equal(tool.risk, "read");
    assert.equal(tool.network, true);
    assert.equal(tool.externalAction, false);
    assert.equal(tool.permitted, true);
  }
});

test("web.search requires a server-side Brave API key and returns bounded results", async () => {
  const previous = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  process.env.ALFIE_BRAVE_SEARCH_API_KEY = "test-key";
  try {
    let requested;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify({ web: { results: [
        { title: "One", url: "https://example.com/one", description: "Summary" },
        { title: "Two", url: "https://example.com/two", description: "Summary" }
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic", count: 1 });
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, "One");
    assert.match(requested.url, /q=test\+topic/);
    assert.equal(requested.options.headers["X-Subscription-Token"], "test-key");
  } finally {
    if (previous === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previous;
  }
});

test("web.open pins the request to the validated public DNS address and refuses private redirects", async () => {
  let calls = 0;
  let pinnedAddresses;
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    requestImpl: async (_url, options) => {
      calls += 1;
      pinnedAddresses = options.addresses;
      return new Response("", { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    },
    lookupImpl: publicLookup
  });
  await assert.rejects(() => registry.tools.get("web.open").handler({ url: "https://example.com" }), /public IP/);
  assert.equal(calls, 1);
  assert.deepEqual(pinnedAddresses, [{ address: "93.184.216.34", family: 4 }]);
});


test("web.search prefers the configured private SearXNG JSON API", async () => {
  const previousUrl = process.env.ALFIE_SEARXNG_URL;
  const previousKey = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  process.env.ALFIE_SEARXNG_URL = "http://searxng:8080";
  delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  try {
    let requested;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify({ results: [
        { title: "SearX result", url: "https://example.com/result", content: "A useful summary", engines: ["duckduckgo"] }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic", count: 2 });
    assert.equal(result.provider, "SearXNG");
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, "SearX result");
    assert.match(requested.url, /^http:\/\/searxng:8080\/search\?/);
    assert.match(requested.url, /format=json/);
    assert.equal(requested.options.headers.Accept, "application/json");
  } finally {
    if (previousUrl === undefined) delete process.env.ALFIE_SEARXNG_URL;
    else process.env.ALFIE_SEARXNG_URL = previousUrl;
    if (previousKey === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previousKey;
  }
});

test("web.search falls back to Brave when SearXNG is unavailable", async () => {
  const previousUrl = process.env.ALFIE_SEARXNG_URL;
  const previousKey = process.env.ALFIE_BRAVE_SEARCH_API_KEY;
  process.env.ALFIE_SEARXNG_URL = "http://searxng:8080";
  process.env.ALFIE_BRAVE_SEARCH_API_KEY = "fallback-test-key";
  try {
    let calls = 0;
    const registry = new ToolRegistry();
    registerWebResearchTools(registry, { fetchImpl: async (url) => {
      calls += 1;
      if (String(url).startsWith("http://searxng:8080")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ web: { results: [
        { title: "Brave fallback", url: "https://example.com/fallback", description: "Fallback summary" }
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }, lookupImpl: publicLookup });
    const result = await registry.tools.get("web.search").handler({ query: "test topic" });
    assert.equal(calls, 2);
    assert.equal(result.provider, "Brave Search");
    assert.match(result.fallbackReason, /SearXNG returned HTTP 503/);
    assert.equal(result.results[0].title, "Brave fallback");
  } finally {
    if (previousUrl === undefined) delete process.env.ALFIE_SEARXNG_URL;
    else process.env.ALFIE_SEARXNG_URL = previousUrl;
    if (previousKey === undefined) delete process.env.ALFIE_BRAVE_SEARCH_API_KEY;
    else process.env.ALFIE_BRAVE_SEARCH_API_KEY = previousKey;
  }
});
