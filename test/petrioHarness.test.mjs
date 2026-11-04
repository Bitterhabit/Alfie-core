import test from "node:test";
import assert from "node:assert/strict";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { PetrioHarnessClient, registerPetrioHarnessTools } from "../src/integrations/petrioHarness.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";

test("Petrio harness client sends a signed identity to the internal read-only adapter", async () => {
  const secret = "identity-secret-".repeat(3);
  const token = "service-token-".repeat(3);
  const identityAuth = createPetrioIdentityAuth({ secret });
  let captured;
  const client = new PetrioHarnessClient({
    url: "http://petrio:3000/v1/alfie-core/tools/run",
    serviceToken: token,
    identityAuth,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ success: true, result: { version: "0.6.9" } }), { status: 200 });
    }
  });
  const result = await client.run("petrio-user-1", "get_petrio_status");
  assert.deepEqual(result, { version: "0.6.9" });
  const controller = new AbortController();
  await client.run("petrio-user-1", "get_calendar_events", { query: "Dentist", limit: 4 }, { signal: controller.signal });
  assert.deepEqual(JSON.parse(captured.options.body), { tool: "get_calendar_events", arguments: { query: "Dentist", limit: 4 } });
  assert.equal(captured.options.signal.aborted, false);
  controller.abort();
  assert.equal(captured.options.signal.aborted, true);
  assert.equal(captured.url, "http://petrio:3000/v1/alfie-core/tools/run");
  assert.equal(captured.options.headers.authorization, `Bearer ${token}`);
  assert.equal(identityAuth.verify(captured.options.headers, {
    method: "POST", path: "/v1/alfie-core/tools/run"
  }).userId, "petrio-user-1");
});

test("registers the existing Petrio read-only harness tools with separate permission scopes", () => {
  const identityAuth = createPetrioIdentityAuth({ secret: "identity-secret-".repeat(3) });
  const client = new PetrioHarnessClient({
    serviceToken: "service-token-".repeat(3),
    identityAuth,
    fetchImpl: async () => new Response("{}", { status: 200 })
  });
  const registry = new ToolRegistry();
  const registered = registerPetrioHarnessTools(registry, client);
  assert.equal(registered.length, 8);
  assert.ok(registered.every((tool) => tool.risk === "read" && !tool.requiresApproval));
  assert.ok(registered.every((tool) => tool.trust === "external" && tool.untrustedOutput));
  assert.ok(registry.list().some((tool) => tool.id === "get_personal_activity" && tool.scope === "petrio:activity:read"));
  const calendar = registry.tools.get("get_calendar_events");
  assert.equal(calendar.scope, "calendar:read");
  assert.equal(calendar.inputSchema.properties.startDate.format, "date");
  const journal = registry.tools.get("read_journal");
  assert.equal(journal.scope, "journal:read");
  assert.equal(journal.inputSchema.anyOf.length, 3);
});

test("does not register Petrio tools until the private adapter is configured", () => {
  const client = new PetrioHarnessClient({ serviceToken: "", identityAuth: null });
  const registry = new ToolRegistry();
  assert.deepEqual(registerPetrioHarnessTools(registry, client), []);
  assert.equal(registry.list().length, 0);
  assert.equal(client.enabled, false);
});

test("Calendar and Journal tools enforce their strict input schemas", () => {
  const registry = new ToolRegistry();
  registerPetrioHarnessTools(registry, { enabled: true, run: async () => ({}) });
  const dispatcher = new ToolDispatcher({
    registry,
    permissionStore: { list: async () => [] },
    pendingActionStore: { create: async () => ({}) }
  });
  const calendar = registry.tools.get("get_calendar_events");
  assert.doesNotThrow(() => dispatcher.validate(calendar, { startDate: "2026-11-04", endDate: "2026-11-10", query: "Dentist" }));
  assert.throws(() => dispatcher.validate(calendar, { startDate: "04/11/2026" }), { code: "TOOL_VALIDATION_FAILED" });
  const journal = registry.tools.get("read_journal");
  assert.doesNotThrow(() => dispatcher.validate(journal, { query: "Petrio" }));
  assert.doesNotThrow(() => dispatcher.validate(journal, { entryId: "journal-entry-1" }));
  assert.doesNotThrow(() => dispatcher.validate(journal, { latest: true, limit: 2 }));
  assert.throws(() => dispatcher.validate(journal, {}), { code: "TOOL_VALIDATION_FAILED" });
});
