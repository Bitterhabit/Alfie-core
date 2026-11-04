import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry, endpointFor, headersFor, normaliseConfig,
  normaliseEndpoint, publicConfig
} from "../src/providers/registry.mjs";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

test("normalises legacy and multi-endpoint configuration while limiting endpoint count", () => {
  const legacy = normaliseConfig({ provider: "ollama", baseUrl: "http://thor:11434", model: "qwen2.5:14b" });
  assert.equal(legacy.endpoints[0].id, "legacy-primary");
  assert.equal(legacy.endpoints[0].provider, "ollama");
  const config = normaliseConfig({ endpoints: Array.from({ length: 10 }, (_, i) => ({ id: "same", model: `m${i}` })) });
  assert.equal(config.endpoints.length, 8);
  assert.equal(new Set(config.endpoints.map((item) => item.id)).size, 8);
});

test("normalises malformed provider config and ignores null endpoint entries safely", () => {
  assert.deepEqual(normaliseConfig(null).endpoints, []);
  const config = normaliseConfig({ endpoints: [null, "invalid", { id: "valid", model: "qwen" }] });
  assert.equal(config.endpoints.length, 1);
  assert.equal(config.endpoints[0].id, "valid");
});

test("rejects invalid protocols and embedded endpoint credentials", () => {
  assert.throws(() => normaliseEndpoint({ baseUrl: "file:///etc/passwd" }), { code: "INVALID_PROVIDER_CONFIG" });
  assert.throws(() => normaliseEndpoint({ baseUrl: "https://user:pass@example.test" }), { code: "INVALID_PROVIDER_CONFIG" });
});

test("public provider configuration never exposes API keys", () => {
  const config = normaliseConfig({ endpoints: [{ id: "remote", model: "model", apiKey: "secret-value" }] });
  const exposed = publicConfig(config);
  assert.equal(exposed.endpoints[0].apiKey, undefined);
  assert.equal(exposed.endpoints[0].apiKeyConfigured, true);
});

test("builds correct Ollama and OpenAI-compatible endpoints and headers", () => {
  const ollama = normaliseEndpoint({ provider: "ollama", baseUrl: "http://thor:11434/", model: "qwen" });
  assert.equal(endpointFor(ollama, "models"), "http://thor:11434/api/tags");
  assert.equal(endpointFor(ollama, "chat"), "http://thor:11434/api/chat");
  const openai = normaliseEndpoint({ baseUrl: "http://llm:1234/v1", apiKey: "secret" });
  assert.equal(endpointFor(openai, "models"), "http://llm:1234/v1/models");
  assert.equal(headersFor(openai).Authorization, "Bearer secret");
});

test("selects the highest ranked healthy endpoint and falls back when a preferred provider is down", async () => {
  const calls = [];
  const registry = new ProviderRegistry({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("thor")) throw new Error("offline");
      return response({ data: [{ id: "standard-model" }] });
    }
  });
  const config = normaliseConfig({
    mode: "auto",
    endpoints: [
      { id: "thor", name: "Thor", provider: "ollama", baseUrl: "http://thor:11434", model: "qwen", mode: "standard", priority: 100 },
      { id: "backup", name: "Backup", baseUrl: "http://backup:1234/v1", model: "standard-model", mode: "standard", priority: 50 }
    ]
  });
  const selected = await registry.select(config);
  assert.equal(selected.endpoint.id, "backup");
  assert.equal(selected.health.length, 2);
  assert.equal(calls.length, 2);
});

test("health cache avoids repeated provider probes until expiry", async () => {
  let now = 1000;
  let count = 0;
  const registry = new ProviderRegistry({
    now: () => now,
    fetchImpl: async () => { count += 1; return response({ data: [{ id: "m" }] }); }
  });
  const config = normaliseConfig({ endpoints: [{ id: "one", model: "m" }] });
  await registry.select(config);
  await registry.select(config);
  assert.equal(count, 1);
  now += 31000;
  await registry.select(config);
  assert.equal(count, 2);
});

test("sends provider-specific chat payloads and parses non-streaming responses", async () => {
  const requests = [];
  const registry = new ProviderRegistry({
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response({ message: { content: "Hello from Ollama" } });
    }
  });
  const endpoint = normaliseEndpoint({
    provider: "ollama", baseUrl: "http://thor:11434", model: "qwen", temperature: 0.2, maxTokens: 256
  });
  const result = await registry.chat(endpoint, [{ role: "user", content: "Hello" }]);
  assert.equal(result.content, "Hello from Ollama");
  assert.equal(requests[0].body.options.num_predict, 256);
  assert.equal(requests[0].body.stream, false);
});

test("retries the next healthy provider when the preferred model fails", async () => {
  const calls = [];
  const registry = new ProviderRegistry({
    fetchImpl: async (url, options) => {
      if (options.method === "GET") return response({ data: [{ id: "m" }] });
      calls.push(url);
      if (url.includes("primary")) return response({ error: "upstream unavailable" }, 503);
      return response({ choices: [{ message: { content: "Backup answered" } }] });
    }
  });
  const config = normaliseConfig({
    mode: "standard",
    endpoints: [
      { id: "primary", baseUrl: "http://primary/v1", model: "m", mode: "standard", priority: 90 },
      { id: "backup", baseUrl: "http://backup/v1", model: "m", mode: "standard", priority: 50 }
    ]
  });
  const result = await registry.complete(config, [{ role: "user", content: "Hi" }], "standard");
  assert.equal(result.endpoint.id, "backup");
  assert.equal(result.result.content, "Backup answered");
  assert.equal(result.fallbackUsed, true);
  assert.equal(calls.length, 2);
});

test("opens a provider stream and reports the selected endpoint", async () => {
  const registry = new ProviderRegistry({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") return response({ data: [{ id: "m" }] });
      const encoder = new TextEncoder();
      return {
        ok: true, status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        })
      };
    }
  });
  const config = normaliseConfig({ endpoints: [{ id: "stream", model: "m", baseUrl: "http://stream/v1" }] });
  const opened = await registry.openStream(config, [{ role: "user", content: "Hi" }]);
  assert.equal(opened.endpoint.id, "stream");
  assert.equal(opened.response.ok, true);
});
