const SVG_NS = "http://www.w3.org/2000/svg";

export const GRAPH_KIND_LABELS = Object.freeze({
  project: "Project",
  decision: "Decision",
  memory: "Memory",
  idea: "Idea",
  tag: "Tag",
  capsule: "Capsule",
  watcher: "Watcher",
  topic: "Learning topic"
});

export const GRAPH_RELATION_LABELS = Object.freeze({
  decided_in: "Decided in",
  belongs_to: "Linked to project",
  scopes_project: "Scopes project",
  monitors: "Monitors project",
  tagged_with: "Tagged with",
  related_memory: "Related memory",
  mentions_project: "Mentions project",
  relevant_to: "Relevant to"
});

export const GRAPH_TRUST_LABELS = Object.freeze({
  user_authored: "User authored",
  system_verified: "System verified",
  external_untrusted: "External untrusted"
});

function truncateLabel(value, maxLen = 20) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(1, maxLen - 1)).trimEnd() + "…";
}

function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Deterministic radial/cluster layout for Alfie's Personal Knowledge Graph.
 * Zero randomness, zero continuous animation loops, crisp collision relaxation.
 */
export function computeGraphLayout(nodes = [], edges = [], { width = 760, height = 420 } = {}) {
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(140, width * 0.40);
  const ry = Math.max(110, height * 0.38);

  const positions = new Map();
  const projects = nodes.filter((n) => n.kind === "project");
  const primaryCount = projects.length;

  // Inner ring: Projects
  projects.forEach((node, idx) => {
    const angle = (idx / Math.max(1, primaryCount)) * Math.PI * 2 - Math.PI / 2;
    const radiusScale = primaryCount === 1 ? 0 : (primaryCount <= 3 ? 0.32 : 0.44);
    positions.set(node.id, {
      x: cx + Math.cos(angle) * rx * radiusScale,
      y: cy + Math.sin(angle) * ry * radiusScale,
      r: 17
    });
  });

  // Group non-project nodes by parent project if linked, else outer thematic ring
  const byProject = new Map();
  const unlinked = [];
  for (const node of nodes) {
    if (node.kind === "project") continue;
    if (node.projectId && positions.has(`project:${node.projectId}`)) {
      const key = `project:${node.projectId}`;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(node);
    } else {
      unlinked.push(node);
    }
  }

  for (const [projNodeId, children] of byProject.entries()) {
    const anchor = positions.get(projNodeId);
    const baseAngle = Math.atan2(anchor.y - cy, anchor.x - cx);
    const spread = primaryCount <= 1 ? Math.PI * 2 : Math.PI * 1.15;
    const localR = primaryCount <= 1 ? Math.min(rx, ry) * 0.62 : Math.min(118, Math.max(76, 62 + children.length * 7));

    children.forEach((child, idx) => {
      const frac = children.length === 1 ? 0 : (idx / (primaryCount <= 1 ? children.length : Math.max(1, children.length - 1)) - 0.5);
      const angle = baseAngle + frac * spread;
      const r = child.kind === "decision" || child.kind === "capsule" ? 12 : 11;
      positions.set(child.id, {
        x: anchor.x + Math.cos(angle) * localR,
        y: anchor.y + Math.sin(angle) * localR,
        r
      });
    });
  }

  // Outer harmonic ring for unlinked memories, ideas, tags, watchers, and learning topics
  const ringOrder = ["tag", "idea", "memory", "topic", "watcher", "capsule", "decision"];
  unlinked.sort((a, b) => {
    const ka = ringOrder.indexOf(a.kind);
    const kb = ringOrder.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return (b.degree || 0) - (a.degree || 0) || a.id.localeCompare(b.id);
  });

  const outerCount = unlinked.length;
  unlinked.forEach((node, idx) => {
    const angle = (idx / Math.max(1, outerCount)) * Math.PI * 2 - Math.PI / 2;
    const band = primaryCount === 0
      ? (idx % 2 === 0 ? 0.56 : 0.86)
      : (node.kind === "tag" ? 0.72 : 0.94);
    const jitter = (hashString(node.id) - 0.5) * 0.08;
    const r = node.kind === "tag" ? 10 : 11;
    positions.set(node.id, {
      x: cx + Math.cos(angle) * rx * (band + jitter),
      y: cy + Math.sin(angle) * ry * (band + jitter),
      r
    });
  });

  // Deterministic collision relaxation so nodes & labels stay readable
  const ids = nodes.map((n) => n.id);
  const padX = 56;
  const padY = 38;
  const minDist = 48;

  for (let iter = 0; iter < 14; iter += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      const a = positions.get(ids[i]);
      if (!a) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = positions.get(ids[j]);
        if (!b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 1;
          dy = 0.5;
          dist = Math.hypot(dx, dy);
        }
        if (dist < minDist) {
          const push = (minDist - dist) * 0.45;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
      a.x = Math.max(padX, Math.min(width - padX, a.x));
      a.y = Math.max(padY, Math.min(height - padY, a.y));
    }
  }

  return positions;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  return el;
}

export function renderKnowledgeGraphSvg(container, graph, {
  selectedNodeId = null,
  zoom = 1,
  onSelectNode = () => {}
} = {}) {
  if (!container) return;
  container.replaceChildren();

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "kg-empty-state";
    const title = document.createElement("strong");
    title.textContent = "No connected knowledge nodes match the current filter.";
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Add a Project, Idea with #hashtags, Memory, Context Capsule, or Watcher to watch Alfie connect your context automatically.";
    empty.append(title, hint);
    container.appendChild(empty);
    return;
  }

  const width = 760;
  const height = 420;
  const safeZoom = Math.max(0.75, Math.min(1.65, Number(zoom) || 1));
  const vbW = width / safeZoom;
  const vbH = height / safeZoom;
  const vbX = (width - vbW) / 2;
  const vbY = (height - vbH) / 2;

  const positions = computeGraphLayout(nodes, edges, { width, height });

  const neighborIds = new Set();
  const activeEdgeIds = new Set();
  if (selectedNodeId) {
    neighborIds.add(selectedNodeId);
    for (const edge of edges) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        activeEdgeIds.add(edge.id);
        neighborIds.add(edge.source);
        neighborIds.add(edge.target);
      }
    }
  }

  const svg = svgEl("svg", {
    class: "kg-svg",
    viewBox: `${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`,
    role: "img",
    "aria-label": `Personal Knowledge Graph showing ${nodes.length} nodes and ${edges.length} connections`
  });

  // Subtle orbital guide rings for visual grounding
  const guides = svgEl("g", { class: "kg-guides", "aria-hidden": "true" });
  guides.appendChild(svgEl("ellipse", { cx: width / 2, cy: height / 2, rx: width * 0.22, ry: height * 0.22, class: "kg-guide-ring" }));
  guides.appendChild(svgEl("ellipse", { cx: width / 2, cy: height / 2, rx: width * 0.40, ry: height * 0.38, class: "kg-guide-ring" }));
  svg.appendChild(guides);

  // Edges layer
  const edgesLayer = svgEl("g", { class: "kg-edges" });
  for (const edge of edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const isHighlighted = activeEdgeIds.has(edge.id);
    const isDimmed = Boolean(selectedNodeId && !isHighlighted);
    const line = svgEl("line", {
      x1: a.x.toFixed(1),
      y1: a.y.toFixed(1),
      x2: b.x.toFixed(1),
      y2: b.y.toFixed(1),
      class: `kg-edge kg-edge-${edge.relation}${isHighlighted ? " is-highlighted" : ""}${isDimmed ? " is-dimmed" : ""}`
    });
    edgesLayer.appendChild(line);
  }
  svg.appendChild(edgesLayer);

  // Nodes layer
  const nodesLayer = svgEl("g", { class: "kg-nodes" });
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const isSelected = node.id === selectedNodeId;
    const isNeighbor = neighborIds.has(node.id);
    const isDimmed = Boolean(selectedNodeId && !isNeighbor);
    const isUntrusted = node.trust === "external_untrusted";

    const group = svgEl("g", {
      class: `kg-node kg-kind-${node.kind}${isSelected ? " is-selected" : ""}${isDimmed ? " is-dimmed" : ""}${isUntrusted ? " is-untrusted" : ""}`,
      transform: `translate(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
      role: "button",
      tabindex: "0",
      "data-node-id": node.id,
      "data-node-kind": node.kind,
      "aria-label": `${GRAPH_KIND_LABELS[node.kind] || node.kind}: ${node.label}`
    });

    const titleEl = svgEl("title");
    titleEl.textContent = `${GRAPH_KIND_LABELS[node.kind] || node.kind} · ${node.label} (${node.subtitle || ""})`;
    group.appendChild(titleEl);

    if (isSelected) {
      group.appendChild(svgEl("circle", { r: pos.r + 5, class: "kg-node-focus-ring" }));
    }

    if (node.kind === "decision" || node.kind === "capsule") {
      const s = pos.r * 1.48;
      group.appendChild(svgEl("rect", {
        x: (-s / 2).toFixed(1),
        y: (-s / 2).toFixed(1),
        width: s.toFixed(1),
        height: s.toFixed(1),
        rx: node.kind === "capsule" ? "5" : "2",
        transform: node.kind === "decision" ? "rotate(45)" : undefined,
        class: "kg-node-shape"
      }));
    } else {
      group.appendChild(svgEl("circle", {
        r: pos.r,
        class: "kg-node-shape"
      }));
    }

    const label = svgEl("text", {
      y: (pos.r + 14).toFixed(1),
      "text-anchor": "middle",
      class: "kg-node-label"
    });
    label.textContent = truncateLabel(node.label, node.kind === "project" ? 22 : 18);
    group.appendChild(label);

    const activate = () => onSelectNode(node.id);
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });

    nodesLayer.appendChild(group);
  }
  svg.appendChild(nodesLayer);
  container.appendChild(svg);
}

if (typeof window !== "undefined") {
  window.AlfieKnowledgeGraph = Object.freeze({
    GRAPH_KIND_LABELS,
    GRAPH_RELATION_LABELS,
    GRAPH_TRUST_LABELS,
    computeGraphLayout,
    renderKnowledgeGraphSvg
  });
}
