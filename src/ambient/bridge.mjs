/**
 * Ambient Presence Projection & Hardware Bridges (Phase 5)
 *
 * Projects purely deterministic Core state (Soul mood, active project,
 * working mode, attention tier, VRAM telemetry, knowledge shelf counts) for:
 *  - Alfie's Optional Virtual Room UI
 *  - Home Assistant REST sensor bridge (ALFIE_HA_URL + ALFIE_HA_TOKEN)
 *  - MQTT/Desk-display webhook bridge (ALFIE_AMBIENT_WEBHOOK_URL)
 *
 * Zero LLM calls. Strictly opt-in.
 */

export function resolveTimeOfDay(now = new Date()) {
  const hour = (now instanceof Date ? now : new Date(now)).getHours();
  if (hour >= 5 && hour < 10) return { phase: "dawn", label: "Morning", lightLevel: 0.72 };
  if (hour >= 10 && hour < 17) return { phase: "day", label: "Daylight", lightLevel: 1.0 };
  if (hour >= 17 && hour < 21) return { phase: "dusk", label: "Evening", lightLevel: 0.58 };
  return { phase: "night", label: "Late Night", lightLevel: 0.3 };
}

export function deriveAmbientPresence({
  projects = [],
  memories = [],
  ideas = [],
  watchers = [],
  watcherEvents = [],
  capsules = [],
  activeCapsuleId = null,
  profile = null,
  vram = null,
  pendingApprovals = [],
  activeJobs = [],
  now = new Date()
} = {}) {
  const activeCapsule = capsules.find((c) => c.id === activeCapsuleId) || null;
  const activeProjects = projects.filter((p) => !["archived", "completed"].includes(p.status));
  const focalProject = (activeCapsule?.projectId
    ? projects.find((p) => p.id === activeCapsule.projectId)
    : null) || activeProjects[0] || null;

  const unacknowledged = watcherEvents.filter((e) => !e.acknowledged);
  const hasUrgent = unacknowledged.some((e) => e.tier === "urgent");
  const hasNotify = unacknowledged.some((e) => e.tier === "notify");
  const vramPct = Number(vram?.usagePercent ?? vram?.percent ?? 0);
  const vramHigh = Boolean(vram?.warning || vramPct >= 80);

  let soulMood = "calm";
  let statusLine = "Quietly ready in the study";
  if (hasUrgent || vramHigh) {
    soulMood = "alert";
    statusLine = hasUrgent ? "Urgent watcher alert needs attention" : `GPU VRAM high (${Math.round(vramPct)}%)`;
  } else if (activeJobs.length > 0) {
    soulMood = "focused";
    statusLine = `Working on ${activeJobs.length} background job${activeJobs.length === 1 ? "" : "s"}`;
  } else if (pendingApprovals.length > 0) {
    soulMood = "awaiting";
    statusLine = `${pendingApprovals.length} action${pendingApprovals.length === 1 ? "" : "s"} awaiting approval`;
  } else if (hasNotify) {
    soulMood = "attentive";
    statusLine = "New watcher notice in Attention Feed";
  } else if (focalProject) {
    soulMood = "steady";
    statusLine = `Continuity anchored to ${focalProject.name}`;
  }

  const timeOfDay = resolveTimeOfDay(now);

  return {
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    deterministic: true,
    soul: {
      mood: soulMood,
      statusLine,
      workingMode: activeCapsule?.workingMode || "companion",
      learningMode: profile?.learningMode || "explain"
    },
    environment: {
      timeOfDay: timeOfDay.phase,
      timeLabel: timeOfDay.label,
      lightLevel: timeOfDay.lightLevel
    },
    desk: {
      activeCapsule: activeCapsule ? { id: activeCapsule.id, name: activeCapsule.name } : null,
      focalProject: focalProject ? {
        id: focalProject.id,
        name: focalProject.name,
        status: focalProject.status || "active",
        nextAction: Array.isArray(focalProject.nextActions) ? (focalProject.nextActions[0] || null) : null,
        blockerCount: Array.isArray(focalProject.blockers) ? focalProject.blockers.length : 0
      } : null,
      activeProjectCount: activeProjects.length
    },
    shelves: {
      memoriesCount: memories.filter((m) => !m.archived).length,
      ideasCount: ideas.filter((i) => !["archived", "promoted"].includes(i.status)).length,
      learningTopicsCount: Array.isArray(profile?.learningTopics) ? profile.learningTopics.length : 0
    },
    homelab: {
      enabledWatchers: watchers.filter((w) => w.enabled).length,
      unreadAlerts: unacknowledged.length,
      highestTier: hasUrgent ? "urgent" : (hasNotify ? "notify" : (unacknowledged.length ? "digest" : "quiet")),
      vramPercent: Number.isFinite(vramPct) && vramPct > 0 ? Math.round(vramPct) : null,
      vramWarning: vramHigh,
      pendingApprovals: pendingApprovals.length,
      runningJobs: activeJobs.length
    },
    bridges: {
      homeAssistantConfigured: Boolean(process.env.ALFIE_HA_URL && process.env.ALFIE_HA_TOKEN),
      webhookConfigured: Boolean(process.env.ALFIE_AMBIENT_WEBHOOK_URL),
      mqttTopic: process.env.ALFIE_MQTT_TOPIC || "alfie/presence/state"
    }
  };
}

export function formatHomeAssistantPayload(presence) {
  return {
    state: presence.soul.mood,
    attributes: {
      friendly_name: "Alfie Companion Presence",
      status_line: presence.soul.statusLine,
      working_mode: presence.soul.workingMode,
      focal_project: presence.desk.focalProject?.name || "None",
      unread_alerts: presence.homelab.unreadAlerts,
      highest_tier: presence.homelab.highestTier,
      pending_approvals: presence.homelab.pendingApprovals,
      running_jobs: presence.homelab.runningJobs,
      memories_count: presence.shelves.memoriesCount,
      ideas_count: presence.shelves.ideasCount,
      time_of_day: presence.environment.timeOfDay,
      updated_at: presence.generatedAt
    }
  };
}

export function formatMqttPresencePayload(presence) {
  return {
    topic: presence.bridges?.mqttTopic || "alfie/presence/state",
    retain: true,
    payload: {
      mood: presence.soul.mood,
      mode: presence.soul.workingMode,
      project: presence.desk.focalProject?.name || null,
      alerts: presence.homelab.unreadAlerts,
      tier: presence.homelab.highestTier,
      approvals: presence.homelab.pendingApprovals,
      jobs: presence.homelab.runningJobs,
      vramPct: presence.homelab.vramPercent,
      at: presence.generatedAt
    }
  };
}

export async function dispatchAmbientBridge(presence, { fetchImpl = fetch } = {}) {
  const dispatched = [];
  const errors = [];

  const haUrl = String(process.env.ALFIE_HA_URL || "").trim();
  const haToken = String(process.env.ALFIE_HA_TOKEN || "").trim();
  if (haUrl && haToken) {
    try {
      const target = new URL("/api/states/sensor.alfie_presence", haUrl);
      if (!["http:", "https:"].includes(target.protocol)) {
        throw new Error("Invalid Home Assistant URL scheme.");
      }
      const res = await fetchImpl(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${haToken}`
        },
        body: JSON.stringify(formatHomeAssistantPayload(presence))
      });
      if (!res.ok) throw new Error(`Home Assistant responded ${res.status}`);
      dispatched.push({ target: "home_assistant", ok: true });
    } catch (error) {
      errors.push({ target: "home_assistant", error: error.message });
    }
  }

  const webhookUrl = String(process.env.ALFIE_AMBIENT_WEBHOOK_URL || "").trim();
  if (webhookUrl) {
    try {
      const target = new URL(webhookUrl);
      if (!["http:", "https:"].includes(target.protocol)) {
        throw new Error("Invalid Ambient Webhook URL scheme.");
      }
      const headers = { "content-type": "application/json" };
      if (process.env.ALFIE_AMBIENT_WEBHOOK_TOKEN) {
        headers.authorization = `Bearer ${process.env.ALFIE_AMBIENT_WEBHOOK_TOKEN}`;
      }
      const res = await fetchImpl(target, {
        method: "POST",
        headers,
        body: JSON.stringify(formatMqttPresencePayload(presence))
      });
      if (!res.ok) throw new Error(`Ambient webhook responded ${res.status}`);
      dispatched.push({ target: "ambient_webhook", ok: true });
    } catch (error) {
      errors.push({ target: "ambient_webhook", error: error.message });
    }
  }

  return {
    dispatched,
    errors,
    mqttPayload: formatMqttPresencePayload(presence),
    homeAssistantPayload: formatHomeAssistantPayload(presence)
  };
}
