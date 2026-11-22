import test from "node:test";
import assert from "node:assert/strict";
import { computeToolFingerprint } from "../src/agent/toolDispatcher.mjs";

function tool(handler, implementationVersion = "1") {
  return {
    id: "demo.write",
    scope: "demo:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    untrustedOutput: false,
    requiresApproval: true,
    approvalWhenUntrusted: false,
    approvalGuard: null,
    verifyResult: null,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler,
    implementationVersion
  };
}

test("approval fingerprint changes when handler implementation changes", () => {
  const first = tool(async () => ({ changed: false }));
  const changed = tool(async () => ({ changed: true }));
  assert.notEqual(computeToolFingerprint(first), computeToolFingerprint(changed));
});

test("approval fingerprint changes when implementation version changes", () => {
  const sameHandler = async () => ({ ok: true });
  assert.notEqual(computeToolFingerprint(tool(sameHandler, "1")), computeToolFingerprint(tool(sameHandler, "2")));
});

test("cosmetic tool metadata remains outside approval fingerprint", () => {
  const base = tool(async () => ({ ok: true }));
  const cosmetic = { ...base, name: "Renamed", description: "New description", tags: ["new"] };
  assert.equal(computeToolFingerprint(base), computeToolFingerprint(cosmetic));
});
