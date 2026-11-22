import { getUserStorageStatus, migrateUserStorageToSqlite } from "../storage/sqliteStore.mjs";

/**
 * Deterministic Workspace Self-Audit & Integrity Diagnostics (Phase 6.2)
 *
 * Inspects storage health, lease hygiene, untrusted provenance inventory,
 * watcher configuration, pending approval staleness, and project dossier hygiene
 * without making any LLM calls.
 */
export async function runWorkspaceSelfAudit({
  userId,
  dataDirectory,
  stores,
  now = () => new Date().toISOString()
}) {
  const nowIso = now();
  const nowMs = Date.parse(nowIso);

  const [
    storage,
    projects,
    memories,
    ideas,
    watchers,
    permDetail,
    pendingActions,
    jobs,
    playbooks
  ] = await Promise.all([
    getUserStorageStatus(dataDirectory, userId),
    stores.projectStore ? stores.projectStore.list(userId) : [],
    stores.memoryStore ? stores.memoryStore.list(userId, { includeArchived: true, includeExpired: true }) : [],
    stores.ideaStore ? stores.ideaStore.list(userId) : [],
    stores.watcherStore ? stores.watcherStore.list(userId) : [],
    stores.permissionStore
      ? (typeof stores.permissionStore.load === "function"
          ? stores.permissionStore.load(userId)
          : stores.permissionStore.listDetailed(userId))
      : { leases: [] },
    stores.pendingActionStore ? stores.pendingActionStore.list(userId) : [],
    stores.jobStore ? stores.jobStore.list(userId, { limit: 60 }) : [],
    stores.playbookStore ? stores.playbookStore.list(userId) : []
  ]);

  const leases = Array.isArray(permDetail?.leases) ? permDetail.leases : [];
  const activeMemories = memories.filter((m) => !m.archived);
  const expiredMemories = activeMemories.filter((m) => m.expiresAt && Date.parse(m.expiresAt) <= nowMs);
  const untrustedMemories = activeMemories.filter((m) => (m.trust || m.provenance?.trust) === "external_untrusted");

  const expiredLeases = leases.filter((l) => l.expiresAt && Date.parse(l.expiresAt) <= nowMs);
  const permanentLeases = leases.filter((l) => !l.expiresAt);
  const activeProjects = projects.filter((p) => p.status !== "archived" && p.status !== "completed");
  const projectsWithoutNextActions = activeProjects.filter((p) => !Array.isArray(p.nextActions) || p.nextActions.length === 0);
  const openBlockers = activeProjects.reduce((sum, p) => sum + (Array.isArray(p.blockers) ? p.blockers.length : 0), 0);

  const stalePending = pendingActions.filter((a) => {
    const created = Date.parse(a.createdAt || "");
    return Number.isFinite(created) && nowMs - created > 24 * 60 * 60 * 1000;
  });
  const failingWatchers = watchers.filter((w) => w.enabled && w.lastError);

  const checks = [];
  let deductions = 0;

  // 1. SQLite WAL Storage & Integrity
  if (storage.backend === "sqlite" && storage.integrityOk && String(storage.journalMode || "").toLowerCase() === "wal") {
    checks.push({
      id: "storage_wal_integrity",
      category: "Storage",
      status: "pass",
      title: "SQLite WAL integrity verified",
      detail: `Schema v${storage.schemaVersion}, WAL mode active, quick_check passed (${storage.ftsIndexedRows} FTS5 rows).`,
      remediationId: null
    });
  } else {
    deductions += 25;
    checks.push({
      id: "storage_wal_integrity",
      category: "Storage",
      status: "warn",
      title: "Storage integrity or WAL check needs attention",
      detail: `Backend=${storage.backend}, journal=${storage.journalMode || "unknown"}, integrityOk=${Boolean(storage.integrityOk)}.`,
      remediationId: "reindex_fts5"
    });
  }

  // 2. Capability Lease Hygiene
  if (expiredLeases.length > 0) {
    deductions += 10;
    checks.push({
      id: "lease_expiry_hygiene",
      category: "Permissions",
      status: "action",
      title: `${expiredLeases.length} expired capability lease(s) still stored`,
      detail: "Expired grants are blocked at dispatch time, and can be pruned cleanly from storage.",
      remediationId: "prune_expired_leases"
    });
  } else if (permanentLeases.length > 4) {
    deductions += 8;
    checks.push({
      id: "lease_expiry_hygiene",
      category: "Permissions",
      status: "warn",
      title: `${permanentLeases.length} permanent capability leases active`,
      detail: "Consider scoping high-risk permissions to specific projects or time-bounded TTL leases.",
      remediationId: null
    });
  } else {
    checks.push({
      id: "lease_expiry_hygiene",
      category: "Permissions",
      status: "pass",
      title: "Capability lease hygiene is clean",
      detail: `${leases.length} active lease(s) (${permanentLeases.length} permanent, ${leases.length - permanentLeases.length} time-bounded).`,
      remediationId: null
    });
  }

  // 3. Memory TTL & Provenance Taint Inventory
  if (expiredMemories.length > 0) {
    deductions += 8;
    checks.push({
      id: "memory_ttl_hygiene",
      category: "Memory",
      status: "action",
      title: `${expiredMemories.length} expired temporary memor${expiredMemories.length === 1 ? "y" : "ies"} ready to archive`,
      detail: "Archiving expired temporary notes keeps hybrid retrieval and prompt budgets crisp.",
      remediationId: "prune_expired_memories"
    });
  } else {
    checks.push({
      id: "memory_ttl_hygiene",
      category: "Memory",
      status: "pass",
      title: "Typed memory lifecycle & provenance healthy",
      detail: `${activeMemories.length} active memories (${untrustedMemories.length} external_untrusted isolated under ADR-003).`,
      remediationId: null
    });
  }

  // 4. Pending Approval Queue Staleness
  if (stalePending.length > 0) {
    deductions += 10;
    checks.push({
      id: "approval_queue_hygiene",
      category: "Governance",
      status: "warn",
      title: `${stalePending.length} pending approval(s) older than 24 hours`,
      detail: "Review or cancel stale pending proposals in Tools & Access.",
      remediationId: null
    });
  } else {
    checks.push({
      id: "approval_queue_hygiene",
      category: "Governance",
      status: "pass",
      title: "Approval queue is fresh",
      detail: `${pendingActions.length} pending approval(s), zero stale items.`,
      remediationId: null
    });
  }

  // 5. Watcher & Playbook Reliability
  if (failingWatchers.length > 0) {
    deductions += 12;
    checks.push({
      id: "watcher_health",
      category: "Automation",
      status: "warn",
      title: `${failingWatchers.length} enabled watcher(s) reported recent errors`,
      detail: failingWatchers.slice(0, 3).map((w) => `${w.name}: ${w.lastError}`).join(" · "),
      remediationId: null
    });
  } else {
    checks.push({
      id: "watcher_health",
      category: "Automation",
      status: "pass",
      title: "Deterministic watchers & playbooks healthy",
      detail: `${watchers.length} watcher(s), ${playbooks.length} playbook(s), ${jobs.length} recorded job(s).`,
      remediationId: null
    });
  }

  // 6. Living Project Dossier Readiness
  if (projectsWithoutNextActions.length > 0) {
    deductions += 5;
    checks.push({
      id: "dossier_readiness",
      category: "Continuity",
      status: "warn",
      title: `${projectsWithoutNextActions.length} active project(s) have no next actions recorded`,
      detail: projectsWithoutNextActions.slice(0, 3).map((p) => p.name).join(", "),
      remediationId: null
    });
  } else {
    checks.push({
      id: "dossier_readiness",
      category: "Continuity",
      status: "pass",
      title: "Living Project Dossiers structured",
      detail: `${activeProjects.length} active project(s), ${openBlockers} open blocker(s), ${ideas.filter((i) => i.status !== "archived").length} open idea(s).`,
      remediationId: null
    });
  }

  const score = Math.max(0, Math.min(100, 100 - deductions));
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";

  return {
    generatedAt: nowIso,
    score,
    grade,
    metrics: {
      collectionsCount: storage.collectionsCount ?? 0,
      ftsIndexedRows: storage.ftsIndexedRows ?? 0,
      dbSizeBytes: storage.dbSizeBytes ?? 0,
      activeMemories: activeMemories.length,
      expiredMemories: expiredMemories.length,
      untrustedMemories: untrustedMemories.length,
      activeLeases: leases.length,
      expiredLeases: expiredLeases.length,
      activeProjects: activeProjects.length,
      openBlockers,
      watchersCount: watchers.length,
      playbooksCount: playbooks.length
    },
    checks,
    availableRemediations: [
      { id: "reindex_fts5", label: "Rebuild FTS5 search index" },
      { id: "prune_expired_leases", label: "Prune expired capability leases" },
      { id: "prune_expired_memories", label: "Archive expired temporary memories" }
    ]
  };
}

/**
 * Runs a single safe, idempotent, non-destructive workspace remediation action.
 */
export async function applySafeRemediation({
  userId,
  dataDirectory,
  stores,
  action,
  now = () => new Date().toISOString()
}) {
  const cleanAction = String(action || "").trim();
  const nowMs = Date.parse(now());

  if (cleanAction === "reindex_fts5") {
    const migration = await migrateUserStorageToSqlite(dataDirectory, userId);
    const status = await getUserStorageStatus(dataDirectory, userId);
    return {
      action: cleanAction,
      detail: `Rebuilt SQLite FTS5 search index (${status.ftsIndexedRows ?? 0} rows indexed across ${status.collectionsCount ?? 0} collections).`,
      result: { migration, status }
    };
  }

  if (cleanAction === "prune_expired_leases") {
    if (!stores.permissionStore) {
      return { action: cleanAction, detail: "Permission store unavailable.", pruned: 0 };
    }
    const raw = typeof stores.permissionStore.load === "function"
      ? await stores.permissionStore.load(userId)
      : await stores.permissionStore.listDetailed(userId);
    const expired = (raw?.leases || []).filter((l) => l.expiresAt && Date.parse(l.expiresAt) <= nowMs);
    for (const lease of expired) {
      await stores.permissionStore.revoke(userId, lease.scope, { projectId: lease.projectId || null });
    }
    return {
      action: cleanAction,
      pruned: expired.length,
      detail: expired.length
        ? `Pruned ${expired.length} expired capability lease(s).`
        : "No expired capability leases found."
    };
  }

  if (cleanAction === "prune_expired_memories") {
    if (!stores.memoryStore) {
      return { action: cleanAction, detail: "Memory store unavailable.", archived: 0 };
    }
    const list = await stores.memoryStore.list(userId, { includeArchived: false, includeExpired: true });
    const expired = list.filter((m) => m.expiresAt && Date.parse(m.expiresAt) <= nowMs);
    for (const mem of expired) {
      await stores.memoryStore.update(userId, mem.id, { archived: true });
    }
    return {
      action: cleanAction,
      archived: expired.length,
      detail: expired.length
        ? `Archived ${expired.length} expired temporary memor${expired.length === 1 ? "y" : "ies"}.`
        : "No expired temporary memories found."
    };
  }

  throw Object.assign(
    new Error("Unsupported remediation action. Use reindex_fts5, prune_expired_leases, or prune_expired_memories."),
    { status: 400, code: "UNKNOWN_REMEDIATION" }
  );
}
