import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AsyncJobStore, DEFAULT_JOB_DURATION_MS, MAX_JOB_DURATION_MS } from "../src/jobs/engine.mjs";

test("durable jobs default to a 30-minute budget and cannot exceed it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-jobs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AsyncJobStore({ dataDirectory: directory });
  const defaultJob = await store.create("user-1", { title: "Long-running task" });
  assert.equal(defaultJob.budget.maxDurationMs, DEFAULT_JOB_DURATION_MS);
  assert.equal(DEFAULT_JOB_DURATION_MS, 30 * 60 * 1000);
  assert.equal(MAX_JOB_DURATION_MS, 30 * 60 * 1000);

  const boundedJob = await store.create("user-1", {
    title: "Bounded task",
    maxDurationMs: 60 * 60 * 1000
  });
  assert.equal(boundedJob.budget.maxDurationMs, MAX_JOB_DURATION_MS);
});


test("background worker runs queued handlers independently and persists the result", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-worker-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AsyncJobStore({ dataDirectory: directory });
  const engine = new (await import("../src/jobs/engine.mjs")).AsyncJobEngine({ jobStore: store });
  let release;
  let started = false;
  engine.registerHandler("test_background", async () => [{
    name: "wait for external work",
    async run({ context }) {
      started = true;
      await new Promise((resolve) => { release = resolve; });
      context.summary = "Background work completed.";
      return { summary: "Completed test work." };
    }
  }]);

  const job = await store.create("user-worker", { kind: "test_background", title: "Independent task" });
  engine.enqueue("user-worker", job);
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(started, true);
  assert.equal((await store.get("user-worker", job.id)).status, "running");

  release();
  let result = await store.get("user-worker", job.id);
  for (let attempt = 0; attempt < 100 && result.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await store.get("user-worker", job.id);
  }
  assert.equal(result.status, "completed");
  assert.equal(result.artifact.summary, "Background work completed.");
});

test("worker recovery interrupts unsafe running work and requeues only queued typed tasks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-worker-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AsyncJobStore({ dataDirectory: directory });
  const { AsyncJobEngine } = await import("../src/jobs/engine.mjs");
  const engine = new AsyncJobEngine({ jobStore: store });
  let executions = 0;
  engine.registerHandler("safe_test", async () => [{
    name: "safe queued work",
    async run({ context }) {
      executions += 1;
      context.summary = "Recovered queued task.";
      return { summary: "Recovered queued task." };
    }
  }]);

  const interrupted = await store.create("user-recovery", { title: "Was running" });
  await store.update("user-recovery", interrupted.id, (job) => ({ ...job, status: "running" }));
  const queued = await store.create("user-recovery", { kind: "safe_test", title: "Still queued" });

  await engine.recoverUser("user-recovery");
  assert.equal((await store.get("user-recovery", interrupted.id)).status, "interrupted");
  let result = await store.get("user-recovery", queued.id);
  for (let attempt = 0; attempt < 100 && result.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await store.get("user-recovery", queued.id);
  }
  assert.equal(result.status, "completed");
  assert.equal(executions, 1);
});
