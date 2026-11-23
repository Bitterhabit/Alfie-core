import { buildUserKnowledgeGraph } from "../graph/builder.mjs";
import { hybridSearchWorkspace } from "../retrieval/hybrid.mjs";

/**
 * Bounded Multi-Agent Workshop (ADR-004)
 *
 * Alfie coordinates isolated specialist roles under strict per-role capability
 * ceilings intersected with the user's granted leases (never escalating access,
 * never self-approving writes) and propagates ADR-003 taint provenance.
 */

export const SPECIALIST_ROLES = Object.freeze({
  researcher: Object.freeze({
    id: "researcher",
    label: "Researcher",
    description: "Synthesizes memories, ideas, notes, and knowledge graph links around a question or project.",
    allowedScopes: Object.freeze(["memory:read", "notes:read", "github:read"]),
    maxRisk: "read",
    maxSteps: 4,
    tokenBudget: 3200
  }),
  auditor: Object.freeze({
    id: "auditor",
    label: "Auditor",
    description: "Inspects blockers, capability leases, watcher health, untrusted provenance, and operational risks.",
    allowedScopes: Object.freeze(["memory:read", "homelab:read", "notes:read"]),
    maxRisk: "read",
    maxSteps: 4,
    tokenBudget: 3200
  }),
  planner: Object.freeze({
    id: "planner",
    label: "Planner",
    description: "Decomposes a project dossier and parked ideas into concrete milestones, dependencies, and next steps.",
    allowedScopes: Object.freeze(["memory:read", "notes:read"]),
    maxRisk: "read",
    maxSteps: 4,
    tokenBudget: 3200
  }),
  developer: Object.freeze({
    id: "developer",
    label: "Developer",
    description: "Reviews architecture, decisions, blockers, and technical notes to draft an implementation plan.",
    allowedScopes: Object.freeze(["memory:read", "notes:read", "github:read", "github:draft"]),
    maxRisk: "draft",
    maxSteps: 5,
    tokenBudget: 4000
  })
});

export function listSpecialistRoles() {
  return Object.values(SPECIALIST_ROLES);
}

/**
 * Computes the strict effective scope ceiling for a specialist sub-agent:
 * always the intersection of role.allowedScopes and userGrantedScopes.
 * A sub-agent can NEVER escalate permissions beyond what the user granted.
 */
export function computeSubAgentScopes(roleId, userGrantedScopes = []) {
  const role = SPECIALIST_ROLES[String(roleId || "").trim().toLowerCase()];
  if (!role) {
    throw Object.assign(new Error("Unknown specialist role. Use researcher, auditor, planner, or developer."), {
      status: 400,
      code: "UNKNOWN_SPECIALIST_ROLE"
    });
  }
  const grantedSet = new Set(Array.isArray(userGrantedScopes) ? userGrantedScopes : []);
  return role.allowedScopes.filter((scope) => grantedSet.has(scope));
}

export async function createWorkshopTask({
  userId,
  roleId,
  objective,
  projectId = null,
  stores,
  dataDirectory,
  existingJob = null
}) {
  const cleanRoleId = String(roleId || "").trim().toLowerCase();
  const role = SPECIALIST_ROLES[cleanRoleId];
  if (!role) {
    throw Object.assign(new Error("Unknown specialist role. Use researcher, auditor, planner, or developer."), {
      status: 400,
      code: "UNKNOWN_SPECIALIST_ROLE"
    });
  }
  const cleanObjective = String(objective || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!cleanObjective) {
    throw Object.assign(new Error("An objective is required to delegate a workshop task."), { status: 400 });
  }

  const grantedScopes = stores.permissionStore
    ? await stores.permissionStore.list(userId, { projectId })
    : [];
  const grantedRoleScopes = computeSubAgentScopes(cleanRoleId, grantedScopes);
  const effectiveScopes = existingJob
    ? grantedRoleScopes.filter((scope) => (existingJob.capabilityCeiling || []).includes(scope))
    : grantedRoleScopes;

  const job = existingJob || await stores.jobStore.create(userId, {
    kind: "subagent_delegation",
    role: role.id,
    title: `${role.label}: ${cleanObjective.slice(0, 72)}`,
    objective: cleanObjective,
    projectId,
    maxSteps: role.maxSteps,
    tokenBudget: role.tokenBudget,
    capabilityCeiling: effectiveScopes
  });

  const steps = [
    {
      name: "Load scoped context & enforce capability ceiling",
      async run({ context }) {
        const [projects, ideas, watchers, permDetail] = await Promise.all([
          stores.projectStore ? stores.projectStore.list(userId) : [],
          stores.ideaStore ? stores.ideaStore.list(userId) : [],
          stores.watcherStore ? stores.watcherStore.list(userId) : [],
          stores.permissionStore ? stores.permissionStore.listDetailed(userId) : { leases: [] }
        ]);
        const permissions = Array.isArray(permDetail?.leases) ? permDetail.leases : [];
        const project = projectId ? projects.find((p) => p.id === projectId) || null : null;
        context.metadata.project = project ? { id: project.id, name: project.name, status: project.status } : null;
        context.metadata.role = role.id;
        context.metadata.effectiveScopes = effectiveScopes;
        context.metadata.maxRisk = role.maxRisk;
        context._raw = { projects, project, ideas, watchers, permissions };
        return {
          summary: `Scoped ${role.label} with ceiling [${effectiveScopes.join(", ") || "context-only"}] (max risk: ${role.maxRisk}).`
        };
      }
    },
    {
      name: "Retrieve relevant workspace records via hybrid search",
      async run({ context, recordTrust }) {
        const search = await hybridSearchWorkspace(dataDirectory, userId, {
          q: cleanObjective,
          limit: 12,
          mode: "hybrid"
        });
        for (const hit of search.results || []) {
          recordTrust(hit.trust || "user_authored");
        }
        context._raw.searchHits = search.results || [];
        context.metadata.searchEngine = search.semanticEngine;
        context.metadata.matchedRecords = (search.results || []).length;
        return {
          summary: `Hybrid retrieval matched ${(search.results || []).length} record(s) via ${search.semanticEngine}.`
        };
      }
    },
    {
      name: "Traverse Knowledge Graph neighborhood & provenance",
      async run({ context, recordTrust }) {
        const graph = await buildUserKnowledgeGraph(
          userId,
          {
            projectStore: stores.projectStore,
            memoryStore: stores.memoryStore,
            ideaStore: stores.ideaStore,
            watcherStore: stores.watcherStore,
            capsuleStore: stores.capsuleStore,
            profileStore: stores.profileStore
          },
          { projectId: projectId || "", query: cleanObjective }
        );
        const untrustedNodes = (graph.nodes || []).filter((n) => n.trust === "external_untrusted");
        if (untrustedNodes.length) {
          recordTrust("external_untrusted");
        } else if ((graph.nodes || []).some((n) => n.trust === "system_verified")) {
          recordTrust("system_verified");
        }
        context._raw.graph = graph;
        context.metadata.graphNodes = graph.nodes?.length || 0;
        context.metadata.graphEdges = graph.edges?.length || 0;
        return {
          summary: `Mapped ${graph.nodes?.length || 0} graph nodes and ${graph.edges?.length || 0} links (tainted=${context.tainted}).`
        };
      }
    },
    {
      name: `Synthesize ${role.label} findings for parent review`,
      async run({ context }) {
        const { project, projects, ideas, watchers, permissions, searchHits } = context._raw;

        if (role.id === "auditor") {
          const allBlockers = (project ? [project] : projects).flatMap((p) =>
            (p.blockers || []).map((b) => `[Blocker · ${p.name}] ${b}`)
          );
          const permGrants = permissions.filter((l) => !l.expiresAt);
          const externalWatchers = watchers.filter((w) => w.kind === "http_probe");
          context.findings.push(
            ...allBlockers.slice(0, 6),
            `Active capability leases: ${permissions.length} total (${permGrants.length} permanent, ${permissions.length - permGrants.length} time-bounded).`,
            `Watchers: ${watchers.length} configured (${externalWatchers.length} external HTTP probes).`,
            `Lowest trust tier touched: ${context.lowestTrustTouched}${context.tainted ? " — autonomous write actions blocked (ADR-003)" : ""}.`
          );
          if (permGrants.length > 0) {
            context.recommendations.push("Consider converting permanent leases into time-bounded project leases where possible.");
          }
          if (allBlockers.length > 0) {
            context.recommendations.push("Resolve or defer the top project blocker before expanding scope.");
          }
          if (context.tainted) {
            context.recommendations.push("External untrusted records were inspected — review findings manually before approving any write tool.");
          }
          context.summary = `Auditor completed deterministic risk & provenance review for "${cleanObjective}".`;
        } else if (role.id === "planner") {
          const scopeIdeas = ideas.filter((i) => !projectId || i.projectId === projectId).slice(0, 6);
          const nextActions = project?.nextActions || [];
          context.findings.push(
            ...(project ? [`Project "${project.name}" (${project.status}): ${project.vision || "No vision recorded yet."}`] : [`Reviewing across ${projects.length} project dossier(s).`]),
            ...nextActions.slice(0, 5).map((a) => `Next action: ${a}`),
            ...scopeIdeas.slice(0, 4).map((i) => `Idea [${i.priority}]: ${i.title}`)
          );
          context.recommendations.push(
            nextActions.length ? `Start with: ${nextActions[0]}` : "Record 2–3 concrete next actions in the active project dossier.",
            scopeIdeas.length ? `Promote or triage ${scopeIdeas.length} parked idea(s) linked to this scope.` : "Capture follow-up thoughts via /idea to keep focus clean."
          );
          context.summary = `Planner decomposed "${cleanObjective}" into ${context.findings.length} grounded items.`;
        } else if (role.id === "developer") {
          const decisions = project?.decisions || [];
          context.findings.push(
            ...(project?.architecture ? [`Architecture: ${project.architecture}`] : []),
            ...decisions.slice(0, 5).map((d) => `Decision: ${typeof d === "string" ? d : d?.text || ""}`),
            ...searchHits.slice(0, 5).map((h) => `[${h.entityType}] ${h.title}${h.snippet ? ` — ${h.snippet}` : ""}`)
          );
          context.recommendations.push(
            "Keep changes scoped to modular units with deterministic node:test coverage before modifying runtime adapters.",
            "Any external draft or write action remains approval-gated — Developer sub-agent cannot self-approve."
          );
          context.summary = `Developer prepared a grounded technical brief for "${cleanObjective}" (${context.findings.length} references).`;
        } else {
          // researcher
          context.findings.push(
            ...searchHits.slice(0, 8).map((h) => `[${h.entityType} · ${h.trust}] ${h.title}${h.snippet ? ` — ${h.snippet}` : ""}`)
          );
          if (!context.findings.length) {
            context.findings.push(`No prior workspace records matched "${cleanObjective}" directly; clean starting point.`);
          }
          context.recommendations.push(
            "Review matched sources and plant verified takeaways as typed memories (`fact` or `decision`) in The Garden."
          );
          context.summary = `Researcher synthesized ${searchHits.length} relevant workspace record(s) for "${cleanObjective}".`;
        }

        return { summary: context.summary };
      }
    }
  ];

  return { job, steps };
}
