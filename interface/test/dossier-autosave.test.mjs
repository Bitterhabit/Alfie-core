import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDossierDraft,
  fingerprintDossierDraft,
  createDossierAutoSaver
} from "../public/dossier-autosave.mjs";

function createManualTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    pendingCount() {
      return tasks.size;
    },
    fireAll() {
      const entries = [...tasks.entries()];
      tasks.clear();
      for (const [, task] of entries) task.fn();
    }
  };
}

test("createDossierAutoSaver debounces rapid typing into a single persist call", async () => {
  const timers = createManualTimers();
  const calls = [];
  const states = [];
  const saver = createDossierAutoSaver({
    debounceMs: 600,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => "2026-11-24T14:40:00.000Z",
    persist: async (projectId, payload) => {
      calls.push({ projectId, payload });
      return { project: { id: projectId, ...payload } };
    },
    onStateChange: (snap) => states.push(snap.state)
  });

  saver.reset("proj-1", { name: "Homelab", description: "Initial" });
  assert.equal(saver.getStatus().state, "idle");

  // Typing 3 rapid edits should reset the debounce timer and fire only once
  saver.schedule({ name: "Homelab", description: "Initial a" });
  saver.schedule({ name: "Homelab", description: "Initial ab" });
  saver.schedule({ name: "Homelab", description: "Initial abc" });
  assert.equal(timers.pendingCount(), 1);
  assert.equal(calls.length, 0);
  assert.equal(saver.getStatus().state, "pending");

  timers.fireAll();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, "proj-1");
  assert.equal(calls[0].payload.description, "Initial abc");
  assert.equal(saver.getStatus().state, "saved");
  assert.equal(saver.getStatus().savedAt, "2026-11-24T14:40:00.000Z");
  assert.ok(states.includes("pending"));
  assert.ok(states.includes("saving"));
  assert.ok(states.includes("saved"));
});

test("createDossierAutoSaver skips no-op edits, pauses on empty name, and ignores unsaved new projects", async () => {
  const timers = createManualTimers();
  const calls = [];
  const saver = createDossierAutoSaver({
    debounceMs: 500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    persist: async (projectId, payload) => {
      calls.push({ projectId, payload });
    }
  });

  // Disabled when creating a brand new project (no projectId)
  saver.reset("", null);
  assert.equal(saver.getStatus().state, "disabled");
  assert.equal(saver.schedule({ name: "Draft" }), false);
  assert.equal(timers.pendingCount(), 0);

  // Editing an existing project: reverting back to baseline cancels pending save
  saver.reset("proj-2", { name: "Alpha", architecture: "SQLite WAL" });
  saver.schedule({ name: "Alpha", architecture: "SQLite WAL + backup" });
  assert.equal(timers.pendingCount(), 1);
  saver.schedule({ name: "Alpha", architecture: "SQLite WAL" });
  assert.equal(timers.pendingCount(), 0);
  assert.equal(saver.getStatus().state, "idle");

  // Empty name pauses auto-save gracefully without calling backend
  assert.equal(saver.schedule({ name: "   ", architecture: "SQLite WAL" }), false);
  assert.equal(saver.getStatus().state, "invalid");
  assert.equal(calls.length, 0);
});

test("createDossierAutoSaver serializes overlapping edits during in-flight save and flushes pending edits on close", async () => {
  const timers = createManualTimers();
  const calls = [];
  const resolvers = [];

  const saver = createDossierAutoSaver({
    debounceMs: 500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    persist: (projectId, payload) => {
      calls.push({ projectId, payload });
      return new Promise((resolve) => resolvers.push(resolve));
    }
  });

  saver.reset("proj-3", { name: "Gamma", vision: "v0" });
  saver.schedule({ name: "Gamma", vision: "v1" });
  timers.fireAll();

  // First save is now in flight
  assert.equal(calls.length, 1);
  assert.equal(saver.getStatus().inFlight, true);

  // User keeps typing while first save is still in flight
  saver.schedule({ name: "Gamma", vision: "v2" });
  assert.equal(calls.length, 1, "Must not issue concurrent overlapping PATCH calls");

  // Flush immediately (simulating modal close while typing)
  const flushPromise = saver.flush();
  // Resolve the first in-flight save -> queued v2 should immediately kick off
  resolvers.shift()({ project: { id: "proj-3", name: "Gamma", vision: "v1" } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.vision, "v2");

  resolvers.shift()({ project: { id: "proj-3", name: "Gamma", vision: "v2" } });
  await flushPromise;
  assert.equal(saver.getStatus().state, "saved");
  assert.equal(saver.getStatus().dirty, false);
});

test("createDossierAutoSaver isolates sessions on reset and reports errors cleanly without losing draft", async () => {
  const timers = createManualTimers();
  let shouldFail = true;
  let staleResolve;
  const saver = createDossierAutoSaver({
    debounceMs: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    persist: (projectId) => {
      if (projectId === "proj-stale") {
        return new Promise((resolve) => { staleResolve = resolve; });
      }
      if (shouldFail) return Promise.reject(new Error("A project with that name already exists."));
      return Promise.resolve({ project: { id: projectId } });
    }
  });

  // Stale request from previous project must not overwrite new project session state
  saver.reset("proj-stale", { name: "Old" });
  saver.schedule({ name: "Old Updated" });
  timers.fireAll();
  saver.reset("proj-fresh", { name: "Fresh" });
  staleResolve?.({ project: { id: "proj-stale" } });
  await Promise.resolve();
  assert.equal(saver.getStatus().projectId, "proj-fresh");
  assert.equal(saver.getStatus().state, "idle");

  // Error transitions cleanly to error state and recovers on next valid edit
  saver.schedule({ name: "Duplicate" });
  timers.fireAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saver.getStatus().state, "error");
  assert.match(saver.getStatus().error, /already exists/i);

  shouldFail = false;
  saver.schedule({ name: "Unique Name" });
  timers.fireAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saver.getStatus().state, "saved");

  // Helpers produce deterministic normalized fingerprints
  assert.equal(
    fingerprintDossierDraft(normalizeDossierDraft({ name: "  Test  ", nextActions: "a\r\nb" })),
    fingerprintDossierDraft({ name: "Test", nextActions: "a\nb", status: "active", color: "purple" })
  );
});
