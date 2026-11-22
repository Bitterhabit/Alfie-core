import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildKnowledgeGraph } from "../src/graph/builder.mjs";
import { computeGraphLayout } from "../interface/public/knowledge-graph.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createSignedIdentityAuth } from "../src/auth/signedIdentity.mjs";
import { ProjectStore } from "../src/projects/store.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { IdeaStore } from "../src/ideas/store.mjs";
import { WatcherStore } from "../src/watchers/store.mjs";
import { ContextCapsuleStore } from "../src/capsules/store.mjs";
import { WorkflowProfileStore } from "../src/profile/store.mjs";

const SERVICE_TOKEN = "a".repeat(40);
const PETRIO_SECRET = "b".repeat(40);

test("buildKnowledgeGraph deterministically links projects, decisions, memories, ideas, tags, capsules, watchers, and topics", () => {
  const projId = "11111111-1111-4111-8111-111111111111";
  const memAId = "22222222-2222-4222-8222-222222222222";
  const memBId = "33333333-3333-4333-8333-333333333333";
  const ideaId = "44444444-4444-4444-8444-444444444444";
  const capId = "55555555-5555-4555-8555-555555555555";
  const watchId = "66666666-6666-4666-8666-666666666666";
  const topicId = "77777777-7777-4777-8777-777777777777";

  const graph = buildKnowledgeGraph({
    projects: [{
      id: projId,
      name: "Homelab Atlas",
      status: "active",
      vision: "Resilient local-first Proxmox infrastructure",
      decisions: [{ id: "dec-1", summary: "Use ZFS snapshots", rationale: "Fast rollbacks before upgrades" }]
    }],
    memories: [
      {
        id: memAId,
        text: "Homelab Atlas runs on Proxmox VE 8 with ZFS mirror.",
        kind: "fact",
        importance: 8,
        trust: "user_authored",
        tags: ["proxmox", "zfs"],
        relationships: [{ targetId: memBId, type: "supports" }]
      },
      {
        id: memBId,
        text: "External status feed reported node latency spike.",
        kind: "note",
        importance: 6,
        trust: "external_untrusted",
        tags: ["proxmox"]
      }
    ],
    ideas: [{
      id: ideaId,
      title: "Automate ZFS scrub digest #proxmox #backup",
      body: "Send quiet digest after scrub completes.",
      status: "active",
      priority: "high",
      projectId: projId,
      tags: ["proxmox", "backup"]
    }],
    capsules: [{
      id: capId,
      name: "Infra Maintenance",
      projectId: projId,
      workingMode: "engineer",
      learningMode: "explain",
      privacyPosture: "local_only"
    }],
    watchers: [{
      id: watchId,
      name: "Atlas HTTP Probe",
      kind: "http_probe",
      tier: "notify",
      enabled: true,
      lastTrust: "external_untrusted",
      config: { url: "https://example.com/health" }
    }],
    profile: {
      learningTopics: [{ id: topicId, topic: "ZFS tuning", confidence: "practicing" }]
    }
  });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.ok(byId.has(`project:${projId}`));
  assert.ok(byId.has(`decision:${projId}:dec-1`));
  assert.ok(byId.has(`memory:${memAId}`));
  assert.ok(byId.has(`memory:${memBId}`));
  assert.ok(byId.has(`idea:${ideaId}`));
  assert.ok(byId.has("tag:proxmox"));
  assert.ok(byId.has("tag:zfs"));
  assert.ok(byId.has(`capsule:${capId}`));
  assert.ok(byId.has(`watcher:${watchId}`));
  assert.ok(byId.has(`topic:${topicId}`));

  // Trust provenance preserved accurately
  assert.equal(byId.get(`memory:${memBId}`).trust, "external_untrusted");
  assert.equal(byId.get(`watcher:${watchId}`).trust, "external_untrusted");
  assert.equal(graph.stats.untrustedNodeCount, 2);

  // Expected cross-entity edges exist
  const edgeKeys = new Set(graph.edges.map((e) => `${e.source}|${e.relation}|${e.target}`));
  assert.ok(edgeKeys.has(`decision:${projId}:dec-1|decided_in|project:${projId}`));
  assert.ok(edgeKeys.has(`idea:${ideaId}|belongs_to|project:${projId}`));
  assert.ok(edgeKeys.has(`idea:${ideaId}|tagged_with|tag:proxmox`));
  assert.ok(edgeKeys.has(`memory:${memAId}|tagged_with|tag:proxmox`));
  assert.ok(edgeKeys.has(`memory:${memAId}|mentions_project|project:${projId}`));
  assert.ok(edgeKeys.has(`memory:${memAId}|supports|memory:${memBId}`));
  assert.ok(edgeKeys.has(`capsule:${capId}|scopes_project|project:${projId}`));
  assert.ok(edgeKeys.has(`topic:${topicId}|relevant_to|tag:zfs`));
});

test("buildKnowledgeGraph supports projectId scoping, kind filtering, search with 1-hop context, and focus neighborhood", () => {
  const projA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const data = {
    projects: [
      { id: projA, name: "Alpha Core", status: "active", decisions: [{ id: "d1", summary: "Keep local" }] },
      { id: projB, name: "Beta UI", status: "planning", decisions: [] }
    ],
    ideas: [
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Alpha cache", projectId: projA, tags: ["perf"] },
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Beta layout", projectId: projB, tags: ["css"] }
    ]
  };

  const scoped = buildKnowledgeGraph(data, { projectId: projA });
  const scopedIds = new Set(scoped.nodes.map((n) => n.id));
  assert.ok(scopedIds.has(`project:${projA}`));
  assert.ok(scopedIds.has("idea:cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  assert.ok(scopedIds.has("tag:perf"));
  assert.equal(scopedIds.has(`project:${projB}`), false);
  assert.equal(scopedIds.has("idea:dddddddd-dddd-4ddd-8ddd-dddddddddddd"), false);

  const kindFiltered = buildKnowledgeGraph(data, { kind: "project" });
  assert.equal(kindFiltered.nodes.length, 2);
  assert.ok(kindFiltered.nodes.every((n) => n.kind === "project"));

  const focused = buildKnowledgeGraph(data, { focusNodeId: `project:${projA}`, hops: 1 });
  assert.equal(focused.focus?.nodeId, `project:${projA}`);
  assert.ok(focused.focus.neighbors.some((n) => n.id === "idea:cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
});

test("computeGraphLayout produces deterministic bounded coordinates", () => {
  const projId = "11111111-1111-4111-8111-111111111111";
  const graph = buildKnowledgeGraph({
    projects: [{ id: projId, name: "Core", status: "active", decisions: [{ id: "d1", summary: "Deterministic" }] }],
    ideas: [{ id: "22222222-2222-4222-8222-222222222222", title: "Graph explorer", projectId: projId, tags: ["graph"] }]
  });

  const pos1 = computeGraphLayout(graph.nodes, graph.edges, { width: 760, height: 420 });
  const pos2 = computeGraphLayout(graph.nodes, graph.edges, { width: 760, height: 420 });

  for (const node of graph.nodes) {
    const a = pos1.get(node.id);
    const b = pos2.get(node.id);
    assert.deepEqual(a, b, `Layout should be deterministic for ${node.id}`);
    assert.ok(a.x >= 56 && a.x <= 704, `x within horizontal bounds: ${a.x}`);
    assert.ok(a.y >= 38 && a.y <= 382, `y within vertical bounds: ${a.y}`);
  }
});

test("GET /v1/graph enforces strict per-user isolation and returns user-scoped graph", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-graph-test-"));
  const identityAuth = createSignedIdentityAuth({ secret: PETRIO_SECRET, providerId: "petrio" });
  const projectStore = new ProjectStore({ dataDirectory: tmpDir });
  const memoryStore = new MemoryStore({ dataDirectory: tmpDir });
  const ideaStore = new IdeaStore({ dataDirectory: tmpDir });
  const watcherStore = new WatcherStore({ dataDirectory: tmpDir });
  const capsuleStore = new ContextCapsuleStore({ dataDirectory: tmpDir });
  const profileStore = new WorkflowProfileStore({ dataDirectory: tmpDir });

  const server = createAlfieCoreServer({
    serviceToken: SERVICE_TOKEN,
    identityAuth,
    projectStore,
    memoryStore,
    ideaStore,
    watcherStore,
    capsuleStore,
    profileStore
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const projectA = await projectStore.create("user-alpha", {
      name: "Alpha Secret Lab",
      decisions: [{ summary: "Keep encrypted", rationale: "Privacy" }]
    });
    await ideaStore.create("user-alpha", {
      title: "Alpha sensor #iot",
      projectId: projectA.id
    });
    await projectStore.create("user-beta", { name: "Beta Public App" });

    const reqPath = "/v1/graph";
    const headersA = {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      ...identityAuth.sign("user-alpha", { method: "GET", path: reqPath })
    };
    const resA = await fetch(`${baseUrl}${reqPath}`, { headers: headersA });
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    const labelsA = bodyA.graph.nodes.map((n) => n.label);
    assert.ok(labelsA.includes("Alpha Secret Lab"));
    assert.ok(labelsA.includes("#iot"));
    assert.equal(labelsA.includes("Beta Public App"), false);

    const headersB = {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      ...identityAuth.sign("user-beta", { method: "GET", path: reqPath })
    };
    const resB = await fetch(`${baseUrl}${reqPath}`, { headers: headersB });
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    const labelsB = bodyB.graph.nodes.map((n) => n.label);
    assert.ok(labelsB.includes("Beta Public App"));
    assert.equal(labelsB.includes("Alpha Secret Lab"), false);
    assert.equal(labelsB.includes("#iot"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
