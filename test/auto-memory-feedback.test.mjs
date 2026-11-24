import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeResponseStyle,
  applyReactionDelta,
  containsSensitiveMaterial,
  createDefaultLearnedStyle,
  extractAutoMemories,
  summarizeLearnedStyle
} from "../src/memory/autoMemory.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { WorkflowProfileStore, buildWorkflowProfilePrompt } from "../src/profile/store.mjs";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";
import { AgentLoop } from "../src/agent/loop.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";

test("extractAutoMemories captures durable preferences, facts, and decisions while ignoring noise", () => {
  const pref = extractAutoMemories("I prefer concise replies with rollback commands included.");
  assert.equal(pref.length, 1);
  assert.equal(pref[0].kind, "preference");
  assert.match(pref[0].text, /concise replies/i);
  assert.ok(pref[0].tags.includes("auto-memory"));

  const multi = extractAutoMemories("My name is Peter. I run Proxmox on my homelab. Can you explain Docker volumes?", { projectName: "Homelab Ops" });
  assert.equal(multi.length, 2);
  assert.equal(multi[0].kind, "fact");
  assert.match(multi[0].text, /Peter/);
  assert.equal(multi[1].kind, "fact");
  assert.match(multi[1].text, /Proxmox/);
  assert.ok(multi[1].tags.includes("project:homelab-ops"));

  const decision = extractAutoMemories("We decided to keep Node.js as the single authoritative runtime.");
  assert.equal(decision.length, 1);
  assert.equal(decision[0].kind, "decision");

  assert.deepEqual(extractAutoMemories("/idea Add dark nebula theme"), []);
  assert.deepEqual(extractAutoMemories("Can you write a bash script to back up Postgres?"), []);
  assert.deepEqual(extractAutoMemories("Hello there!"), []);
});

test("extractAutoMemories strictly blocks secrets, API keys, passwords, and private keys", () => {
  assert.equal(containsSensitiveMaterial("Remember that my API key is sk-proj-1234567890abcdef"), true);
  assert.deepEqual(extractAutoMemories("Remember that my API key is sk-proj-1234567890abcdef"), []);
  assert.deepEqual(extractAutoMemories("Remember that my password is SuperSecretPassword99!"), []);
  assert.deepEqual(extractAutoMemories("Note that Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig1234567890"), []);
  assert.deepEqual(extractAutoMemories("Remember that ghp_1234567890abcdefghijklmnop is my GitHub token"), []);
});

test("analyzeResponseStyle and applyReactionDelta learn cross-session taste and handle toggles cleanly", () => {
  const shortCodeReply = "Run this command:\n```bash\ndocker compose up -d --build\n```\n1. Verify `/health`.\n2. Rollback if needed.";
  const traits = analyzeResponseStyle(shortCodeReply);
  assert.ok(traits.includes("concise"));
  assert.ok(traits.includes("codeExamples"));
  assert.ok(traits.includes("stepByStep"));

  let state = createDefaultLearnedStyle();
  const liked = applyReactionDelta(state, { reaction: "like", previousReaction: null, content: shortCodeReply });
  state = liked.learnedStyle;
  assert.equal(state.likes, 1);
  assert.equal(state.traits.concise, 1);
  assert.equal(state.traits.codeExamples, 1);
  assert.ok(liked.signals.includes("Concise replies"));

  // Switching from like -> flag reverses +1 and applies -1 (net -1).
  const switched = applyReactionDelta(state, { reaction: "flag", previousReaction: "like", content: shortCodeReply });
  state = switched.learnedStyle;
  assert.equal(state.likes, 0);
  assert.equal(state.flags, 1);
  assert.equal(state.traits.concise, -1);

  // Clearing flag returns to neutral 0.
  const cleared = applyReactionDelta(state, { reaction: null, previousReaction: "flag", content: shortCodeReply });
  state = cleared.learnedStyle;
  assert.equal(state.flags, 0);
  assert.equal(state.traits.concise, 0);

  // Flagging a long wall of text teaches Alfie to avoid overly verbose walls of text.
  const longWall = "Detailed technical background. ".repeat(45);
  const flaggedLong = applyReactionDelta(state, { reaction: "flag", previousReaction: null, content: longWall });
  const summary = summarizeLearnedStyle(flaggedLong.learnedStyle);
  assert.ok(summary.promptHints.some((h) => /Avoid long walls of text/i.test(h)));
});

test("AgentLoop auto-captures memories, avoids duplicates, recalls core preferences on unrelated turns, and respects toggle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-auto-mem-"));
  const userId = "user-auto-mem-1";
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const profileStore = new WorkflowProfileStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const toolRegistry = new ToolRegistry();
  const contextAssembler = new ContextAssembler();

  const seenSystemPrompts = [];
  const providerRegistry = {
    async complete(_config, messages) {
      seenSystemPrompts.push(messages[0]?.content || "");
      return {
        endpoint: { id: "local-mock", model: "mock-model", provider: "ollama" },
        result: { content: JSON.stringify({ type: "final", message: "Got it — noted and ready to help." }) }
      };
    }
  };
  const dispatcher = {
    permissionStore,
    resetTurn() {},
    async dispatch() { return { status: "completed", result: {} }; }
  };

  const loop = new AgentLoop({
    providerRegistry,
    providerConfig: { mode: "auto", endpoints: [] },
    toolRegistry,
    dispatcher,
    contextAssembler,
    memoryStore,
    profileStore
  });

  // Turn 1: User states a durable preference. Should auto-save and inject immediately.
  const turn1 = await loop.run({
    userId,
    messages: [{ role: "user", content: "I prefer concise replies with rollback commands." }]
  });
  assert.equal(turn1.status, "completed");
  assert.equal(turn1.autoMemories?.length, 1);
  assert.equal(turn1.autoMemories[0].kind, "preference");
  const capturedMemory = (await memoryStore.list(userId))[0];
  assert.equal(capturedMemory.origin, "conversation-captured");
  assert.equal(capturedMemory.trust, "user_authored");
  assert.equal(capturedMemory.provenance.source, "conversation-captured");
  assert.equal(capturedMemory.provenance.capturedBy, "conversation");
  assert.equal(turn1.provenance.autoMemories.length, 1);
  assert.match(seenSystemPrompts[0], /rollback commands/i);

  // Turn 2: Repeating the same preference does not create a duplicate.
  const turn2 = await loop.run({
    userId,
    messages: [{ role: "user", content: "I prefer concise replies with rollback commands." }]
  });
  assert.equal(turn2.autoMemories, undefined);
  const allMemories = await memoryStore.list(userId);
  assert.equal(allMemories.length, 1);

  // Turn 3: Completely unrelated question still receives the durable preference memory!
  const turn3 = await loop.run({
    userId,
    messages: [{ role: "user", content: "How do I check Linux disk space?" }]
  });
  assert.equal(turn3.status, "completed");
  assert.match(seenSystemPrompts[2], /rollback commands/i);

  // Turn 4: Disabling autoMemoryEnabled stops automatic capture.
  await profileStore.update(userId, { autoMemoryEnabled: false });
  const turn4 = await loop.run({
    userId,
    messages: [{ role: "user", content: "Remember that my favorite editor is Neovim." }]
  });
  assert.equal(turn4.autoMemories, undefined);
  assert.equal((await memoryStore.list(userId)).length, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test("WorkflowProfileStore persists learned feedback across sessions and injects into prompt assembly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-taste-"));
  const userId = "user-taste-1";
  const profileStore = new WorkflowProfileStore({ dataDirectory: dir });

  const reply = "### Quick Fix\n- Restart the container\n- Check logs\n- Verify health\n```bash\ndocker compose restart\n```";
  const fb = await profileStore.recordFeedback(userId, {
    reaction: "like",
    previousReaction: null,
    content: reply
  });
  assert.equal(fb.learned, true);
  assert.ok(fb.signals.includes("Structured headings & bullets"));
  assert.ok(fb.signals.includes("Concrete code & commands"));

  // Reload fresh from disk (simulating a brand-new session)
  const freshStore = new WorkflowProfileStore({ dataDirectory: dir });
  const reloaded = await freshStore.get(userId);
  assert.equal(reloaded.learnedStyle.likes, 1);
  assert.equal(reloaded.learnedStyle.traits.structured, 1);
  const prompt = buildWorkflowProfilePrompt(reloaded);
  assert.match(prompt, /Learned response style preferences/i);
  assert.match(prompt, /headings and scannable bullet points/i);

  // Reset learned style clears tallies cleanly
  const reset = await freshStore.update(userId, { resetLearnedStyle: true });
  assert.equal(reset.learnedStyle.likes, 0);
  assert.equal(reset.learnedStyle.traits.structured, 0);
  assert.doesNotMatch(buildWorkflowProfilePrompt(reset), /Learned response style preferences/i);

  await fs.rm(dir, { recursive: true, force: true });
});
