import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";

async function temporaryStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-memories-"));
  try { await run(new MemoryStore({ dataDirectory: directory })); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("keeps user-seeded and Alfie-created memories distinct with provenance", async () => {
  await temporaryStore(async (store) => {
    const seed = await store.create("user-1", { text: "I prefer a calm interface", origin: "user-seeded", tags: ["Preference"] });
    const alfie = await store.create("user-1", { text: "The user is building Petrio", origin: "alfie-created" });
    assert.equal(seed.provenance.capturedBy, "user");
    assert.equal(alfie.provenance.capturedBy, "alfie");
    assert.equal((await store.list("user-1", { origin: "user-seeded" })).length, 1);
    assert.equal((await store.list("user-1", { origin: "alfie-created" })).length, 1);
  });
});

test("supports search, editing and deletion without changing memory provenance", async () => {
  await temporaryStore(async (store) => {
    const memory = await store.create("user-1", { text: "Petrio uses a purple pixel theme", origin: "user-seeded" });
    const updated = await store.update("user-1", memory.id, { text: "Petrio uses a purple pixel-art theme", importance: 5 });
    assert.equal(updated.origin, "user-seeded");
    assert.equal(updated.importance, 5);
    assert.equal((await store.list("user-1", { query: "pixel-art" })).length, 1);
    const removed = await store.remove("user-1", memory.id);
    assert.equal(removed.deleted, true);
    assert.equal(removed.memory.id, memory.id);
    assert.equal((await store.list("user-1")).length, 0);
  });
});

test("isolates memories by user and rejects empty memory text", async () => {
  await temporaryStore(async (store) => {
    const memory = await store.create("user-1", { text: "Private memory" });
    assert.equal((await store.list("user-2")).length, 0);
    await assert.rejects(store.update("user-2", memory.id, { text: "Hijack" }), { status: 404 });
    await assert.rejects(store.create("user-1", { text: "  " }), { status: 400 });
    await assert.rejects(store.create("user-1", { text: "Bad source", origin: "unknown" }), { status: 400 });
  });
});

test("stores memory files with restrictive permissions", async () => {
  await temporaryStore(async (store) => {
    await store.create("user-1", { text: "Private" });
    const stat = await fs.stat(store.fileFor("user-1"));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("supports memory relationships and removes dangling links", async () => {
  await temporaryStore(async (store) => {
    const first = await store.create("user-1", { source: "alfie", type: "explicit", text: "Petrio is a personal OS" });
    const second = await store.create("user-1", { source: "user", type: "project", text: "Petrio project" });
    const linked = await store.addRelationship("user-1", first.id, {
      target: second.id, type: "supports", confidence: 0.9, createdBy: "alfie"
    });
    assert.equal(linked.relationship.type, "supports");
    assert.equal((await store.get("user-1", first.id)).relationships.length, 1);
    await store.remove("user-1", second.id);
    assert.equal((await store.get("user-1", first.id)).relationships.length, 0);
  });
});

test("imports legacy Petrio memories idempotently without losing source metadata or links", async () => {
  await temporaryStore(async (store) => {
    const legacy = [{
      id: "123e4567-e89b-12d3-a456-426614174000",
      source: "alfie",
      type: "explicit",
      title: "Alfie memory",
      text: "The user is building Petrio",
      tags: ["alfie", "explicit"],
      importance: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      metadata: { explicitRequest: true, capturedFrom: "alfie-chat" },
      relationships: []
    }];
    const first = await store.importLegacy("user-1", legacy);
    const second = await store.importLegacy("user-1", legacy);
    const memory = await store.get("user-1", legacy[0].id);
    assert.deepEqual(first, { imported: 1, skipped: 0, total: 1 });
    assert.deepEqual(second, { imported: 0, skipped: 1, total: 1 });
    assert.equal(memory.origin, "alfie-created");
    assert.equal(memory.source, "alfie");
    assert.equal(memory.type, "explicit");
    assert.equal(memory.importance, 7);
    assert.equal(memory.metadata.explicitRequest, true);
    assert.equal(memory.createdAt, legacy[0].createdAt);
  });
});

test("returns outgoing and incoming relationship context", async () => {
  await temporaryStore(async (store) => {
    const first = await store.create("user-1", { text: "First memory" });
    const second = await store.create("user-1", { text: "Second memory" });
    await store.addRelationship("user-1", first.id, { target: second.id, type: "references" });
    const relatedFirst = await store.related("user-1", first.id);
    const relatedSecond = await store.related("user-1", second.id);
    assert.equal(relatedFirst[0].direction, "outgoing");
    assert.equal(relatedSecond[0].direction, "incoming");
    assert.equal(relatedSecond[0].memory.id, first.id);
  });
});


test("ranks relevant memories using text, title, tags and importance", async () => {
  await temporaryStore(async (store) => {
    const weak = await store.create("user-1", {
      source: "alfie", type: "note", title: "General preference",
      text: "The Petrio theme should stay calm", importance: 4
    });
    const strong = await store.create("user-1", {
      source: "user", type: "project", title: "Petrio purple pixel theme",
      text: "Use the purple pixel theme across every Petrio app", tags: ["Petrio", "pixel"], importance: 8
    });
    await store.create("user-1", { source: "user", type: "note", text: "Weekend meal ideas", importance: 10 });
    const results = await store.search("user-1", "What is the Petrio pixel theme?", { limit: 2 });
    assert.equal(results[0].id, strong.id);
    assert.ok(results.some((item) => item.id === weak.id));
    assert.equal(results.length, 2);
  });
});
