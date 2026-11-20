import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VramMonitor, validateRemoteVramUrl, parseRemoteVramPayload } from "../src/system/vramMonitor.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieInterfaceServer } from "../interface/src/server.mjs";
import { InterfaceAuthStore } from "../interface/src/auth/store.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test("validateRemoteVramUrl blocks metadata IPs, embedded credentials, and non-HTTP schemes while allowing LAN PC URLs", () => {
  assert.equal(validateRemoteVramUrl("http://192.168.1.50:9100/vram"), "http://192.168.1.50:9100/vram");
  assert.equal(validateRemoteVramUrl("https://gpu-pc.lan/metrics/vram"), "https://gpu-pc.lan/metrics/vram");
  assert.equal(validateRemoteVramUrl("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(validateRemoteVramUrl("http://metadata.google.internal/computeMetadata/v1"), null);
  assert.equal(validateRemoteVramUrl("http://user:pass@192.168.1.50:9100/vram"), null);
  assert.equal(validateRemoteVramUrl("file:///etc/passwd"), null);
});

test("parseRemoteVramPayload parses JSON and nvidia-smi CSV from an external GPU PC", () => {
  const jsonReading = parseRemoteVramPayload(
    JSON.stringify({ gpu_name: "NVIDIA GeForce RTX 4090", memory_used_mb: 20480, memory_total_mb: 24576, host_name: "Gaming-PC" }),
    { fallbackHost: "192.168.1.50" }
  );
  assert.equal(jsonReading.available, true);
  assert.equal(jsonReading.gpuName, "NVIDIA GeForce RTX 4090");
  assert.equal(jsonReading.hostName, "Gaming-PC");
  assert.equal(jsonReading.percent, 83.3);

  const csvReading = parseRemoteVramPayload("NVIDIA GeForce RTX 3090, 19660, 24576\n", { fallbackHost: "192.168.1.50:9100" });
  assert.equal(csvReading.available, true);
  assert.equal(csvReading.gpuName, "NVIDIA GeForce RTX 3090");
  assert.equal(csvReading.hostName, "192.168.1.50:9100");
  assert.equal(csvReading.percent, 80);
});

test("VramMonitor prioritizes external PC push reports, exposes stale state after TTL, and supports pull + remote Ollama host info", async () => {
  let clock = 1_000_000;
  const monitor = new VramMonitor({
    externalReportTtlSeconds: 60,
    reportTokenConfigured: true,
    now: () => clock,
    execFileImpl: async () => { throw new Error("no local GPU on Proxmox"); },
    fetchImpl: async () => { throw new Error("offline"); }
  });

  const before = await monitor.inspect({ userId: "user-1" });
  assert.equal(before.available, false);
  assert.equal(before.connection.mode, "unconfigured");
  assert.equal(before.connection.pushTokenConfigured, true);

  // External PC pushes 85% VRAM
  const pushed = monitor.reportExternalHost({
    gpuName: "NVIDIA GeForce RTX 4090",
    hostName: "Gaming-PC",
    usedMb: 20890,
    totalMb: 24576
  });
  assert.equal(pushed.warning, true);
  assert.equal(pushed.percent, 85);
  assert.equal(pushed.connection.mode, "external-push");
  assert.equal(pushed.connection.hostName, "Gaming-PC");

  const inspected = await monitor.inspect({ userId: "user-1" });
  assert.equal(inspected.available, true);
  assert.equal(inspected.source, "external-pc");
  assert.equal(inspected.hostName, "Gaming-PC");
  assert.equal(inspected.warning, true);

  // Advance clock past TTL -> becomes stale with last known PC name
  clock += 65_000;
  const stale = await monitor.inspect({ userId: "user-1" });
  assert.equal(stale.available, false);
  assert.equal(stale.connection.stale, true);
  assert.equal(stale.connection.mode, "stale");
  assert.equal(stale.connection.hostName, "Gaming-PC");

  // Pull mode via ALFIE_VRAM_REMOTE_URL
  let capturedAuth = "";
  const pullMonitor = new VramMonitor({
    remoteUrl: "http://192.168.1.50:9100/vram",
    remoteToken: "pc-pull-secret-token",
    execFileImpl: async () => { throw new Error("no local GPU"); },
    fetchImpl: async (url, init) => {
      capturedAuth = init?.headers?.authorization || "";
      return new Response(JSON.stringify({ usedMb: 19661, totalMb: 24576, gpuName: "RTX 4090", hostName: "Workstation-PC" }), { status: 200 });
    }
  });
  const pulled = await pullMonitor.inspect({ userId: "user-1" });
  assert.equal(capturedAuth, "Bearer pc-pull-secret-token");
  assert.equal(pulled.available, true);
  assert.equal(pulled.warning, true);
  assert.equal(pulled.connection.mode, "external-pull");
  assert.equal(pulled.connection.hostName, "Workstation-PC");
});

test("POST /api/telemetry/vram enforces bearer token auth and streams external PC VRAM to authenticated Alfie users", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-ext-vram-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const serviceToken = "s".repeat(48);
  const standaloneSecret = "i".repeat(48);
  const vramReportToken = "pc-vram-bearer-secret-token-2026";

  const vramMonitor = new VramMonitor({
    reportTokenConfigured: true,
    execFileImpl: async () => { throw new Error("no local GPU on Proxmox"); },
    fetchImpl: async () => { throw new Error("no ollama"); }
  });

  const coreServer = createAlfieCoreServer({
    serviceToken,
    identityAuth: createSignedIdentityAuth({ secret: standaloneSecret, providerId: "standalone-ui" }),
    dataDirectory: path.join(tempDir, "core"),
    petrioHarnessClient: { enabled: false },
    vramMonitor
  });
  const coreUrl = await listen(coreServer);
  t.after(() => new Promise((r) => coreServer.close(r)));

  const authStore = new InterfaceAuthStore({ dataDirectory: path.join(tempDir, "ui") });
  await authStore.bootstrap("proxmoxadmin", "SuperStrongPassphrase2026!");
  const coreClient = createAlfieCoreClient({
    baseUrl: coreUrl,
    serviceToken,
    identityAuth: createSignedIdentityAuth({ secret: standaloneSecret, providerId: "standalone-ui" })
  });

  // Server without token configured fails closed with 503
  const unconfiguredUi = createAlfieInterfaceServer({
    authStore,
    coreClient,
    cookieSecure: false,
    allowLocalHttpOrigin: true,
    vramReportToken: ""
  });
  const unconfiguredUrl = await listen(unconfiguredUi);
  t.after(() => new Promise((r) => unconfiguredUi.close(r)));

  const unconfiguredRes = await fetch(`${unconfiguredUrl}/api/telemetry/vram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${vramReportToken}` },
    body: JSON.stringify({ percent: 84 })
  });
  assert.equal(unconfiguredRes.status, 503);

  // Configured Interface server
  const uiServer = createAlfieInterfaceServer({
    authStore,
    coreClient,
    cookieSecure: false,
    allowLocalHttpOrigin: true,
    vramReportToken
  });
  const uiUrl = await listen(uiServer);
  t.after(() => new Promise((r) => uiServer.close(r)));

  // Rejects missing or wrong token
  const missingTokenRes = await fetch(`${uiUrl}/api/telemetry/vram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent: 84 })
  });
  assert.equal(missingTokenRes.status, 401);

  const wrongTokenRes = await fetch(`${uiUrl}/api/telemetry/vram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong-token-1234567890" },
    body: JSON.stringify({ percent: 84 })
  });
  assert.equal(wrongTokenRes.status, 401);

  // Accepts valid external PC push
  const pushRes = await fetch(`${uiUrl}/api/telemetry/vram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${vramReportToken}` },
    body: JSON.stringify({
      gpuName: "NVIDIA GeForce RTX 4090",
      hostName: "Gaming-PC",
      usedMb: 20890,
      totalMb: 24576
    })
  });
  assert.equal(pushRes.status, 200);
  const pushJson = await pushRes.json();
  assert.equal(pushJson.ok, true);
  assert.equal(pushJson.vram.percent, 85);
  assert.equal(pushJson.vram.warning, true);

  // Authenticated browser user sees the external PC's VRAM immediately
  const loginRes = await fetch(`${uiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: uiUrl },
    body: JSON.stringify({ username: "proxmoxadmin", password: "SuperStrongPassphrase2026!" })
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await loginRes.json();

  const standaloneRes = await fetch(`${uiUrl}/api/auth/standalone`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: uiUrl, "x-csrf-token": csrfToken },
    body: JSON.stringify({})
  });
  assert.equal(standaloneRes.status, 201);

  const vramRes = await fetch(`${uiUrl}/api/core/system/vram`, {
    headers: { cookie }
  });
  assert.equal(vramRes.status, 200);
  const { vram } = await vramRes.json();
  assert.equal(vram.available, true);
  assert.equal(vram.gpuName, "NVIDIA GeForce RTX 4090");
  assert.equal(vram.hostName, "Gaming-PC");
  assert.equal(vram.percent, 85);
  assert.equal(vram.warning, true);
  assert.equal(vram.connection.mode, "external-push");
});
