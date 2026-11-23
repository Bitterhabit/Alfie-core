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
