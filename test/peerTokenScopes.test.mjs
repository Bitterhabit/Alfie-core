import test from "node:test";
import assert from "node:assert/strict";
import { PEER_TOKEN_SCOPES } from "../src/clients/tokenStore.mjs";

test("peer token scopes expose only implemented peer API capabilities", () => {
  assert.deepEqual(PEER_TOKEN_SCOPES, ["capture:write", "search:read", "status:read"]);
});
