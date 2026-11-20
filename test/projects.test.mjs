import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/projects/store.mjs";
import { ConversationStore } from "../src/conversations/store.mjs";
import { VramMonitor } from "../src/system/vramMonitor.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";

const SERVICE_TOKEN = "test-service-token-for-projects-32chars!!";
const IDENTITY_SECRET = "test-identity-secret-for-projects-32chars!!";

test("ProjectStore enforces per-user isolation, validation, and atomic 0o600 persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-projects-store-"));
  try {
    const store = new ProjectStore({ dataDirectory: dir });
    const created = await store.create("user-a", {
      name: "  Pixel Harness  ",
      description: "Sprite pipeline and GPU handoff notes",
      color: "cyan"
    });
    assert.equal(created.name, "Pixel Harness");
    assert.equal(created.color, "cyan");

    // Duplicate name (case-insensitive) rejected
    await assert.rejects(
      () => store.create("user-a", { name: "pixel harness" }),
      (err) => err.status === 409 && err.code === "PROJECT_NAME_DUPLICATE"
    );

    // Other user cannot see or mutate user-a's project
    assert.deepEqual(await store.list("user-b"), []);
    await assert.rejects(
      () => store.get("user-b", created.id),
      (err) => err.status === 404
    );

    // Update works
    const updated = await store.update("user-a", created.id, {
      name: "Pixel Harness v2",
      color: "amber"
    });
    assert.equal(updated.name, "Pixel Harness v2");
    assert.equal(updated.color, "amber");

    // Verify 0o600 permissions on stored file
    const stat = await fs.stat(store.fileFor("user-a"));
    assert.equal(stat.mode & 0o777, 0o600);

    // Delete works
    const removed = await store.remove("user-a", created.id);
    assert.equal(removed.deleted, true);
    assert.deepEqual(await store.list("user-a"), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Core server supports multiple chats per project, safe project deletion, VRAM reporting, and context handoff", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-projects-server-"));
  const identityAuth = createSignedIdentityAuth({ secret: IDENTITY_SECRET, providerId: "petrio" });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const conversationStore = new ConversationStore({ dataDirectory: dir });
  const vramMonitor = new VramMonitor({
    execFileImpl: async () => { throw new Error("no gpu"); },
    fetchImpl: async () => { throw new Error("no ollama"); }
  });

  const server = createAlfieCoreServer({
    serviceToken: SERVICE_TOKEN,
    identityAuth,
    projectStore,
    conversationStore,
    vramMonitor
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createAlfieCoreClient({ baseUrl, serviceToken: SERVICE_TOKEN, identityAuth });

  try {
    // 1. Create a project
    const { project } = await client.createProject("user-1", {
      name: "Renderer Rewrite",
      description: "Keep frame budget under 16ms and preserve pixel-crisp scaling.",
      color: "emerald"
    });
    assert.equal(project.name, "Renderer Rewrite");
    assert.equal(project.conversationCount, 0);

    // 2. Create two conversations under the same project + one unassigned conversation
    const { conversation: chat1 } = await client.createConversation("user-1", {
      title: "Shader pipeline",
      projectId: project.id
    });
    const { conversation: chat2 } = await client.createConversation("user-1", {
      title: "Atlas packing",
      projectId: project.id
    });
    const { conversation: unassigned } = await client.createConversation("user-1", {
      title: "Quick note"
    });
    assert.equal(chat1.projectId, project.id);
    assert.equal(chat2.projectId, project.id);
    assert.equal(unassigned.projectId, null);

    // Project list reports accurate conversation count
    const { projects } = await client.listProjects("user-1");
    assert.equal(projects.length, 1);
    assert.equal(projects[0].conversationCount, 2);

    // Filter conversations by projectId
    const filtered = await client.listConversations("user-1", `projectId=${encodeURIComponent(project.id)}`);
    assert.equal(filtered.conversations.length, 2);

    // 3. Add messages to chat1 and trigger 84% VRAM report
    await client.appendMessage("user-1", chat1.id, { role: "user", content: "Let's move bloom to a half-res pass." });
    await client.appendMessage("user-1", chat1.id, { role: "assistant", content: "Agreed — half-res Kawase blur keeps VRAM low and saves 3.2ms." });

    const beforeVram = await client.getVramStatus("user-1");
    assert.equal(beforeVram.vram.available, false);
    assert.equal(beforeVram.vram.warning, false);

    const reported = await client.reportVramStatus("user-1", {
      percent: 84,
      usedMb: 20644,
      totalMb: 24576,
      gpuName: "RTX 4090",
      source: "test-alert"
    });
    assert.equal(reported.vram.warning, true);
    assert.equal(reported.vram.percent, 84);

    // 4. Create continuation chat via context handoff
    const handoffRes = await client.handoffConversation("user-1", chat1.id, { reason: "vram_threshold" });
    assert.equal(handoffRes.conversation.title, "Shader pipeline (Part 2)");
    assert.equal(handoffRes.conversation.projectId, project.id);
    assert.equal(handoffRes.conversation.parentConversationId, chat1.id);
    assert.equal(handoffRes.conversation.continuedFromTitle, "Shader pipeline");
    assert.match(handoffRes.conversation.handoffContext, /Renderer Rewrite/);
    assert.match(handoffRes.conversation.handoffContext, /half-res Kawase blur/);
    assert.match(handoffRes.conversation.handoffContext, /high VRAM usage/i);

    // Project now holds 3 chats
    const afterHandoffProjects = await client.listProjects("user-1");
    assert.equal(afterHandoffProjects.projects[0].conversationCount, 3);

    // 5. Reassign unassigned chat into the project via PATCH
    const moved = await client.updateConversation("user-1", unassigned.id, { projectId: project.id });
    assert.equal(moved.conversation.projectId, project.id);

    // 6. Deleting the project safely unassigns all 4 chats without deleting them
    const deleted = await client.deleteProject("user-1", project.id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.unassignedConversations, 4);

    const remainingChats = await client.listConversations("user-1");
    assert.equal(remainingChats.conversations.length, 4);
    assert.ok(remainingChats.conversations.every((c) => c.projectId === null));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
