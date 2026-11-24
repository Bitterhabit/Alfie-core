import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, DEFAULT_PROVIDER_CHAT_TIMEOUT_MS } from "../src/providers/registry.mjs";
import { CloudAgentAdapters, DEFAULT_CLOUD_OPENAI_TIMEOUT_MS } from "../src/providers/cloudAdapters.mjs";

test("provider chat requests use the 30-minute default and clamp custom budgets", async () => {
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  };
  try {
    const registry = new ProviderRegistry({
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "done" } }] }) })
    });
    const endpoint = { id: "test", provider: "openai", baseUrl: "https://api.example.com", model: "test-model", trustedLocal: false };
    const messages = [{ role: "user", content: "Hello" }];
    await registry.chat(endpoint, messages);
    await registry.chat(endpoint, messages, { timeoutMs: 90_000 });
    await registry.chat(endpoint, messages, { timeoutMs: 60 * 60 * 1000 });
    assert.deepEqual(timeouts, [DEFAULT_PROVIDER_CHAT_TIMEOUT_MS, 90_000, DEFAULT_PROVIDER_CHAT_TIMEOUT_MS]);
    assert.equal(DEFAULT_PROVIDER_CHAT_TIMEOUT_MS, 30 * 60 * 1000);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("cloud OpenAI adapter uses the 5-minute response timeout budget", async () => {
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  };
  try {
    const adapters = new CloudAgentAdapters({
      env: { OPENAI_API_KEY: "sk-test-timeout-check" },
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const result = await adapters.completeOpenAi({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Ping" }]
    });
    assert.equal(result.endpoint.provider, "openai");
    assert.equal(DEFAULT_CLOUD_OPENAI_TIMEOUT_MS, 5 * 60 * 1000);
    assert.deepEqual(timeouts, [DEFAULT_CLOUD_OPENAI_TIMEOUT_MS]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
