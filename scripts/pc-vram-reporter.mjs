#!/usr/bin/env node
/**
 * Alfie External PC VRAM Reporter
 * Run this script on your GPU PC (Windows / Linux / macOS) to push live GPU VRAM
 * readings to Alfie running on your Proxmox server.
 *
 * Environment variables:
 *   ALFIE_URL                - Base URL of your Alfie server (e.g. http://192.168.1.20:3000)
 *   ALFIE_VRAM_REPORT_TOKEN  - Shared bearer token matching ALFIE_VRAM_REPORT_TOKEN on Proxmox
 *   ALFIE_PC_NAME            - Optional display name for this PC (defaults to OS hostname)
 *   ALFIE_VRAM_INTERVAL_MS   - Polling interval in ms (default: 5000, min: 2000)
 *
 * Usage:
 *   ALFIE_URL=http://192.168.1.20:3000 ALFIE_VRAM_REPORT_TOKEN=your-secret-token node scripts/pc-vram-reporter.mjs
 *   node scripts/pc-vram-reporter.mjs --once
 */

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const alfieUrl = String(process.env.ALFIE_URL || "").trim().replace(/\/+$/, "");
const token = String(process.env.ALFIE_VRAM_REPORT_TOKEN || "").trim();
const hostName = String(process.env.ALFIE_PC_NAME || os.hostname() || "External PC").trim().slice(0, 64);
const intervalMs = Math.max(2000, Number(process.env.ALFIE_VRAM_INTERVAL_MS) || 5000);
const runOnce = process.argv.includes("--once");

if (!alfieUrl) {
  console.error("[alfie-vram] Set ALFIE_URL (for example http://192.168.1.20:3000).");
  process.exit(1);
}
if (token.length < 16) {
  console.error("[alfie-vram] Set ALFIE_VRAM_REPORT_TOKEN (at least 16 characters, matching your Proxmox server).");
  process.exit(1);
}

let targetUrl;
try {
  targetUrl = new URL("/api/telemetry/vram", alfieUrl);
  if (!["http:", "https:"].includes(targetUrl.protocol)) throw new Error("Protocol must be http or https.");
} catch (error) {
  console.error(`[alfie-vram] Invalid ALFIE_URL: ${error.message}`);
  process.exit(1);
}

async function queryNvidiaSmi() {
  const { stdout } = await execFileAsync(
    "nvidia-smi",
    ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
    { timeout: 3000, maxBuffer: 64 * 1024 }
  );
  const gpus = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [gpuName, usedRaw, totalRaw] = line.split(",").map((part) => part.trim());
      const usedMb = Number(usedRaw);
      const totalMb = Number(totalRaw);
      if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) return null;
      return {
        gpuName: gpuName || "NVIDIA GPU",
        usedMb: Math.round(usedMb),
        totalMb: Math.round(totalMb),
        percent: Math.round((usedMb / totalMb) * 1000) / 10
      };
    })
    .filter(Boolean);

  if (!gpus.length) {
    throw new Error("nvidia-smi returned no GPU memory readings.");
  }
  gpus.sort((a, b) => b.percent - a.percent);
  return gpus[0];
}

async function pushReading() {
  const reading = await queryNvidiaSmi();
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      ...reading,
      hostName,
      source: "external-pc"
    }),
    signal: AbortSignal.timeout(4000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Alfie returned HTTP ${response.status}`);
  }
  const vram = payload.vram || reading;
  console.log(
    `[alfie-vram] ${hostName} · ${vram.gpuName}: ${vram.percent}% (${vram.usedMb}/${vram.totalMb} MB)${vram.warning ? " [WARNING >= 80%]" : ""}`
  );
}

async function main() {
  if (runOnce) {
    await pushReading();
    return;
  }
  console.log(`[alfie-vram] Reporting GPU VRAM from "${hostName}" to ${targetUrl.origin} every ${intervalMs}ms...`);
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    try {
      await pushReading();
    } catch (error) {
      console.error(`[alfie-vram] Report failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error(`[alfie-vram] Fatal: ${error.message}`);
  process.exit(1);
});
