import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConversationStore } from "../src/conversations/store.mjs";

test("task-linked conversation messages are idempotent and reject key reuse with different content", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-conversation-task-idempotency-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore({ dataDirectory: directory });
  const conversation = await store.create("user-chat", "Background task");
  const taskId = "33333333-3333-4333-8333-333333333333";
  const first = await store.appendMessage("user-chat", conversation.id, { role: "user", content: "Create an HTML page", taskId });
  const retry = await store.appendMessage("user-chat", conversation.id, { role: "user", content: "Create an HTML page", taskId });
  assert.equal(retry.id, first.id);
  assert.equal((await store.get("user-chat", conversation.id)).messages.length, 1);
  await assert.rejects(() => store.appendMessage("user-chat", conversation.id, { role: "user", content: "Different prompt", taskId }), { status: 409, code: "MESSAGE_IDEMPOTENCY_CONFLICT" });
});
