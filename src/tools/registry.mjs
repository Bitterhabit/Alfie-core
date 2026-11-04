const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,120}$/;
const RISKS = new Set(["read", "draft", "write"]);
const TRUST_LEVELS = new Set(["internal", "external"]);

function assertStrictSchema(schema, path = "arguments") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError(`Invalid JSON Schema at ${path}.`);
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new TypeError(`Object schema at ${path} must set additionalProperties:false.`);
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
      throw new TypeError(`Object schema properties at ${path} must be an object.`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) assertStrictSchema(child, `${path}.${key}`);
  }
  if (schema.type === "array" && schema.items) assertStrictSchema(schema.items, `${path}[]`);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword])) throw new TypeError(`Schema ${keyword} at ${path} must be an array.`);
      schema[keyword].forEach((child, index) => assertStrictSchema(child, `${path}.${keyword}[${index}]`));
    }
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register({
    id, name, description, scope, risk = "read", trust, network, externalAction,
    untrustedOutput = false, approvalPreview = null, approvalGuard = null, tags = [],
    inputSchema = { type: "object", properties: {}, additionalProperties: false },
    handler
  }) {
    if (typeof id !== "string" || !TOOL_ID_PATTERN.test(id) || this.tools.has(id)) {
      throw new TypeError("Tool ID is invalid or already registered.");
    }
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw new TypeError("Tool permission scope is invalid.");
    }
    if (!RISKS.has(risk) || typeof handler !== "function") {
      throw new TypeError("Tool risk or handler is invalid.");
    }
    if (!TRUST_LEVELS.has(trust)) {
      throw new TypeError("Every tool must explicitly declare trust as internal or external.");
    }
    if (typeof network !== "boolean" || typeof externalAction !== "boolean") {
      throw new TypeError("Every tool must explicitly declare network and externalAction as booleans.");
    }
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || inputSchema.type !== "object") {
      throw new TypeError("Every tool must provide an object JSON Schema.");
    }

    assertStrictSchema(inputSchema);
    const schema = freezeDeep(structuredClone(inputSchema));
    const tool = Object.freeze({
      id,
      name: String(name || id).slice(0, 100),
      description: String(description || "").slice(0, 1000),
      scope,
      risk,
      trust,
      network,
      externalAction,
      untrustedOutput: trust === "external" || Boolean(untrustedOutput),
      approvalPreview: typeof approvalPreview === "function" ? approvalPreview : null,
      approvalGuard: typeof approvalGuard === "function" ? approvalGuard : null,
      tags: Object.freeze(Array.isArray(tags) ? tags.map(String).slice(0, 20) : []),
      requiresApproval: risk === "write" || externalAction || (network && risk === "draft"),
      approvalWhenUntrusted: network,
      inputSchema: schema,
      handler
    });
    this.tools.set(id, tool);
    return this.publicDefinition(tool);
  }

  publicDefinition(tool) {
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      scope: tool.scope,
      risk: tool.risk,
      trust: tool.trust,
      network: tool.network,
      externalAction: tool.externalAction,
      approvalWhenUntrusted: tool.approvalWhenUntrusted,
      untrustedOutput: tool.untrustedOutput,
      tags: [...tool.tags],
      requiresApproval: tool.requiresApproval,
      inputSchema: structuredClone(tool.inputSchema)
    };
  }

  list(grantedScopes = []) {
    const scopes = new Set(grantedScopes);
    return [...this.tools.values()].map((tool) => ({
      ...this.publicDefinition(tool),
      permitted: scopes.has(tool.scope)
    }));
  }
}
