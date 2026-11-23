import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, DEFAULT_PROVIDER_CHAT_TIMEOUT_MS } from "../src/providers/registry.mjs";

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
