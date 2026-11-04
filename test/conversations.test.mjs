import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConversationStore } from "../src/conversations/store.mjs";

async function temporaryStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-conversations-"));
  try { await run(new ConversationStore({ dataDirectory: directory })); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("persists conversations and messages for their verified owner", async () => {
  await temporaryStore(async (store) => {
    const conversation = await store.create("user-1");
    await store.appendMessage("user-1", conversation.id, { role: "user", content: "Hello Alfie" });
    const reopened = new ConversationStore({ dataDirectory: store.dataDirectory });
    const loaded = await reopened.get("user-1", conversation.id);
    assert.equal(loaded.title, "Hello Alfie");
    assert.equal(loaded.messages[0].content, "Hello Alfie");
  });
});

test("isolates conversation data between users", async () => {
  await temporaryStore(async (store) => {
    const conversation = await store.create("user-1");
    await store.appendMessage("user-1", conversation.id, { role: "assistant", content: "Private reply" });
    await assert.rejects(store.get("user-2", conversation.id), { status: 404 });
    assert.equal((await store.list("user-2")).length, 0);
  });
});

test("serialises concurrent writes and rejects invalid message roles", async () => {
  await temporaryStore(async (store) => {
    const conversation = await store.create("user-1");
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.appendMessage("user-1", conversation.id, { role: "user", content: `Message ${index}` })));
    const loaded = await store.get("user-1", conversation.id);
    assert.equal(loaded.messages.length, 12);
    await assert.rejects(store.appendMessage("user-1", conversation.id, { role: "system", content: "No" }), { status: 400 });
  });
});

test("deletes only the selected user's conversation", async () => {
  await temporaryStore(async (store) => {
    const conversation = await store.create("user-1");
    await assert.rejects(store.remove("user-2", conversation.id), { status: 404 });
    assert.deepEqual(await store.remove("user-1", conversation.id), { deleted: true });
    assert.equal((await store.list("user-1")).length, 0);
  });
});

test("uses restrictive filesystem permissions for persisted conversation data", async () => {
  await temporaryStore(async (store) => {
    await store.create("user-1");
    const file = store.fileFor("user-1");
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("imports legacy chat snapshots once and preserves message metadata and approval cards", async () => {
  await temporaryStore(async (store) => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const messageId = "22222222-2222-4222-8222-222222222222";
    const snapshot = {
      activeConversationId: conversationId,
      conversations: [{
        id: conversationId,
        title: "Petrio history",
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-02T10:00:00.000Z",
        messages: [
          { id: messageId, role: "user", content: "Keep this history", createdAt: "2026-10-01T10:00:00.000Z" },
          { id: "33333333-3333-4333-8333-333333333333", role: "assistant", content: "I will.", meta: "Saved", actionCard: { state: "approval", actionId: "pending-1", toolId: "calendar.create", risk: "write", arguments: { title: "Workout" } } },
          { role: "assistant", content: "Transient response", transient: true }
        ]
      }]
    };
    const imported = await store.importLegacy("user-1", snapshot);
    assert.equal(imported.imported, true);
    assert.equal(imported.count, 1);
    const loaded = await store.database("user-1");
    assert.equal(loaded.activeConversationId, conversationId);
    assert.equal(loaded.conversations[0].messages.length, 2);
    assert.equal(loaded.conversations[0].messages[0].id, messageId);
    assert.equal(loaded.conversations[0].messages[1].meta, "Saved");
    assert.equal(loaded.conversations[0].messages[1].actionCard.actionId, "pending-1");
    assert.deepEqual(loaded.conversations[0].messages[1].actionCard.arguments, { title: "Workout" });
    const secondImport = await store.importLegacy("user-1", { conversations: [] });
    assert.equal(secondImport.imported, false);
    assert.equal((await store.database("user-1")).conversations.length, 1);
  });
});

test("replacing a conversation snapshot cannot affect another user", async () => {
  await temporaryStore(async (store) => {
    const conversationId = "44444444-4444-4444-8444-444444444444";
    await store.replaceDatabase("user-1", {
      activeConversationId: conversationId,
      conversations: [{ id: conversationId, title: "Updated", messages: [{ role: "assistant", content: "Core owns this now" }] }]
    });
    assert.equal((await store.database("user-1")).conversations[0].title, "Updated");
    assert.equal((await store.database("user-2")).conversations.length, 0);
  });
});

test("normalises legacy non-UUID conversation identifiers without dropping their history", async () => {
  await temporaryStore(async (store) => {
    const imported = await store.importLegacy("user-1", {
      activeConversationId: "legacy-chat-1",
      conversations: [{ id: "legacy-chat-1", title: "Older browser history", messages: [{ role: "user", content: "Do not lose me" }] }]
    });
    assert.equal(imported.imported, true);
    const database = await store.database("user-1");
    assert.match(database.activeConversationId, /^[a-f0-9-]{36}$/i);
    assert.equal(database.conversations[0].title, "Older browser history");
    assert.equal(database.conversations[0].messages[0].content, "Do not lose me");
  });
});


test("rejects stale conversation snapshots instead of overwriting newer sessions", async () => {
  await temporaryStore(async (store) => {
    const conversation = await store.create("user-1", "Shared history");
    const initial = await store.database("user-1");
    await store.appendMessage("user-1", conversation.id, { role: "user", content: "A newer message from another session" });
    await assert.rejects(
      store.replaceDatabase("user-1", { conversations: [{ id: conversation.id, title: "Stale snapshot", messages: [] }] }, initial.revision),
      { status: 409, code: "conversation_revision_conflict" }
    );
    const latest = await store.database("user-1");
    assert.equal(latest.conversations[0].messages[0].content, "A newer message from another session");
    assert.ok(latest.revision > initial.revision);
  });
});
