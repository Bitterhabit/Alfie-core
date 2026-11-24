import test from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { registerWebResearchTools } from "../src/integrations/webResearch.mjs";

test("web search intent selects permitted web tools and adds source-linking guidance", () => {
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    fetchImpl: async () => new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  const result = new ContextAssembler().assemble({
    userText: "Search the web for current Node.js security guidance",
    registry,
    grantedScopes: ["web:read"]
  });
  assert.ok(result.tools.some((tool) => tool.id === "web.search"));
  assert.match(result.messages[0].content, /cite source-backed factual claims with Markdown links/);
});

test("web research tools and citation guidance stay unavailable without permission", () => {
  const registry = new ToolRegistry();
  registerWebResearchTools(registry, {
    fetchImpl: async () => new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  const result = new ContextAssembler().assemble({
    userText: "Search the web for current Node.js security guidance",
    registry,
    grantedScopes: []
  });
  assert.equal(result.tools.length, 0);
  assert.doesNotMatch(result.messages[0].content, /cite source-backed factual claims with Markdown links/);
});
