import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IdeaStore, IDEA_STATUSES, IDEA_PRIORITIES, extractHashtags } from "../src/ideas/store.mjs";

describe("IdeaStore (Ideas Vault)", () => {
  it("extracts valid hashtags from idea notes while ignoring URL fragments, hex colors, and pure numbers", () => {
    const tags = extractHashtags(
      "Watch Proxmox snapshots #Homelab",
      "Check https://example.com/docs#section and color #ff5500 or #fff, issue #42, then add (#proxmox-backup) #ai_agents #Homelab."
    );
    assert.deepEqual(tags, ["homelab", "proxmox-backup", "ai_agents"]);
  });

  it("auto-extracts hashtags on create/update, filters by tag, and aggregates tag counts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-ideas-tags-"));
    try {
      const store = new IdeaStore({ dataDirectory: dir });
      const first = await store.create("alice", {
        title: "Automate ZFS scrubs",
        body: "Run weekly checks for #Homelab and #Storage-Pool."
      });
      assert.deepEqual(first.tags, ["homelab", "storage-pool"]);

      const second = await store.create("alice", {
        title: "Push-to-talk hotkey #Voice",
        body: "Keep local-only audio capture for #homelab desktop."
      });
      assert.deepEqual(second.tags, ["voice", "homelab"]);

      const counts = await store.listTags("alice");
      assert.deepEqual(counts, [
        { tag: "homelab", count: 2 },
        { tag: "storage-pool", count: 1 },
        { tag: "voice", count: 1 }
      ]);

      const voiceOnly = await store.list("alice", { tag: "#Voice" });
      assert.equal(voiceOnly.length, 1);
      assert.equal(voiceOnly[0].id, second.id);

      // Updating notes re-extracts hashtags cleanly
      const updated = await store.update("alice", first.id, {
        body: "Switch focus to #backups instead."
      });
      assert.deepEqual(updated.tags, ["backups"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates, lists, filters, updates, clears project links, and deletes ideas per user", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-ideas-"));
    try {
      const store = new IdeaStore({ dataDirectory: dir });
      const projectId = randomUUID();

      assert.ok(IDEA_STATUSES.includes("inbox"));
      assert.ok(IDEA_PRIORITIES.includes("high"));

      const first = await store.create("alice", {
        title: "Build Proxmox backup watcher",
        body: "Alert only if two consecutive snapshots fail.",
        priority: "high",
        projectId,
        tags: ["Homelab", "Watcher"],
        sourceContext: "Chat (/idea)"
      });
      assert.equal(first.status, "inbox");
      assert.equal(first.priority, "high");
      assert.equal(first.projectId, projectId);
      assert.deepEqual(first.tags, ["homelab", "watcher"]);

      const second = await store.create("alice", {
        title: "Try local speech-to-speech prototyping",
        priority: "low"
      });
      assert.equal(second.status, "inbox");
      assert.equal(second.projectId, null);

      // Strict per-user isolation
      const bobIdeas = await store.list("bob");
      assert.equal(bobIdeas.length, 0);

      // Filter by project and search query
      const linked = await store.list("alice", { projectId });
      assert.equal(linked.length, 1);
      assert.equal(linked[0].id, first.id);

      const searched = await store.list("alice", { query: "proxmox" });
      assert.equal(searched.length, 1);
      assert.equal(searched[0].id, first.id);

      // Update status and filter by status
      const updated = await store.update("alice", first.id, { status: "active" });
      assert.equal(updated.status, "active");

      const activeOnly = await store.list("alice", { status: "active" });
      assert.equal(activeOnly.length, 1);
      assert.equal(activeOnly[0].id, first.id);

      // Clear project reference on project deletion
      const cleared = await store.clearProject("alice", projectId);
      assert.equal(cleared.cleared, 1);
      const afterClear = await store.get("alice", first.id);
      assert.equal(afterClear.projectId, null);

      // Remove idea
      const removed = await store.remove("alice", second.id);
      assert.equal(removed.deleted, true);
      const remaining = await store.list("alice");
      assert.equal(remaining.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing titles and malformed project IDs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-ideas-err-"));
    try {
      const store = new IdeaStore({ dataDirectory: dir });
      await assert.rejects(() => store.create("alice", { title: "   " }), /title is required/i);
      await assert.rejects(() => store.create("alice", { title: "Valid", projectId: "not-a-uuid" }), /Invalid project ID/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
