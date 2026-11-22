import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateWatcherUrl, isWithinQuietHours, routeAttentionTier } from "../src/watchers/engine.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { VramMonitor } from "../src/system/vramMonitor.mjs";

test("validateWatcherUrl blocks loopback, RFC1918, metadata, IPv6 private, and non-HTTP schemes", () => {
  const blocked = [
    "http://localhost:8080/health",
    "http://sub.localhost/test",
    "http://127.0.0.1:3000/api",
    "http://10.0.0.12/status",
    "http://172.16.4.2/status",
    "http://192.168.1.50/status",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.100.100.200/latest/meta-data/",
    "http://[::1]:8080/status",
    "http://[fe80::1]/status",
    "http://[fc00::1]/status",
    "http://[::ffff:127.0.0.1]/status",
    "file:///etc/passwd",
    "https://user:pass@example.com/health",
    "https://example.com/health#frag"
  ];
  for (const url of blocked) {
    const result = validateWatcherUrl(url);
    assert.equal(result.valid, false, `Expected ${url} to be blocked`);
  }

  const allowed = validateWatcherUrl("https://status.example.com/health?ok=1");
  assert.equal(allowed.valid, true);
  assert.equal(allowed.url, "https://status.example.com/health?ok=1");
});

test("routeAttentionTier enforces 4-tier attention budget, quiet hours, and cooldown deduplication", () => {
  // Nominal checks always route to quiet_log
  const okRoute = routeAttentionTier({ baseTier: "urgent", severity: "ok" });
  assert.equal(okRoute.tier, "quiet_log");
  assert.equal(okRoute.suppressed, false);

  // Overnight quiet hours (22:00-07:00 UTC) downgrade notify -> digest, but urgent breaks through
  const nightMs = Date.parse("2026-06-01T23:30:00.000Z");
  assert.equal(isWithinQuietHours({ enabled: true, start: "22:00", end: "07:00" }, new Date(nightMs)), true);
  const quietNotify = routeAttentionTier({
    baseTier: "notify",
    severity: "alert",
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
    nowMs: nightMs
  });
  assert.equal(quietNotify.tier, "digest");
  assert.equal(quietNotify.reason, "quiet_hours_downgrade");

  const quietUrgent = routeAttentionTier({
    baseTier: "urgent",
    severity: "alert",
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
    nowMs: nightMs
  });
  assert.equal(quietUrgent.tier, "urgent");

  // Cooldown deduplication suppresses identical fingerprints within cooldown window
  const deduped = routeAttentionTier({
    baseTier: "urgent",
    severity: "alert",
    nowMs: nightMs + 5 * 60 * 1000,
    lastNotifiedAt: new Date(nightMs).toISOString(),
    cooldownMinutes: 30,
    sameFingerprint: true
  });
  assert.equal(deduped.tier, "quiet_log");
  assert.equal(deduped.suppressed, true);
  assert.equal(deduped.reason, "cooldown_dedup");
});

test("WatcherStore runs deterministic checks, stamps external_untrusted provenance, and isolates users", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-watchers-"));
  let currentMs = Date.parse("2026-06-15T12:00:00.000Z");
  const nowMs = () => currentMs;
  const nowIso = () => new Date(currentMs).toISOString();

  const watcherStore = new WatcherStore({ dataDirectory: dir, now: nowMs });
  const projectStore = new ProjectStore({ dataDirectory: dir, now: nowIso });
  const vramMonitor = new VramMonitor({ now: nowMs, disableLocalProbe: true });

  // Create a project with a blocker so project_stall watcher triggers an alert
  const project = await projectStore.create("user-a", {
    name: "Proxmox Backup Pipeline",
    status: "active",
    blockers: ["Waiting for offsite ZFS replication key"]
  });

  const projectWatcher = await watcherStore.create("user-a", {
    name: "Active Project Monitor",
    kind: "project_stall",
    tier: "digest",
    cooldownMinutes: 30,
    config: { staleDays: 7, projectId: project.id }
  });

  const check1 = await watcherStore.runCheck("user-a", projectWatcher.id, { projectStore });
  assert.equal(check1.event.severity, "alert");
  assert.equal(check1.event.tier, "digest");
  assert.equal(check1.event.trust, "system_verified");
  assert.equal(check1.event.acknowledged, false);

  // Immediate repeat check within cooldown deduplicates to quiet_log
  currentMs += 5 * 60 * 1000;
  const check2 = await watcherStore.runCheck("user-a", projectWatcher.id, { projectStore });
  assert.equal(check2.event.suppressed, true);
  assert.equal(check2.event.tier, "quiet_log");

  // Push metric watcher stamps ADR-003 external_untrusted provenance
  const backupWatcher = await watcherStore.create("user-a", {
    name: "Nightly Backup Age",
    kind: "push_metric",
    tier: "urgent",
    cooldownMinutes: 15,
    config: { metricName: "backup_age_hours", operator: "gte", threshold: 24, unit: "hrs" }
  });
  const pushAlert = await watcherStore.ingestMetric("user-a", backupWatcher.id, { value: 30, note: "PBS sync missed" });
  assert.equal(pushAlert.event.severity, "alert");
  assert.equal(pushAlert.event.tier, "urgent");
  assert.equal(pushAlert.event.trust, "external_untrusted");

  // Acknowledge event
  const acked = await watcherStore.acknowledgeEvent("user-a", pushAlert.event.id);
  assert.equal(acked.acknowledged, true);

  // VRAM threshold watcher triggers when reported VRAM >= threshold
  vramMonitor.report("user-a", { percent: 88, gpuName: "RTX 4090" });
  const vramWatcher = await watcherStore.create("user-a", {
    name: "GPU VRAM Guard",
    kind: "vram_threshold",
    tier: "notify",
    config: { thresholdPercent: 80 }
  });
  const vramCheck = await watcherStore.runCheck("user-a", vramWatcher.id, { vramMonitor });
  assert.equal(vramCheck.event.severity, "alert");
  assert.equal(vramCheck.event.tier, "notify");
  assert.equal(vramCheck.event.trust, "system_verified");

  // HTTP probe rejects private URL on creation
  await assert.rejects(
    () => watcherStore.create("user-a", {
      name: "Blocked Metadata Probe",
      kind: "http_probe",
      config: { url: "http://169.254.169.254/latest/meta-data/" }
    }),
    (err) => err.status === 400 && err.code === "WATCHER_URL_BLOCKED"
  );

  // Strict per-user isolation
  const userBWatchers = await watcherStore.list("user-b");
  assert.equal(userBWatchers.length, 0);
  await assert.rejects(() => watcherStore.get("user-b", projectWatcher.id), (err) => err.status === 404);

  await fs.rm(dir, { recursive: true, force: true });
});


test("WatcherStore serializes overlapping checks for the same watcher", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-watcher-race-"));
  const watcherStore = new WatcherStore({ dataDirectory: dir });
  const watcher = await watcherStore.create("race-user", {
    name: "Concurrent GPU Monitor",
    kind: "vram_threshold",
    tier: "notify",
    config: { thresholdPercent: 80 }
  });

  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let firstEntered;
  const firstStarted = new Promise((resolve) => { firstEntered = resolve; });
  const monitor = {
    async inspect() {
      calls += 1;
      const call = calls;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (call === 1) firstEntered();
      try {
        if (call === 1) await new Promise((resolve) => setTimeout(resolve, 40));
        return { available: true, percent: call === 1 ? 95 : 55, gpuName: "Test GPU" };
      } finally {
        active -= 1;
      }
    }
  };

  try {
    const first = watcherStore.runCheck("race-user", watcher.id, { vramMonitor: monitor });
    await firstStarted;
    const second = watcherStore.runCheck("race-user", watcher.id, { vramMonitor: monitor });
    await Promise.all([first, second]);

    assert.equal(calls, 2);
    assert.equal(maxActive, 1, "checks for one watcher must not overlap");
    const finalWatcher = await watcherStore.get("race-user", watcher.id);
    assert.equal(finalWatcher.lastStatus, "ok");
    assert.match(finalWatcher.lastSummary, /55%/);
    const events = await watcherStore.listEvents("race-user", { limit: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].severity, "ok");
    assert.equal(events[1].severity, "alert");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("WatcherStore serializes edits and deletion with in-flight checks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-watcher-mutations-"));
  const watcherStore = new WatcherStore({ dataDirectory: dir });
  const watcher = await watcherStore.create("mutation-user", {
    name: "Mutable GPU Monitor",
    kind: "vram_threshold",
    tier: "notify",
    config: { thresholdPercent: 80 }
  });

  const originalExclusive = watcherStore.exclusive.bind(watcherStore);
  let trackExclusive = false;
  let exclusiveCalls = 0;
  watcherStore.exclusive = (userId, operation) => {
    if (trackExclusive) exclusiveCalls += 1;
    return originalExclusive(userId, operation);
  };

  let releaseInspect;
  let signalInspect;
  const inspectStarted = new Promise((resolve) => { signalInspect = resolve; });
  const inspectGate = new Promise((resolve) => { releaseInspect = resolve; });
  const monitor = {
    async inspect() {
      signalInspect();
      await inspectGate;
      return { available: true, percent: 95, gpuName: "Test GPU" };
    }
  };
  let releaseSecondInspect;

  try {
    const check = watcherStore.runCheck("mutation-user", watcher.id, { vramMonitor: monitor });
    await inspectStarted;
    trackExclusive = true;
    const update = watcherStore.update("mutation-user", watcher.id, { enabled: false });
    await Promise.resolve();
    assert.equal(exclusiveCalls, 0, "update must wait for the active check lock");
    releaseInspect();
    await Promise.all([check, update]);
    assert.equal((await watcherStore.get("mutation-user", watcher.id)).enabled, false);

    let signalSecondInspect;
    const secondStarted = new Promise((resolve) => { signalSecondInspect = resolve; });
    const secondGate = new Promise((resolve) => { releaseSecondInspect = resolve; });
    const secondMonitor = {
      async inspect() {
        signalSecondInspect();
        await secondGate;
        return { available: true, percent: 55, gpuName: "Test GPU" };
      }
    };
    const secondCheck = watcherStore.runCheck("mutation-user", watcher.id, { vramMonitor: secondMonitor });
    await secondStarted;
    exclusiveCalls = 0;
    const remove = watcherStore.remove("mutation-user", watcher.id);
    await Promise.resolve();
    assert.equal(exclusiveCalls, 0, "deletion must wait for the active check lock");
    releaseSecondInspect();
    await Promise.all([secondCheck, remove]);
    await assert.rejects(() => watcherStore.get("mutation-user", watcher.id), (error) => error.status === 404);
  } finally {
    releaseInspect();
    releaseSecondInspect?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
