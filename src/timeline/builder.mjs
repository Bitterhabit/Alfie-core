/**
 * Chronological Continuity Timeline & Portable Markdown Knowledge Digest (Phase 6.5)
 *
 * Pure deterministic aggregation across Living Project Dossiers, Decisions,
 * Typed Memories, Ideas Vault, Workshop Jobs, and Reflection Snapshots.
 */

function toTimestamp(iso) {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : 0;
}

export async function buildContinuityTimeline({
  userId,
  stores,
  projectId = "",
  kind = "all",
  limit = 40
}) {
  const cleanKind = String(kind || "all").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(120, Math.floor(Number(limit) || 40)));

  const [projects, memories, ideas, jobs, reflections] = await Promise.all([
    stores.projectStore ? stores.projectStore.list(userId) : [],
    stores.memoryStore ? stores.memoryStore.list(userId, { includeArchived: false }) : [],
    stores.ideaStore ? stores.ideaStore.list(userId) : [],
    stores.jobStore ? stores.jobStore.list(userId, { limit: 40 }) : [],
    stores.reflectionStore ? stores.reflectionStore.list(userId, { limit: 15 }) : []
  ]);

  const events = [];

  for (const p of projects) {
    if (projectId && p.id !== projectId) continue;
    events.push({
      id: `project:${p.id}`,
      kind: "project",
      title: p.name,
      detail: p.vision || p.description || `Project dossier (${p.status})`,
      projectId: p.id,
      trust: "user_authored",
      at: p.updatedAt || p.createdAt || ""
    });
    for (const d of Array.isArray(p.decisions) ? p.decisions : []) {
      const text = typeof d === "string" ? d : d?.text || d?.decision || "";
      if (!text) continue;
      events.push({
        id: `decision:${p.id}:${d?.id || text.slice(0, 24)}`,
        kind: "decision",
        title: `${p.name} — Decision`,
        detail: text + (d?.rationale ? ` (${d.rationale})` : ""),
        projectId: p.id,
        trust: "user_authored",
        at: d?.recordedAt || d?.createdAt || p.updatedAt || p.createdAt || ""
      });
    }
  }

  for (const m of memories) {
    if (projectId && m.projectId && m.projectId !== projectId) continue;
    events.push({
      id: `memory:${m.id}`,
      kind: "memory",
      title: m.title || `${String(m.kind || "note").toUpperCase()} memory`,
      detail: String(m.text || "").slice(0, 220),
      projectId: m.projectId || null,
      trust: m.trust || m.provenance?.trust || "user_authored",
      at: m.updatedAt || m.createdAt || ""
    });
  }

  for (const idea of ideas) {
    if (projectId && idea.projectId !== projectId) continue;
    events.push({
      id: `idea:${idea.id}`,
      kind: "idea",
      title: idea.title,
      detail: `[${idea.status} · ${idea.priority}] ${String(idea.notes || "").slice(0, 180)}`.trim(),
      projectId: idea.projectId || null,
      trust: "user_authored",
      at: idea.updatedAt || idea.createdAt || ""
    });
  }

  for (const job of jobs) {
    if (projectId && job.projectId !== projectId) continue;
    events.push({
      id: `job:${job.id}`,
      kind: "job",
      title: job.title,
      detail: job.artifact?.summary || `Status: ${job.status}`,
      projectId: job.projectId || null,
      trust: job.lowestTrustTouched || "user_authored",
      at: job.completedAt || job.updatedAt || job.createdAt || ""
    });
  }

  for (const snap of reflections) {
    if (projectId) continue;
    events.push({
      id: `reflection:${snap.id}`,
      kind: "reflection",
      title: `${String(snap.period || "weekly").toUpperCase()} Continuity Snapshot`,
      detail: Array.isArray(snap.highlights) && snap.highlights.length
        ? snap.highlights.slice(0, 2).join(" · ")
        : (snap.summary || "Periodic workspace digest"),
      projectId: null,
      trust: "system_verified",
      at: snap.generatedAt || ""
    });
  }

  const filtered = events
    .filter((ev) => (cleanKind === "all" ? true : ev.kind === cleanKind))
    .sort((a, b) => toTimestamp(b.at) - toTimestamp(a.at));

  const countsByKind = {};
  for (const ev of events) {
    countsByKind[ev.kind] = (countsByKind[ev.kind] || 0) + 1;
  }

  return {
    total: filtered.length,
    countsByKind,
    events: filtered.slice(0, safeLimit)
  };
}

/**
 * Generates a clean, self-contained Portable Markdown Knowledge Digest
 * across the user's projects, decisions, memories, ideas, and reflections.
 */
export async function exportMarkdownDigest({
  userId,
  stores,
  projectId = "",
  now = () => new Date().toISOString()
}) {
  const exportedAt = now();
  const [projects, memories, ideas, profile, reflections] = await Promise.all([
    stores.projectStore ? stores.projectStore.list(userId) : [],
    stores.memoryStore ? stores.memoryStore.list(userId, { includeArchived: false }) : [],
    stores.ideaStore ? stores.ideaStore.list(userId) : [],
    stores.profileStore ? stores.profileStore.get(userId) : null,
    stores.reflectionStore ? stores.reflectionStore.list(userId, { limit: 5 }) : []
  ]);

  const scopedProjects = projectId ? projects.filter((p) => p.id === projectId) : projects;
  const scopedIdeas = projectId ? ideas.filter((i) => i.projectId === projectId) : ideas;
  const lines = [];

  lines.push("# Alfie Sovereign Knowledge Digest");
  lines.push("");
  lines.push(`- **Exported:** ${exportedAt}`);
  lines.push(`- **Scope:** ${projectId && scopedProjects[0] ? `Project — ${scopedProjects[0].name}` : "Full Workspace"}`);
  lines.push(`- **Totals:** ${scopedProjects.length} project(s), ${memories.length} active memory record(s), ${scopedIdeas.length} idea(s)`);
  lines.push("");

  if (scopedProjects.length) {
    lines.push("## Living Project Dossiers");
    lines.push("");
    for (const p of scopedProjects) {
      lines.push(`### ${p.name} (${p.status || "active"})`);
      if (p.vision) lines.push(`- **Vision:** ${p.vision}`);
      if (p.architecture) lines.push(`- **Architecture:** ${p.architecture}`);
      if (Array.isArray(p.nextActions) && p.nextActions.length) {
        lines.push("- **Next actions:**");
        for (const a of p.nextActions) lines.push(`  - [ ] ${a}`);
      }
      if (Array.isArray(p.blockers) && p.blockers.length) {
        lines.push("- **Open blockers:**");
        for (const b of p.blockers) lines.push(`  - ${b}`);
      }
      if (Array.isArray(p.decisions) && p.decisions.length) {
        lines.push("- **Key decisions:**");
        for (const d of p.decisions) {
          const text = typeof d === "string" ? d : d?.text || d?.decision || "";
          if (text) lines.push(`  - ${text}${d?.rationale ? ` — *${d.rationale}*` : ""}`);
        }
      }
      lines.push("");
    }
  }

  if (!projectId && memories.length) {
    lines.push("## Typed Memories (The Garden)");
    lines.push("");
    for (const m of memories.slice(0, 80)) {
      const kind = String(m.kind || "note").toUpperCase();
      const trust = m.trust || m.provenance?.trust || "user_authored";
      lines.push(`- **[${kind} · ${trust}]** ${m.text}`);
    }
    lines.push("");
  }

  if (scopedIdeas.length) {
    lines.push("## Ideas Vault");
    lines.push("");
    for (const idea of scopedIdeas.slice(0, 60)) {
      lines.push(`- **${idea.title}** *(${idea.status} · ${idea.priority})*${idea.notes ? ` — ${idea.notes}` : ""}`);
    }
    lines.push("");
  }

  if (!projectId && profile?.learningTopics?.length) {
    lines.push("## Learning Companion Topics");
    lines.push("");
    for (const t of profile.learningTopics) {
      lines.push(`- **${t.topic}** (${t.posture || "explain_as_you_go"})${t.notes ? ` — ${t.notes}` : ""}`);
    }
    lines.push("");
  }

  if (!projectId && reflections.length) {
    lines.push("## Recent Continuity Reflections");
    lines.push("");
    for (const r of reflections.slice(0, 3)) {
      lines.push(`### ${String(r.period || "weekly").toUpperCase()} (${r.generatedAt || ""})`);
      for (const h of r.highlights || []) lines.push(`- ${h}`);
      lines.push("");
    }
  }

  const markdown = lines.join("\n").trim() + "\n";
  return {
    exportedAt,
    filename: `alfie-knowledge-digest-${exportedAt.slice(0, 10)}.md`,
    byteLength: Buffer.byteLength(markdown, "utf8"),
    markdown
  };
}
