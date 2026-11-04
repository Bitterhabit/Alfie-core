import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.mjs";

test("registry requires explicit risk, trust, network and side-effect declarations", () => {
  const registry = new ToolRegistry();
  const handler = async () => ({ ok: true });
  assert.throws(() => registry.register({ id: "calendar.read", scope: "calendar:read", handler }), TypeError);
  assert.throws(() => registry.register({
    id: "calendar.read", scope: "calendar:read", trust: "internal",
    network: false, externalAction: false, risk: "unsafe", handler
  }), TypeError);
  assert.throws(() => registry.register({
    id: "calendar.read", scope: "calendar:read", trust: "internal",
    network: false, risk: "read", handler
  }), TypeError);
});

test("registry exposes immutable schemas and only declarative metadata", () => {
  const registry = new ToolRegistry();
  const schema = {
    type: "object",
    properties: { days: { type: "integer", minimum: 1, maximum: 31 } },
    required: ["days"],
    additionalProperties: false
  };
  registry.register({
    id: "calendar.list", name: "List calendar events", description: "Read calendar events",
    scope: "calendar:read", risk: "read", trust: "internal",
    network: false, externalAction: false, tags: ["calendar", "appointments"],
    inputSchema: schema, handler: async () => []
  });
  schema.properties.days.maximum = 999;
  const [permitted] = registry.list(["calendar:read"]);
  const [denied] = registry.list([]);
  assert.equal(permitted.permitted, true);
  assert.equal(denied.permitted, false);
  assert.equal(permitted.inputSchema.properties.days.maximum, 31);
  assert.equal(permitted.requiresApproval, false);
  assert.equal(typeof registry.execute, "undefined");
  assert.equal(typeof registry.plan, "undefined");
});

test("write and external-action tools are marked as approval-required", () => {
  const registry = new ToolRegistry();
  const base = {
    id: "mail.send", scope: "mail:send", trust: "external",
    network: true, externalAction: true, risk: "write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ sent: true })
  };
  const definition = registry.register(base);
  assert.equal(definition.requiresApproval, true);
  assert.equal(definition.untrustedOutput, true);
  assert.equal(definition.externalAction, true);
});

test("registry rejects duplicate IDs and malformed tool definitions", () => {
  const registry = new ToolRegistry();
  const definition = {
    id: "system.read", scope: "system:read", trust: "internal",
    network: false, externalAction: false, handler: async () => ({})
  };
  registry.register(definition);
  assert.throws(() => registry.register(definition), TypeError);
  assert.throws(() => registry.register({ ...definition, id: "bad id" }), TypeError);
  assert.throws(() => registry.register({ ...definition, id: "bad.schema", inputSchema: [] }), TypeError);
});
