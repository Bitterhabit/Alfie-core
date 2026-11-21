import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/agent/loop.mjs";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { ConversationStore } from "../src/conversations/store.mjs";

describe("Turn Provenance & Grounded Project Status", () => {
  it("answers 'Where are we with this project?' grounded in the Living Dossier and emits provenance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-prov-"));
    try {
      const projectStore = new ProjectStore({ dataDirectory: dir });
      const memoryStore = new MemoryStore({ dataDirectory: dir });
      const toolRegistry = new ToolRegistry();
      const conversationStore = new ConversationStore({ dataDirectory: dir });

      const project = await projectStore.create("alice", {
        name: "Homelab Upgrade",
        status: "active",
        vision: "Move storage pool to ZFS mirror with automated snapshots.",
        nextActions: ["Verify UPS shutdown script", "Benchmark scrub time"],
        blockers: ["Waiting for second NVMe drive"],
        decisions: [{ summary: "Use Proxmox Backup Server", rationale: "Deduplicated incremental backups." }]
      });

      const dispatcher = {
        permissionStore: { list: async () => [] },
        resetTurn() {},
        dispatch: async () => ({ status: "completed" })
      };

      const loop = new AgentLoop({
        providerRegistry: {
          complete: async () => {
            throw new Error("Add and enable at least one Alfie endpoint with a model name.");
          }
        },
        providerConfig: { endpoints: [] },
        memoryStore,
        projectStore,
        toolRegistry,
        dispatcher,
        contextAssembler: new ContextAssembler()
      });

      const result = await loop.run({
        userId: "alice",
        messages: [{ role: "user", content: "Where are we with this project?" }],
        workingMode: "engineer",
        projectId: project.id,
        agentProvider: "local"
      });

      assert.equal(result.status, "completed");
      assert.match(result.message, /Homelab Upgrade/);
      assert.match(result.message, /Verify UPS shutdown script/);
      assert.match(result.message, /Waiting for second NVMe drive/);
      assert.match(result.message, /Use Proxmox Backup Server/);

      assert.ok(result.provenance, "provenance should be emitted");
      assert.equal(result.provenance.workingMode.id, "engineer");
      assert.equal(result.provenance.project.id, project.id);
      assert.equal(result.provenance.project.name, "Homelab Upgrade");
      assert.equal(result.provenance.tainted, false);
      assert.equal(result.provenance.privacyFiltered, false);

      // Verify ConversationStore persists provenance cleanly
      const conv = await conversationStore.create("alice", { title: "Homelab check-in", projectId: project.id });
      const storedMsg = await conversationStore.appendMessage("alice", conv.id, {
        role: "assistant",
        content: result.message,
        provenance: result.provenance
      });
      assert.equal(storedMsg.provenance.workingMode.id, "engineer");
      assert.equal(storedMsg.provenance.project.name, "Homelab Upgrade");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks project dossier injection when a cloud agent disables allowProjectContext", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-prov-cloud-"));
    try {
      const projectStore = new ProjectStore({ dataDirectory: dir });
      const memoryStore = new MemoryStore({ dataDirectory: dir });
      const toolRegistry = new ToolRegistry();

      const project = await projectStore.create("alice", {
        name: "Secret Project",
        vision: "Confidential roadmap that must never leak to cloud."
      });

      let seenMessages = null;
      const cloudAgentStore = {
        getAgent: async () => ({
          id: "openai",
          provider: "openai",
          name: "Cloud OpenAI",
          model: "gpt-4o-mini",
          enabled: true,
          privacyWarningAccepted: true,
          visibility: {
            allowPersonalMemories: false,
            allowDashboardState: false,
            allowProjectContext: false,
            allowTools: false
          }
        })
      };

      const cloudAdapters = {
        complete: async ({ messages }) => {
          seenMessages = messages;
          return {
            endpoint: { id: "cloud-openai", model: "gpt-4o-mini", provider: "openai" },
            result: {
              content: JSON.stringify({ type: "final", message: "Cloud reply without project context." }),
              raw: { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
            }
          };
        }
      };

      const dispatcher = {
        permissionStore: { list: async () => [] },
        resetTurn() {},
        dispatch: async () => ({ status: "completed" })
      };

      const loop = new AgentLoop({
        providerRegistry: {
          complete: async () => { throw new Error("should not call local"); }
        },
        providerConfig: { endpoints: [] },
        memoryStore,
        projectStore,
        cloudAgentStore,
        cloudAdapters,
        toolRegistry,
        dispatcher,
        contextAssembler: new ContextAssembler()
      });

      const result = await loop.run({
        userId: "alice",
        messages: [{ role: "user", content: "Hello" }],
        workingMode: "researcher",
        projectId: project.id,
        agentProvider: "openai"
      });

      assert.equal(result.status, "completed");
      assert.ok(seenMessages, "cloud completion should be called");
      const fullSystem = seenMessages.map((m) => m.content).join("\n");
      assert.doesNotMatch(fullSystem, /Secret Project/);
      assert.doesNotMatch(fullSystem, /Confidential roadmap/);
      assert.equal(result.provenance.project, null);
      assert.equal(result.provenance.privacyFiltered, true);
      assert.equal(result.provenance.workingMode.id, "researcher");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
