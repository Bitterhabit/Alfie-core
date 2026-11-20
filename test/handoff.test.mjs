import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffBrief, nextContinuationTitle } from "../src/conversations/handoff.mjs";
import { VramMonitor, parseNvidiaSmiCsv, parseOllamaPs } from "../src/system/vramMonitor.mjs";

test("nextContinuationTitle increments part numbers cleanly and stays within 120 chars", () => {
  assert.equal(nextContinuationTitle("Audio Engine"), "Audio Engine (Part 2)");
  assert.equal(nextContinuationTitle("Audio Engine (Part 2)"), "Audio Engine (Part 3)");
  assert.equal(nextContinuationTitle("Audio Engine (Part 9)"), "Audio Engine (Part 10)");
  const veryLong = "A".repeat(140);
  const next = nextContinuationTitle(veryLong);
  assert.ok(next.length <= 120);
  assert.ok(next.endsWith(" (Part 2)"));
});

test("buildHandoffBrief captures project metadata, goals, asset paths, and recent turns within maxChars", () => {
  const brief = buildHandoffBrief(
    {
      id: "11111111-1111-1111-1111-111111111111",
      title: "Boss Arena Lighting",
      projectId: "22222222-2222-2222-2222-222222222222",
      messages: [
        { role: "user", content: "Design atmospheric torch lighting for the dungeon boss room." },
        { role: "assistant", content: "Saved concept sprite at /api/core/images/torch-concept.png with warm amber falloff." },
        { role: "user", content: "Now optimize the shadow map resolution for 8GB GPUs." },
        { role: "assistant", content: "Use a 1024x1024 PCF atlas and clamp point light radius to 9 units." }
      ]
    },
    {
      project: {
        id: "22222222-2222-2222-2222-222222222222",
        name: "Dungeon Crawler",
        description: "60fps target on mid-range GPUs."
      },
      reason: "vram_threshold",
      maxChars: 1200
    }
  );

  assert.equal(brief.title, "Boss Arena Lighting (Part 2)");
  assert.equal(brief.projectName, "Dungeon Crawler");
  assert.ok(brief.summary.length <= 1200);
  assert.match(brief.summary, /Dungeon Crawler/);
  assert.match(brief.summary, /60fps target/);
  assert.match(brief.summary, /\/api\/core\/images\/torch-concept\.png/);
  assert.match(brief.summary, /1024x1024 PCF atlas/);
  assert.match(brief.summary, /high VRAM usage/i);
});

test("parseNvidiaSmiCsv selects the highest-utilization GPU", () => {
  const parsed = parseNvidiaSmiCsv([
    "NVIDIA GeForce RTX 4060, 4096, 8192",
    "NVIDIA GeForce RTX 4090, 20480, 24576"
  ].join("\n"));

  assert.ok(parsed);
  assert.equal(parsed.available, true);
  assert.equal(parsed.source, "nvidia-smi");
  assert.equal(parsed.gpuName, "NVIDIA GeForce RTX 4090");
  assert.equal(parsed.usedMb, 20480);
  assert.equal(parsed.totalMb, 24576);
  assert.equal(parsed.percent, 83.3);
  assert.equal(parsed.gpus.length, 2);
});

test("parseOllamaPs sums model VRAM bytes and computes percentage when totalMb is known", () => {
  const payload = {
    models: [
      { name: "qwen2.5-coder:14b", size_vram: 10 * 1024 * 1024 * 1024 },
      { name: "nomic-embed-text", size_vram: 1 * 1024 * 1024 * 1024 }
    ]
  };
  const withTotal = parseOllamaPs(payload, 12288);
  assert.equal(withTotal.available, true);
  assert.equal(withTotal.usedMb, 11264);
  assert.equal(withTotal.totalMb, 12288);
  assert.equal(withTotal.percent, 91.7);
  assert.equal(withTotal.modelsLoaded.length, 2);

  const withoutTotal = parseOllamaPs(payload, null);
  assert.equal(withoutTotal.available, false);
  assert.equal(withoutTotal.usedMb, 11264);
});

test("VramMonitor triggers warning at 80% threshold, honors TTL on reported readings, and falls back cleanly", async () => {
  let currentTime = 1_700_000_000_000;
  const monitor = new VramMonitor({
    thresholdPercent: 80,
    reportTtlMs: 30_000,
    now: () => currentTime,
    execFileImpl: async () => ({ stdout: "NVIDIA RTX 3090, 19661, 24576\n" }),
    fetchImpl: async () => { throw new Error("offline"); }
  });

  // Exactly 80.0% from nvidia-smi triggers warning
  const live = await monitor.inspect({ userId: "u1" });
  assert.equal(live.available, true);
  assert.equal(live.percent, 80);
  assert.equal(live.warning, true);

  // User-reported 65% overrides temporarily and clears warning
  const lowReport = monitor.report("u1", { percent: 65, totalMb: 24576, gpuName: "RTX 3090" });
  assert.equal(lowReport.warning, false);
  const inspectedLow = await monitor.inspect({ userId: "u1" });
  assert.equal(inspectedLow.percent, 65);
  assert.equal(inspectedLow.warning, false);

  // Advance clock past TTL -> expires reported reading and falls back to live probe (80%)
  currentTime += 31_000;
  const afterExpiry = await monitor.inspect({ userId: "u1" });
  assert.equal(afterExpiry.source, "nvidia-smi");
  assert.equal(afterExpiry.warning, true);

  // Clear report + no probes returns honest unavailable
  const offlineMonitor = new VramMonitor({
    execFileImpl: async () => { throw new Error("missing"); },
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const unavailable = await offlineMonitor.inspect({ userId: "u1" });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.warning, false);
  assert.equal(unavailable.source, "unavailable");
});
