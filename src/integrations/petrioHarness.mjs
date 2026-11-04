const TOOL_DEFINITIONS = [
  {
    id: "get_petrio_status",
    name: "Petrio status",
    description: "Read Petrio's installed version and high-level platform status.",
    trust: "external", network: false, externalAction: false,
    tags: ["petrio", "system", "status", "health", "version"],
    scope: "petrio:status:read"
  },
  {
    id: "get_project_tasks",
    name: "Project roadmap",
    description: "Read the current milestone, release gate and following work from Petrio's roadmap.",
    trust: "external", network: false, externalAction: false,
    tags: ["project", "tasks", "roadmap", "milestones"],
    scope: "petrio:roadmap:read"
  },
  {
    id: "get_quest_progress",
    name: "Quest and progression",
    description: "Read the current user's XP, coins, level, achievements, island ownership and quest progress.",
    trust: "external", network: false, externalAction: false,
    tags: ["quest", "progress", "xp", "coins", "level", "achievements"],
    scope: "petrio:progress:read"
  },
  {
    id: "get_personal_activity",
    name: "Personal activity",
    description: "Read calendar tasks, workout history and Journal metadata without returning Journal body text.",
    trust: "external", network: false, externalAction: false,
    tags: ["calendar", "appointments", "events", "schedule", "workouts", "journal", "activity"],
    scope: "petrio:activity:read"
  },
  {
    id: "get_calendar_events",
    name: "Calendar events",
    description: "Read the current user's calendar events and tasks for a bounded date range or search query.",
    trust: "external", network: false, externalAction: false,
    tags: ["calendar", "event", "events", "appointment", "schedule", "task", "meeting"],
    scope: "calendar:read",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        query: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    }
  },
  {
    id: "read_journal",
    name: "Read Journal entries",
    description: "Search or read selected Journal entries belonging to the current user.",
    trust: "external", network: false, externalAction: false,
    tags: ["journal", "entry", "entries", "read", "search", "reflection", "diary"],
    scope: "journal:read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 },
        entryId: { type: "string", minLength: 1, maxLength: 128 },
        latest: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 5 }
      },
      anyOf: [
        {
          type: "object",
          properties: { query: { type: "string" }, entryId: { type: "string" }, latest: { type: "boolean" }, limit: { type: "integer" } },
          required: ["query"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: { query: { type: "string" }, entryId: { type: "string" }, latest: { type: "boolean" }, limit: { type: "integer" } },
          required: ["entryId"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: { query: { type: "string" }, entryId: { type: "string" }, latest: { type: "boolean" }, limit: { type: "integer" } },
          required: ["latest"],
          additionalProperties: false
        }
      ],
      additionalProperties: false
    }
  },
  {
    id: "get_petrio_world_model",
    name: "Petrio world model",
    description: "Read a snapshot of Petrio application metadata, roadmap and registered infrastructure health snapshots.",
    trust: "external", network: false, externalAction: false,
    tags: ["apps", "infrastructure", "nodes", "api", "world", "system"],
    scope: "petrio:world:read"
  },
  {
    id: "get_implementation_audit",
    name: "Implementation audit",
    description: "Read a static audit of repository files, tests, roadmap and explicit TODO markers.",
    trust: "external", network: false, externalAction: false,
    tags: ["audit", "implementation", "repository", "code", "tests"],
    scope: "petrio:audit:read"
  }
];

export class PetrioHarnessClient {
  constructor({
    url = process.env.ALFIE_PETRIO_ADAPTER_URL || "http://petrio:3000/v1/alfie-core/tools/run",
    serviceToken = process.env.ALFIE_CORE_SERVICE_TOKEN || "",
    identityAuth,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.url = new URL(url);
    this.serviceToken = serviceToken;
    this.identityAuth = identityAuth;
    this.fetchImpl = fetchImpl;
    this.enabled = ["http:", "https:"].includes(this.url.protocol) &&
      typeof serviceToken === "string" && Buffer.byteLength(serviceToken, "utf8") >= 32 &&
      Boolean(identityAuth?.configured) && typeof fetchImpl === "function";
  }

  async run(userId, toolId, args = {}, { signal } = {}) {
    if (!this.enabled) throw Object.assign(new Error("Petrio tool integration is not configured."), { status: 503 });
    const method = "POST";
    const requestPath = this.url.pathname + this.url.search;
    const identity = this.identityAuth.sign(userId, { method, path: requestPath });
    const response = await this.fetchImpl(this.url, {
      method,
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        "content-type": "application/json",
        ...identity
      },
      body: JSON.stringify({ tool: toolId, arguments: args }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `Petrio tool adapter returned HTTP ${response.status}.`), { status: response.status });
    }
    return payload.result;
  }
}

export function registerPetrioHarnessTools(registry, client) {
  if (!client?.enabled) return [];
  const registered = [];
  for (const definition of TOOL_DEFINITIONS) {
    registered.push(registry.register({
      ...definition,
      risk: "read",
      inputSchema: definition.inputSchema || { type: "object", properties: {}, additionalProperties: false },
      handler: async (args, { userId, signal }) => client.run(userId, definition.id, args, { signal })
    }));
  }
  return registered;
}
