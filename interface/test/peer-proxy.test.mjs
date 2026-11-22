import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InterfaceAuthStore } from "../src/auth/store.mjs";
import { createAlfieInterfaceServer } from "../src/server.mjs";

test("peer CLI proxy requires a peer token and forwards scoped requests without a browser session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-peer-proxy-"));
  const calls = [];
  const coreClient = {
    callPeerEndpoint: async (token, endpoint, options = {}) => {
      calls.push({ token, endpoint, options });
      if (endpoint === "/v1/peer/status") return { status: "ok" };
      if (endpoint === "/v1/peer/capture") return { captured: "idea" };
      if (endpoint === "/v1/peer/search") return { search: { results: [] } };
      throw new Error("Unexpected peer endpoint.");
    }
  };
  const authStore = new InterfaceAuthStore({ dataDirectory: directory });
  const server = createAlfieInterfaceServer({ authStore, coreClient, cookieSecure: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const authorization = { authorization: "Bearer alf_test-peer-token" };

  try {
    const unauthenticated = await fetch(base + "/api/peer/status");
    assert.equal(unauthenticated.status, 401);

    const status = await fetch(base + "/api/peer/status", { headers: authorization });
    assert.deepEqual(await status.json(), { status: "ok" });

    const capture = await fetch(base + "/api/peer/capture", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ kind: "idea", text: "Test capture" })
    });
    assert.equal(capture.status, 201);
    assert.deepEqual(await capture.json(), { captured: "idea" });

    const search = await fetch(base + "/api/peer/search?q=SQLite&limit=5", { headers: authorization });
    assert.deepEqual(await search.json(), { search: { results: [] } });

    assert.deepEqual(calls.map((call) => [call.token, call.endpoint, call.options.method || "GET"]), [
      ["alf_test-peer-token", "/v1/peer/status", "GET"],
      ["alf_test-peer-token", "/v1/peer/capture", "POST"],
      ["alf_test-peer-token", "/v1/peer/search", "GET"]
    ]);
    assert.deepEqual(calls[1].options.body, { kind: "idea", text: "Test capture" });
    assert.equal(calls[2].options.query, "q=SQLite&limit=5");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
