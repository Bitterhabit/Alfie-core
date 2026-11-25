import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowProfileStore, buildWorkflowProfilePrompt } from "../src/profile/store.mjs";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";
import { AgentLoop } from "../src/agent/loop.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

test("WorkflowProfileStore persists preferences, validates enums, manages learning topics, and isolates users", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-profile-"));
  const store = new WorkflowProfileStore({ dataDirectory: dir });

  const initial = await store.get("alice");
  assert.equal(initial.explanationStyle, "balanced");
  assert.equal(initial.learningMode, "explain");
  assert.deepEqual(initial.learningTopics, []);

  // Reject invalid enum values
  await assert.rejects(() => store.update("alice", { learningMode: "godmode" }), (err) => err.status === 400);
  await assert.rejects(() => store.update("alice", { explanationStyle: "verbose_max" }), (err) => err.status === 400);

  const updated = await store.update("alice", {
    explanationStyle: "concise",
    changePresentation: "step_by_step",
    interruptionTolerance: "quiet",
    chunkSize: "large_chunks",
    learningMode: "attempt_first",
    customNotes: "Show rollback commands before proposing destructive changes."
  });
  assert.equal(updated.explanationStyle, "concise");
  assert.equal(updated.learningMode, "attempt_first");
  assert.match(updated.customNotes, /rollback commands/);

  // Learning topics CRUD + duplicate check
  const added = await store.addTopic("alice", { topic: "Rust ownership", confidence: "practicing", notes: "Lifetimes in async traits" });
  assert.equal(added.topic.topic, "Rust ownership");
  assert.equal(added.topic.confidence, "practicing");

  await assert.rejects(() => store.addTopic("alice", { topic: "rust ownership" }), (err) => err.status === 409);

  const promoted = await store.updateTopic("alice", added.topic.id, { confidence: "comfortable" });
  assert.equal(promoted.topic.confidence, "comfortable");

  // Bob remains completely isolated
  const bobProfile = await store.get("bob");
  assert.equal(bobProfile.learningMode, "explain");
  assert.equal(bobProfile.learningTopics.length, 0);

  // Prompt block enforces non-escalation guarantee and includes qualitative learning areas
  const prompt = buildWorkflowProfilePrompt(promoted.profile);
  assert.match(prompt, /never escalates permissions or bypasses approvals/i);
  assert.match(prompt, /Attempt first/i);
  assert.match(prompt, /Rust ownership \(comfortable\)/i);

  const removed = await store.removeTopic("alice", added.topic.id);
  assert.equal(removed.deleted, true);
  assert.equal(removed.profile.learningTopics.length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test("ContextAssembler and AgentLoop inject WorkflowProfile and surface learningMode in turn provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-profile-loop-"));
  const profileStore = new WorkflowProfileStore({ dataDirectory: dir });
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher({ registry, permissionStore, pendingActionStore });

  await profileStore.update("alice", { learningMode: "challenge", explanationStyle: "deep" });
  await profileStore.addTopic("alice", { topic: "eBPF tracing", confidence: "exploring" });

  let capturedSystem = "";
  const providerRegistry = {
    async complete(_config, messages) {
      capturedSystem = messages.find((m) => m.role === "system")?.content || "";
      return {
        endpoint: { id: "local-test", name: "Local Test", provider: "ollama", model: "qwen2.5:14b" },
        result: {
          content: JSON.stringify({ type: "final", message: "Before I show the eBPF map layout, what hook point would you pick first?" }),
          raw: { usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 } }
        }
      };
    }
  };

  const loop = new AgentLoop({
    providerRegistry,
    providerConfig: { endpoints: [{ id: "local-test", enabled: true, model: "qwen2.5:14b" }] },
    toolRegistry: registry,
    dispatcher,
    memoryStore,
    profileStore,
    contextAssembler: new ContextAssembler()
  });

  const turn = await loop.run({
    userId: "alice",
    messages: [{ role: "user", content: "How do I trace TCP retransmits with eBPF?" }],
    workingMode: "tutor",
    agentProvider: "local"
  });

  assert.match(capturedSystem, /Challenge me/i);
  assert.match(capturedSystem, /eBPF tracing \(exploring\)/i);
  assert.equal(turn.provenance.learningMode.id, "challenge");
  assert.equal(turn.provenance.learningMode.label, "Challenge me");

  await fs.rm(dir, { recursive: true, force: true });
});

test("WorkflowProfileStore validates, persists, injects, and clears opt-in user location", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-profile-loc-"));
  const store = new WorkflowProfileStore({ dataDirectory: dir });
  try {
    const initial = await store.get("alice");
    assert.equal(initial.location.enabled, false);
    assert.equal(initial.location.label, "");

    // Invalid coordinates are rejected
    await assert.rejects(() => store.update("alice", { location: { enabled: true, latitude: 120, longitude: 0 } }), (err) => err.status === 400);
    await assert.rejects(() => store.update("alice", { location: { enabled: true, latitude: 53.4, longitude: -220 } }), (err) => err.status === 400);

    const saved = await store.update("alice", {
      location: { enabled: true, label: "Manchester, UK", latitude: 53.4808, longitude: -2.2426, timezone: "Europe/London" }
    });
    assert.equal(saved.location.enabled, true);
    assert.equal(saved.location.label, "Manchester, UK");
    assert.equal(saved.location.latitude, 53.4808);
    assert.equal(saved.location.longitude, -2.2426);

    const promptWithLoc = buildWorkflowProfilePrompt(saved);
    assert.match(promptWithLoc, /User saved location \(opt-in\): Manchester, UK/);
    assert.match(promptWithLoc, /53\.4808, -2\.2426/);

    // Clearing location disables and removes it from prompt
    const cleared = await store.update("alice", { location: null });
    assert.equal(cleared.location.enabled, false);
    assert.equal(cleared.location.label, "");
    assert.equal(cleared.location.latitude, null);
    assert.doesNotMatch(buildWorkflowProfilePrompt(cleared), /User saved location/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
