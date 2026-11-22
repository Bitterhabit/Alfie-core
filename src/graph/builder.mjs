import { PROJECT_ID_PATTERN } from "../projects/store.mjs";

export const GRAPH_NODE_KINDS = Object.freeze([
  "project",
  "decision",
  "memory",
  "idea",
  "tag",
  "capsule",
  "watcher",
  "topic"
]);

const ALLOWED_KINDS = new Set(GRAPH_NODE_KINDS);
const MAX_NODES = 120;
const MAX_EDGES = 260;

function truncate(value, maxLen = 180) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(1, maxLen - 1)).trimEnd() + "…";
}

function normaliseToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWordPattern(phrase) {
  const cleaned = String(phrase || "").trim();
  if (cleaned.length < 3) return null;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(cleaned)}([^a-z0-9]|$)`, "i");
}

function addEdge(edgeMap, source, target, relation, weight = 1) {
  if (!source || !target || source === target) return;
  const key = `${source}|${relation}|${target}`;
  if (edgeMap.has(key)) return;
  edgeMap.set(key, {
    id: key,
    source,
    target,
    relation,
    weight
  });
}

function computeHopDistances(adjacency, startNodeId, maxHops = 2) {
  const distances = new Map();
  if (!startNodeId || !adjacency.has(startNodeId)) return distances;
  const queue = [[startNodeId, 0]];
  distances.set(startNodeId, 0);
  while (queue.length) {
    const [current, dist] = queue.shift();
    if (dist >= maxHops) continue;
    const neighbors = adjacency.get(current) || [];
    for (const nextId of neighbors) {
      if (!distances.has(nextId)) {
        distances.set(nextId, dist + 1);
        queue.push([nextId, dist + 1]);
      }
    }
  }
  return distances;
}

/**
 * Deterministically builds a cross-entity Personal Knowledge Graph from
 * user-owned Core stores with zero LLM calls and preserved trust provenance.
 */
export function buildKnowledgeGraph(data = {}, options = {}) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const memories = Array.isArray(data.memories) ? data.memories : [];
  const ideas = Array.isArray(data.ideas) ? data.ideas : [];
  const watchers = Array.isArray(data.watchers) ? data.watchers : [];
  const capsules = Array.isArray(data.capsules) ? data.capsules : [];
  const learningTopics = Array.isArray(data.learningTopics)
    ? data.learningTopics
    : (Array.isArray(data.profile?.learningTopics) ? data.profile.learningTopics : []);

  const kindFilter = options.kind && ALLOWED_KINDS.has(String(options.kind).trim().toLowerCase())
    ? String(options.kind).trim().toLowerCase()
    : "";
  const projectFilter = options.projectId && PROJECT_ID_PATTERN.test(String(options.projectId).trim())
    ? String(options.projectId).trim()
    : "";
  const query = String(options.query || options.q || "").trim().toLowerCase().slice(0, 120);
  const focusNodeId = String(options.focusNodeId || "").trim().slice(0, 160);
  const hops = Math.max(1, Math.min(2, Number.isFinite(Number(options.hops)) ? Math.round(Number(options.hops)) : 2));

  const nodeMap = new Map();
  const edgeMap = new Map();
  const tagRefCounts = new Map();

  function upsertNode(node) {
    if (!node?.id || nodeMap.has(node.id)) return;
    nodeMap.set(node.id, node);
  }

  function ensureTagNode(rawTag) {
    const norm = normaliseToken(rawTag);
    if (!norm || norm.length < 2) return null;
    const id = `tag:${norm}`;
    tagRefCounts.set(id, (tagRefCounts.get(id) || 0) + 1);
    if (!nodeMap.has(id)) {
      upsertNode({
        id,
        entityId: norm,
        kind: "tag",
        label: `#${norm}`,
        subtitle: "Shared theme",
        summary: `Theme linking ideas, memories, and topics tagged with #${norm}.`,
        trust: "system_verified",
        projectId: null,
        tags: [norm],
        priorityScore: 2,
        meta: { tag: norm }
      });
    }
    return id;
  }

  // 1. Projects + embedded Decisions
  const projectMatchers = [];
  for (const project of projects) {
    if (!project?.id) continue;
    const projectNodeId = `project:${project.id}`;
    const blockersCount = Array.isArray(project.blockers) ? project.blockers.length : 0;
    const nextCount = Array.isArray(project.nextActions) ? project.nextActions.length : 0;
    const decisions = Array.isArray(project.decisions) ? project.decisions : [];

    upsertNode({
      id: projectNodeId,
      entityId: project.id,
      kind: "project",
      label: truncate(project.name || "Untitled project", 64),
      subtitle: `${project.status || "active"} · ${decisions.length} decision${decisions.length === 1 ? "" : "s"}`,
      summary: truncate(project.vision || project.description || project.architecture || "Living project dossier.", 220),
      trust: "user_authored",
      projectId: project.id,
      tags: [],
      priorityScore: project.status === "active" ? 10 : 7,
      meta: {
        status: project.status || "active",
        color: project.color || "purple",
        blockersCount,
        nextActionsCount: nextCount,
        decisionsCount: decisions.length,
        updatedAt: project.updatedAt || null
      }
    });

    const pattern = buildWordPattern(project.name);
    if (pattern) {
      projectMatchers.push({ projectId: project.id, nodeId: projectNodeId, nameLower: String(project.name).toLowerCase(), pattern });
    }

    for (const decision of decisions) {
      if (!decision?.summary) continue;
      const decId = `decision:${project.id}:${decision.id || normaliseToken(decision.summary).slice(0, 24)}`;
      upsertNode({
        id: decId,
        entityId: decision.id || decId,
        kind: "decision",
        label: truncate(decision.summary, 64),
        subtitle: `Decision · ${truncate(project.name, 32)}`,
        summary: truncate(decision.rationale ? `${decision.summary} — ${decision.rationale}` : decision.summary, 220),
        trust: "user_authored",
        projectId: project.id,
        tags: [],
        priorityScore: 7,
        meta: {
          projectName: project.name,
          createdAt: decision.createdAt || null
        }
      });
      addEdge(edgeMap, decId, projectNodeId, "decided_in", 2);
    }
  }

  // 2. Memories (preserving ADR-003 trust provenance)
  const memoryIdToNodeId = new Map();
  for (const memory of memories) {
    if (!memory?.id) continue;
    const memNodeId = `memory:${memory.id}`;
    memoryIdToNodeId.set(memory.id, memNodeId);
    const trust = memory.trust || (memory.origin === "external" ? "external_untrusted" : "user_authored");
    const kind = memory.kind || "note";
    const importance = Number.isFinite(Number(memory.importance)) ? Number(memory.importance) : 5;
    const tags = Array.isArray(memory.tags) ? memory.tags.map(normaliseToken).filter(Boolean) : [];
    const text = String(memory.text || memory.content || "");

    let linkedProjectId = null;
    for (const matcher of projectMatchers) {
      if (matcher.pattern.test(text) || tags.includes(normaliseToken(matcher.nameLower))) {
        linkedProjectId = linkedProjectId || matcher.projectId;
        addEdge(edgeMap, memNodeId, matcher.nodeId, "mentions_project", 1.5);
      }
    }

    upsertNode({
      id: memNodeId,
      entityId: memory.id,
      kind: "memory",
      label: truncate(text, 56),
      subtitle: `${kind} · importance ${importance}/10`,
      summary: truncate(text, 220),
      trust,
      projectId: linkedProjectId,
      tags,
      priorityScore: Math.max(3, Math.min(9, importance)),
      meta: {
        memoryKind: kind,
        importance,
        origin: memory.origin || "manual",
        archived: Boolean(memory.archived),
        updatedAt: memory.updatedAt || memory.createdAt || null
      }
    });

    for (const tag of tags) {
      const tagNodeId = ensureTagNode(tag);
      if (tagNodeId) addEdge(edgeMap, memNodeId, tagNodeId, "tagged_with", 1);
    }
  }

  // Explicit memory-to-memory relationships
  for (const memory of memories) {
    if (!memory?.id || !Array.isArray(memory.relationships)) continue;
    const sourceId = memoryIdToNodeId.get(memory.id);
    if (!sourceId) continue;
    for (const rel of memory.relationships) {
      const targetId = memoryIdToNodeId.get(rel?.targetId);
      if (targetId) {
        addEdge(edgeMap, sourceId, targetId, rel.type || "related_memory", 2);
      }
    }
  }

  // 3. Ideas Vault
  for (const idea of ideas) {
    if (!idea?.id) continue;
    const ideaNodeId = `idea:${idea.id}`;
    const tags = Array.isArray(idea.tags) ? idea.tags.map(normaliseToken).filter(Boolean) : [];
    const priorityWeight = idea.priority === "high" ? 8 : (idea.priority === "medium" ? 6 : 4);
    const linkedProjectId = idea.projectId && nodeMap.has(`project:${idea.projectId}`) ? idea.projectId : null;

    upsertNode({
      id: ideaNodeId,
      entityId: idea.id,
      kind: "idea",
      label: truncate(idea.title || "Untitled idea", 60),
      subtitle: `${idea.status || "inbox"} · ${idea.priority || "medium"} priority`,
      summary: truncate(idea.body || idea.sourceContext || idea.title, 220),
      trust: "user_authored",
      projectId: linkedProjectId,
      tags,
      priorityScore: priorityWeight,
      meta: {
        status: idea.status || "inbox",
        priority: idea.priority || "medium",
        updatedAt: idea.updatedAt || idea.createdAt || null
      }
    });

    if (linkedProjectId) {
      addEdge(edgeMap, ideaNodeId, `project:${linkedProjectId}`, "belongs_to", 2);
    }
    for (const tag of tags) {
      const tagNodeId = ensureTagNode(tag);
      if (tagNodeId) addEdge(edgeMap, ideaNodeId, tagNodeId, "tagged_with", 1);
    }
  }

  // 4. Context Capsules
  for (const capsule of capsules) {
    if (!capsule?.id) continue;
    const capNodeId = `capsule:${capsule.id}`;
    const linkedProjectId = capsule.projectId && nodeMap.has(`project:${capsule.projectId}`) ? capsule.projectId : null;
    upsertNode({
      id: capNodeId,
      entityId: capsule.id,
      kind: "capsule",
      label: truncate(capsule.name || "Context capsule", 56),
      subtitle: `${capsule.workingMode || "companion"} · ${capsule.privacyPosture || "local_only"}`,
      summary: truncate(capsule.description || `Workspace binding ${capsule.workingMode || "companion"} posture and ${capsule.learningMode || "explain"} learning mode.`, 200),
      trust: "user_authored",
      projectId: linkedProjectId,
      tags: [],
      priorityScore: 6,
      meta: {
        workingMode: capsule.workingMode || "companion",
        learningMode: capsule.learningMode || "explain",
        privacyPosture: capsule.privacyPosture || "local_only"
      }
    });
    if (linkedProjectId) {
      addEdge(edgeMap, capNodeId, `project:${linkedProjectId}`, "scopes_project", 2);
    }
  }

  // 5. Deterministic Watchers
  for (const watcher of watchers) {
    if (!watcher?.id) continue;
    const watcherNodeId = `watcher:${watcher.id}`;
    const targetProjectId = watcher.config?.projectId && nodeMap.has(`project:${watcher.config.projectId}`)
      ? watcher.config.projectId
      : null;
    const trust = watcher.lastTrust === "external_untrusted" || watcher.kind === "http_probe"
      ? "external_untrusted"
      : "system_verified";

    upsertNode({
      id: watcherNodeId,
      entityId: watcher.id,
      kind: "watcher",
      label: truncate(watcher.name || "Watcher", 56),
      subtitle: `${watcher.kind || "watcher"} · ${watcher.tier || "notify"} · ${watcher.enabled === false ? "paused" : (watcher.lastStatus || "ready")}`,
      summary: truncate(watcher.lastSummary || `Deterministic ${watcher.kind} monitor routed at ${watcher.tier} tier.`, 200),
      trust,
      projectId: targetProjectId,
      tags: [],
      priorityScore: watcher.lastStatus === "alert" ? 8 : 5,
      meta: {
        watcherKind: watcher.kind,
        tier: watcher.tier,
        enabled: watcher.enabled !== false,
        lastStatus: watcher.lastStatus || "unknown",
        quietHours: watcher.quietHours || null
      }
    });
    if (targetProjectId) {
      addEdge(edgeMap, watcherNodeId, `project:${targetProjectId}`, "monitors", 2);
    }
  }

  // 6. Learning Topics
  for (const topic of learningTopics) {
    if (!topic?.id || !topic?.topic) continue;
    const topicNodeId = `topic:${topic.id}`;
    const topicNorm = normaliseToken(topic.topic);
    let linkedProjectId = null;

    upsertNode({
      id: topicNodeId,
      entityId: topic.id,
      kind: "topic",
      label: truncate(topic.topic, 56),
      subtitle: `Learning · ${topic.confidence || "exploring"}`,
      summary: truncate(topic.notes || `Self-tracked learning topic at "${topic.confidence || "exploring"}" confidence.`, 200),
      trust: "user_authored",
      projectId: null,
      tags: topicNorm ? [topicNorm] : [],
      priorityScore: 5,
      meta: {
        confidence: topic.confidence || "exploring"
      }
    });

    // Connect topic to matching projects or tags deterministically
    const topicWords = String(topic.topic).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    for (const matcher of projectMatchers) {
      if (matcher.pattern.test(topic.topic) || topicWords.some((w) => matcher.nameLower.includes(w))) {
        linkedProjectId = linkedProjectId || matcher.projectId;
        addEdge(edgeMap, topicNodeId, matcher.nodeId, "relevant_to", 1.5);
      }
    }
    for (const word of topicWords) {
      const candidateTagId = `tag:${normaliseToken(word)}`;
      if (nodeMap.has(candidateTagId)) {
        addEdge(edgeMap, topicNodeId, candidateTagId, "relevant_to", 1);
      }
    }
    if (linkedProjectId) {
      nodeMap.get(topicNodeId).projectId = linkedProjectId;
    }
  }

  // Update tag subtitle with accurate connection count
  for (const [tagId, count] of tagRefCounts.entries()) {
    const tagNode = nodeMap.get(tagId);
    if (tagNode) {
      tagNode.subtitle = `Tag · ${count} reference${count === 1 ? "" : "s"}`;
      tagNode.priorityScore = Math.min(8, 2 + count);
    }
  }

  // Build undirected adjacency for degree & multi-hop neighborhood traversal
  const adjacency = new Map();
  for (const id of nodeMap.keys()) adjacency.set(id, new Set());
  for (const edge of edgeMap.values()) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }

  // Apply scoping filters cleanly
  let candidateIds = new Set(nodeMap.keys());

  if (projectFilter) {
    const rootProjectNodeId = `project:${projectFilter}`;
    if (nodeMap.has(rootProjectNodeId)) {
      const reachable = computeHopDistances(adjacency, rootProjectNodeId, 2);
      candidateIds = new Set([...candidateIds].filter((id) => reachable.has(id) || nodeMap.get(id)?.projectId === projectFilter));
    } else {
      candidateIds = new Set();
    }
  }

  if (query) {
    const matched = new Set();
    for (const id of candidateIds) {
      const n = nodeMap.get(id);
      const hay = `${n.label} ${n.subtitle} ${n.summary} ${(n.tags || []).join(" ")}`.toLowerCase();
      if (hay.includes(query)) matched.add(id);
    }
    // Keep 1-hop context for direct query matches so relationships remain visible
    const expanded = new Set(matched);
    for (const id of matched) {
      for (const neighbor of (adjacency.get(id) || [])) {
        if (candidateIds.has(neighbor)) expanded.add(neighbor);
      }
    }
    candidateIds = expanded;
  }

  if (kindFilter) {
    candidateIds = new Set([...candidateIds].filter((id) => nodeMap.get(id)?.kind === kindFilter));
  }

  const focusDistances = focusNodeId && candidateIds.has(focusNodeId)
    ? computeHopDistances(adjacency, focusNodeId, hops)
    : null;

  // Deterministic ranking & cap for crisp visualization
  const sortedNodes = [...candidateIds]
    .map((id) => {
      const node = nodeMap.get(id);
      const degree = [...(adjacency.get(id) || [])].filter((nId) => candidateIds.has(nId)).length;
      const distance = focusDistances ? (focusDistances.has(id) ? focusDistances.get(id) : null) : null;
      return {
        ...node,
        degree,
        ...(focusDistances ? { distance } : {})
      };
    })
    .sort((a, b) => {
      if (focusDistances) {
        const da = a.distance ?? 99;
        const db = b.distance ?? 99;
        if (da !== db) return da - db;
      }
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_NODES);

  const keptIds = new Set(sortedNodes.map((n) => n.id));
  const keptEdges = [...edgeMap.values()]
    .filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
    .sort((a, b) => (b.weight - a.weight) || a.id.localeCompare(b.id))
    .slice(0, MAX_EDGES);

  // Recompute visible degree based on keptEdges
  const visibleDegree = new Map();
  for (const edge of keptEdges) {
    visibleDegree.set(edge.source, (visibleDegree.get(edge.source) || 0) + 1);
    visibleDegree.set(edge.target, (visibleDegree.get(edge.target) || 0) + 1);
  }
  const finalNodes = sortedNodes.map(({ priorityScore, ...rest }) => ({
    ...rest,
    degree: visibleDegree.get(rest.id) || 0
  }));

  const countsByKind = {};
  for (const kind of GRAPH_NODE_KINDS) countsByKind[kind] = 0;
  let untrustedNodeCount = 0;
  for (const node of finalNodes) {
    countsByKind[node.kind] = (countsByKind[node.kind] || 0) + 1;
    if (node.trust === "external_untrusted") untrustedNodeCount += 1;
  }

  // Optional direct neighborhood summary for focused node
  let focus = null;
  if (focusNodeId && keptIds.has(focusNodeId)) {
    const neighbors = [];
    for (const edge of keptEdges) {
      if (edge.source === focusNodeId) {
        const target = nodeMap.get(edge.target);
        if (target) neighbors.push({ id: target.id, label: target.label, kind: target.kind, relation: edge.relation, direction: "outgoing", trust: target.trust });
      } else if (edge.target === focusNodeId) {
        const source = nodeMap.get(edge.source);
        if (source) neighbors.push({ id: source.id, label: source.label, kind: source.kind, relation: edge.relation, direction: "incoming", trust: source.trust });
      }
    }
    focus = {
      nodeId: focusNodeId,
      hops,
      neighbors
    };
  }

  return {
    nodes: finalNodes,
    edges: keptEdges,
    stats: {
      totalNodes: finalNodes.length,
      totalEdges: keptEdges.length,
      countsByKind,
      untrustedNodeCount
    },
    filters: {
      projectId: projectFilter || null,
      kind: kindFilter || null,
      query: query || null,
      focusNodeId: focus ? focusNodeId : null
    },
    ...(focus ? { focus } : {})
  };
}

export async function buildUserKnowledgeGraph(userId, stores, options = {}) {
  const [projects, memories, ideas, watchers, capsulesRes, profile] = await Promise.all([
    stores.projectStore ? stores.projectStore.list(userId) : [],
    stores.memoryStore ? stores.memoryStore.list(userId, { includeArchived: false, includeExpired: false, limit: 100 }) : [],
    stores.ideaStore ? stores.ideaStore.list(userId, { status: "" }) : [],
    stores.watcherStore ? stores.watcherStore.list(userId) : [],
    stores.capsuleStore ? stores.capsuleStore.list(userId) : { capsules: [] },
    stores.profileStore ? stores.profileStore.get(userId) : null
  ]);

  return buildKnowledgeGraph({
    projects,
    memories,
    ideas,
    watchers,
    capsules: capsulesRes?.capsules || [],
    profile
  }, options);
}
