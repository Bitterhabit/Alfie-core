import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore, formatProjectDossier, PROJECT_STATUSES } from "../src/projects/store.mjs";
import { buildHandoffBrief } from "../src/conversations/handoff.mjs";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";

describe("Living Project Dossiers", () => {
  it("persists structured dossier fields and remains backward-compatible with legacy project files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfie-projects-"));
    try {
      // Seed a legacy projects.json lacking dossier fields
      const hash = createHash("sha256").update("legacy-user").digest("hex");
      const userDir = path.join(dir, "users", hash);
      await mkdir(userDir, { recursive: true });
      await writeFile(
        path.join(userDir, "projects.json"),
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          ownerId: "legacy-user",
          projects: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Legacy Homelab",
              description: "Old flat description",
              color: "purple",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        })
      );

      const store = new ProjectStore({ dataDirectory: dir });
      const loaded = await store.list("legacy-user");
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].status, "active");
      assert.deepEqual(loaded[0].decisions, []);
      assert.deepEqual(loaded[0].blockers, []);
      assert.deepEqual(loaded[0].nextActions, []);
      assert.deepEqual(loaded[0].postponed, []);

      assert.ok(PROJECT_STATUSES.includes("planning"));

      // Create a full Living Project Dossier
      const created = await store.create("alice", {
        name: "Alfie Continuity",
        description: "Long-term personal assistant architecture",
        status: "active",
        vision: "Minimal-context continuity across projects, decisions, and ideas.",
        architecture: "Local-first Core + hardened Interface with SQLite WAL target.",
        decisions: [{ summary: "Keep single-authority harness", rationale: "Zero arbitrary execution." }],
        blockers: ["Need WAL migration benchmark"],
        nextActions: ["Ship Ideas Vault UI", "Add provenance disclosure"],
        postponed: ["Virtual room visual layer"]
      });

      assert.equal(created.status, "active");
      assert.equal(created.decisions.length, 1);
      assert.equal(created.decisions[0].summary, "Keep single-authority harness");
      assert.equal(created.blockers[0], "Need WAL migration benchmark");
      assert.equal(created.nextActions.length, 2);

      const dossierText = formatProjectDossier(created);
      assert.match(dossierText, /Project: Alfie Continuity \(status: active\)/);
      assert.match(dossierText, /Vision: Minimal-context continuity/);
      assert.match(dossierText, /Keep single-authority harness/);
      assert.match(dossierText, /Ship Ideas Vault UI/);

      // Enriched handoff brief includes dossier fields
      const brief = buildHandoffBrief(
        {
          title: "Architecture planning",
          messages: [{ role: "user", content: "Let's finalize the project dossier spec." }]
        },
        { project: created }
      );
      assert.match(brief.summary, /\*\*Project\*\*: Alfie Continuity \(active\)/);
      assert.match(brief.summary, /\*\*Next actions\*\*:/);
      assert.match(brief.summary, /\*\*Active blockers\*\*:/);

      // ContextAssembler injects working mode + dossier cleanly
      const assembler = new ContextAssembler();
      const assembled = assembler.assemble({
        history: [],
        userText: "Where are we with this project?",
        registry: { list: () => [] },
        workingMode: "planner",
        project: created
      });
      assert.equal(assembled.workingMode.id, "planner");
      assert.equal(assembled.projectIncluded, true);
      const sys = assembled.messages[0].content;
      assert.match(sys, /Active working mode: Planner/);
      assert.match(sys, /Project: Alfie Continuity \(status: active\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("guides the user when asking for a project brief on an empty dossier", async () => {
    const { AgentLoop } = await import("../src/agent/loop.mjs");
    const loop = new AgentLoop({
      providerRegistry: { complete: async () => { throw new Error("offline"); } },
      providerConfig: {},
      toolRegistry: { list: () => [] },
      dispatcher: { permissionStore: { list: async () => [] }, resetTurn() {} },
      contextAssembler: new ContextAssembler(),
      projectStore: {
        get: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Fresh Prototype",
          status: "planning",
          vision: "",
          description: "",
          architecture: "",
          decisions: [],
          blockers: [],
          nextActions: [],
          postponed: []
        })
      }
    });
    const res = await loop.run({
      userId: "alice",
      projectId: "11111111-1111-4111-8111-111111111111",
      workingMode: "planner",
      messages: [{ role: "user", content: "Where are we with this project?" }]
    });
    assert.equal(res.status, "completed");
    assert.match(res.message, /Project Brief: Fresh Prototype \(planning\)/);
    assert.match(res.message, /Open \*\*Dossier\*\* in the chat bar/);
  });
});
