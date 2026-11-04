import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { ProviderRegistry, normaliseConfig, publicConfig } from "./providers/registry.mjs";
import { createPetrioIdentityAuth } from "./auth/petrioIdentity.mjs";
import { createIdentityAuthRegistry, createSignedIdentityAuth } from "./auth/signedIdentity.mjs";
import { IdentityLinkStore } from "./auth/identityLinkStore.mjs";
import { ConversationStore } from "./conversations/store.mjs";
import { MemoryStore } from "./memory/store.mjs";
import { AuditStore } from "./audit/store.mjs";
import { PermissionStore } from "./permissions/store.mjs";
import { ToolRegistry } from "./tools/registry.mjs";
import { ToolDispatcher } from "./agent/toolDispatcher.mjs";
import { ContextAssembler } from "./agent/contextAssembler.mjs";
import { AgentLoop } from "./agent/loop.mjs";
import { PendingActionStore } from "./agent/pendingActionStore.mjs";
import { PetrioHarnessClient, registerPetrioHarnessTools } from "./integrations/petrioHarness.mjs";
import { registerMemoryTools } from "./integrations/memoryTools.mjs";

const SERVICE_VERSION = "0.3.0";
const MAX_BODY_BYTES = 1024 * 1024;


async function resolveIdentity(identityAuth, identityLinkStore, headers, request) {
  const identity = identityAuth.verify(headers, request);
  if (identity.providerId === "petrio") return identity;
  const canonicalUserId = await identityLinkStore.resolve(identity.providerId, identity.userId);
  if (!canonicalUserId) {
    throw Object.assign(new Error("Link this interface account to your Petrio account before accessing Alfie data."), {
      status: 403, code: "IDENTITY_LINK_REQUIRED"
    });
  }
  return { ...identity, userId: canonicalUserId };
}

function createDefaultIdentityAuth() {
  const providers = [createPetrioIdentityAuth()];
  const standaloneSecret = process.env.ALFIE_CORE_STANDALONE_IDENTITY_SECRET || "";
  if (Buffer.byteLength(standaloneSecret, "utf8") >= 32) {
    providers.push(createSignedIdentityAuth({ secret: standaloneSecret, providerId: "standalone-ui" }));
  }
  return createIdentityAuthRegistry(providers);
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function tokenConfigured(token) {
  return typeof token === "string" && Buffer.byteLength(token, "utf8") >= 32;
}

function tokenMatches(provided, expected) {
  if (!tokenConfigured(expected) || typeof provided !== "string") return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorised(req, expectedToken) {
  const header = req.headers.authorization || "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return Boolean(match && tokenMatches(match[1], expectedToken));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
    return value;
  } catch (error) {
    throw Object.assign(new Error("Request body must be a valid JSON object."), { status: 400 });
  }
}

function cleanMessages(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error("A messages array is required."), { status: 400 });
  const messages = value.slice(-16).map((message) => ({
    role: ["user", "assistant"].includes(message?.role) ? message.role : "user",
    content: String(message?.content || "").slice(0, 12000)
  })).filter((message) => message.content.trim());
  if (!messages.length) throw Object.assign(new Error("At least one non-empty message is required."), { status: 400 });
  return messages;
}

function writeStreamEvent(res, event) {
  if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
}

async function pipeProviderStream(response, endpoint, onDelta) {
  if (!response.body) throw new Error("The model server did not provide a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    finished = done;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const data = endpoint.provider === "ollama" ? line : (line.startsWith("data:") ? line.slice(5).trim() : line);
      if (!data || data === "[DONE]") continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (payload.error) throw new Error(String(payload.error?.message || payload.error));
      const delta = endpoint.provider === "ollama"
        ? payload?.message?.content
        : payload?.choices?.[0]?.delta?.content;
      if (delta) onDelta(String(delta));
    }
  }
  if (buffer.trim()) {
    const data = endpoint.provider === "ollama" ? buffer.trim() : buffer.trim().replace(/^data:\s*/, "");
    if (data && data !== "[DONE]") {
      try {
        const payload = JSON.parse(data);
        const delta = endpoint.provider === "ollama"
          ? payload?.message?.content
          : payload?.choices?.[0]?.delta?.content;
        if (delta) onDelta(String(delta));
      } catch {}
    }
  }
}

export function createAlfieCoreServer({
  serviceToken = process.env.ALFIE_CORE_SERVICE_TOKEN || "",
  providerConfig = (() => {
    try { return JSON.parse(process.env.ALFIE_CORE_PROVIDERS_JSON || '{"mode":"auto","endpoints":[]}'); }
    catch { return { mode: "auto", endpoints: [] }; }
  })(),
  providerRegistry = new ProviderRegistry(),
  identityAuth = createDefaultIdentityAuth(),
  identityLinkStore = new IdentityLinkStore(),
  petrioIdentityAuth = createPetrioIdentityAuth(),
  conversationStore = new ConversationStore(),
  memoryStore = new MemoryStore(),
  auditStore = new AuditStore(),
  permissionStore = new PermissionStore(),
  toolRegistry = new ToolRegistry(),
  pendingActionStore = new PendingActionStore(),
  contextAssembler = new ContextAssembler(),
  petrioHarnessClient = new PetrioHarnessClient({ serviceToken, identityAuth: petrioIdentityAuth })
} = {}) {
  const providers = normaliseConfig(providerConfig);
  registerPetrioHarnessTools(toolRegistry, petrioHarnessClient);
  registerMemoryTools(toolRegistry, memoryStore);
  const toolDispatcher = new ToolDispatcher({ registry: toolRegistry, permissionStore, pendingActionStore, auditStore });
  const agentLoop = new AgentLoop({ providerRegistry, providerConfig: providers, toolRegistry, dispatcher: toolDispatcher, contextAssembler, memoryStore });

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://alfie-core.internal");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { status: "ok", service: "alfie-core", version: SERVICE_VERSION });
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      const serviceTokenConfigured = tokenConfigured(serviceToken);
      const identitySecretConfigured = Boolean(identityAuth?.configured);
      const ready = serviceTokenConfigured && identitySecretConfigured;
      return json(res, ready ? 200 : 503, {
        status: ready ? "ready" : "configuration-required",
        service: "alfie-core",
        checks: { serviceTokenConfigured, identitySecretConfigured }
      });
    }

    if (!url.pathname.startsWith("/v1/")) return json(res, 404, { error: "Route not found." });
    if (!tokenConfigured(serviceToken)) {
      return json(res, 503, { error: "Alfie Core service authentication is not configured." });
    }
    if (!isAuthorised(req, serviceToken)) {
      return json(res, 401, { error: "A valid Alfie Core service token is required." });
    }



    if (req.method === "POST" && url.pathname === "/v1/identity/link-codes") {
      try {
        const identity = identityAuth.verify(req.headers, { method: req.method, path: url.pathname + url.search });
        if (identity.providerId !== "petrio") return json(res, 403, { error: "Only a signed Petrio session can create an account-link code." });
        const result = await identityLinkStore.createCode(identity.userId);
        return json(res, 201, result);
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/identity/standalone") {
      try {
        const identity = identityAuth.verify(req.headers, { method: req.method, path: url.pathname + url.search });
        if (identity.providerId !== "standalone-ui") return json(res, 403, { error: "Only the standalone interface can create an independent workspace." });
        return json(res, 201, await identityLinkStore.createStandaloneWorkspace(identity.providerId, identity.userId));
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/identity/link") {
      try {
        const identity = identityAuth.verify(req.headers, { method: req.method, path: url.pathname + url.search });
        if (identity.providerId !== "standalone-ui") return json(res, 403, { error: "Only the standalone interface identity can consume an account-link code." });
        const body = await readJsonBody(req);
        return json(res, 200, await identityLinkStore.consumeCode(identity.providerId, identity.userId, body.code));
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/identity/unlink") {
      try {
        const identity = identityAuth.verify(req.headers, { method: req.method, path: url.pathname + url.search });
        if (identity.providerId !== "standalone-ui") return json(res, 403, { error: "Only the standalone interface identity can unlink itself." });
        return json(res, 200, await identityLinkStore.unlink(identity.providerId, identity.userId));
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      try {
        const identity = identityAuth.verify(req.headers, { method: req.method, path: url.pathname + url.search });
        const canonicalUserId = identity.providerId === "petrio"
          ? identity.userId
          : await identityLinkStore.resolve(identity.providerId, identity.userId);
        return json(res, 200, {
          authenticated: true,
          userId: canonicalUserId || identity.userId,
          identityProvider: identity.providerId || "configured",
          linked: identity.providerId === "petrio" || Boolean(canonicalUserId)
        });
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      return json(res, 200, {
        service: "alfie-core",
        version: SERVICE_VERSION,
        identityProviders: identityAuth.providerIds || [identityAuth.providerId].filter(Boolean),
        implemented: ["multi-client-signed-identity", "cross-client-account-linking", "service-authentication", "health", "readiness", "provider-registry", "provider-health", "model-selection", "bounded-agent-loop", "intent-based-context-assembly", "strict-json-schema-tool-validation", "read-draft-write-risk-tiers", "persistent-pending-actions", "explicit-approve-reject", "untrusted-data-envelopes", "tool-call-deduplication", "four-step-turn-budget", "30-second-wall-clock-budget", "tool-output-truncation", "signed-identity-provider-contract", "conversation-persistence", "conversation-snapshot-migration", "memory-crud", "memory-provenance", "ranked-memory-retrieval", "untrusted-memory-context", "memory-search-tool", "memory-read-tool", "approval-gated-memory-create", "approval-gated-memory-update", "approval-gated-memory-forget", "per-user-action-audit-log", "scoped-tool-registry", "permission-grants", "dashboard-approval-ui", "dashboard-permission-management"],
        planned: ["mail-tool-adapter", "calendar-journal-write-adapters", "standalone-account-recovery", "multi-user-administration"]
      });
    }





    const isToolsCollection = url.pathname === "/v1/tools";
    const isPermissionsCollection = url.pathname === "/v1/permissions";
    const isToolPlan = url.pathname === "/v1/tools/plan";
    const isToolApproval = url.pathname === "/v1/tools/approve";
    const isToolExecution = url.pathname === "/v1/tools/execute";
    const isToolRejection = url.pathname === "/v1/tools/reject";
    const isPendingActions = url.pathname === "/v1/tools/pending";
    if (isToolsCollection || isPermissionsCollection || isToolPlan || isToolApproval || isToolExecution || isToolRejection || isPendingActions) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const scopes = await permissionStore.list(identity.userId);
        if (isToolsCollection && req.method === "GET") {
          return json(res, 200, { tools: toolRegistry.list(scopes) });
        }
        if (isPermissionsCollection && req.method === "GET") {
          return json(res, 200, { scopes });
        }
        if (isPendingActions && req.method === "GET") {
          return json(res, 200, { actions: await pendingActionStore.list(identity.userId) });
        }
        if (isPermissionsCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          const knownScope = toolRegistry.list().some((tool) => tool.scope === body.scope);
          if (!knownScope) return json(res, 404, { error: "No registered tool currently uses that permission scope." });
          return json(res, 200, { scopes: await permissionStore.grant(identity.userId, body.scope) });
        }
        if (isPermissionsCollection && req.method === "DELETE") {
          const body = await readJsonBody(req);
          return json(res, 200, { scopes: await permissionStore.revoke(identity.userId, body.scope) });
        }
        if (isToolPlan && req.method === "POST") {
          const body = await readJsonBody(req);
          const turnId = randomUUID();
          try {
            const result = await toolDispatcher.dispatch({ userId: identity.userId, toolId: body.toolId, args: body.args || {}, turnId, contextMessages: body.contextMessages || [] });
            return json(res, result.status === "awaiting_user_approval" ? 202 : 200, result);
          } finally {
            toolDispatcher.resetTurn(turnId);
          }
        }
        if (isToolApproval && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await toolDispatcher.approve(identity.userId, body.actionId || body.approvalId));
        }
        if (isToolRejection && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await toolDispatcher.reject(identity.userId, body.actionId));
        }
        if (isToolExecution && req.method === "POST") {
          return json(res, 410, { error: "Direct tool execution is disabled. Use plan, then explicit user approval." });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Tool permission operation failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const memoryMatch = /^\/v1\/memories\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const memoryRelatedMatch = /^\/v1\/memories\/([a-f0-9-]{36})\/related$/i.exec(url.pathname);
    const memoryRelationshipsMatch = /^\/v1\/memories\/([a-f0-9-]{36})\/relationships$/i.exec(url.pathname);
    const memoryRelationshipDeleteMatch = /^\/v1\/memories\/([a-f0-9-]{36})\/relationships\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const isMemoryCollection = url.pathname === "/v1/memories";
    const isMemoryStats = url.pathname === "/v1/memories/stats";
    const isMemoryImport = url.pathname === "/v1/memories/import";
    if (isMemoryCollection || isMemoryStats || isMemoryImport || memoryMatch || memoryRelatedMatch || memoryRelationshipsMatch || memoryRelationshipDeleteMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isMemoryCollection && req.method === "GET") {
          const memories = await memoryStore.list(identity.userId, {
            origin: url.searchParams.get("origin") || undefined,
            source: url.searchParams.get("source") || undefined,
            type: url.searchParams.get("type") || undefined,
            tag: url.searchParams.get("tag") || undefined,
            minImportance: url.searchParams.get("minImportance") || 0,
            q: url.searchParams.get("q") || undefined,
            limit: url.searchParams.get("limit") || 100,
            sort: url.searchParams.get("sort") || "newest"
          });
          return json(res, 200, { memories });
        }
        if (isMemoryStats && req.method === "GET") {
          return json(res, 200, await memoryStore.stats(identity.userId));
        }
        if (isMemoryCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          const memory = await memoryStore.create(identity.userId, body);
          return json(res, 201, { memory });
        }
        if (isMemoryImport && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await memoryStore.importLegacy(identity.userId, body.memories));
        }
        if (memoryMatch && req.method === "GET") {
          return json(res, 200, { memory: await memoryStore.get(identity.userId, memoryMatch[1]) });
        }
        if (memoryRelatedMatch && req.method === "GET") {
          return json(res, 200, { related: await memoryStore.related(identity.userId, memoryRelatedMatch[1]) });
        }
        if (memoryRelationshipsMatch && req.method === "GET") {
          const memory = await memoryStore.get(identity.userId, memoryRelationshipsMatch[1]);
          return json(res, 200, { relationships: memory.relationships || [] });
        }
        if (memoryRelationshipsMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 201, await memoryStore.addRelationship(identity.userId, memoryRelationshipsMatch[1], body));
        }
        if (memoryRelationshipDeleteMatch && req.method === "DELETE") {
          return json(res, 200, await memoryStore.removeRelationship(identity.userId, memoryRelationshipDeleteMatch[1], memoryRelationshipDeleteMatch[2]));
        }
        if (memoryMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          return json(res, 200, { memory: await memoryStore.update(identity.userId, memoryMatch[1], body) });
        }
        if (memoryMatch && req.method === "DELETE") {
          return json(res, 200, await memoryStore.remove(identity.userId, memoryMatch[1]));
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Memory operation failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/audit" && req.method === "GET") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const limit = url.searchParams.get("limit") || 100;
        return json(res, 200, { events: await auditStore.list(identity.userId, { limit }) });
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Audit history unavailable." });
      }
    }

    const conversationMatch = /^\/v1\/conversations\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const messageMatch = /^\/v1\/conversations\/([a-f0-9-]{36})\/messages$/i.exec(url.pathname);
    const isConversationCollection = url.pathname === "/v1/conversations";
    const isConversationDatabase = url.pathname === "/v1/conversations/database";
    const isConversationImport = url.pathname === "/v1/conversations/import";
    if (isConversationCollection || isConversationDatabase || isConversationImport || conversationMatch || messageMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isConversationDatabase && req.method === "GET") {
          return json(res, 200, { database: await conversationStore.database(identity.userId) });
        }
        if (isConversationDatabase && req.method === "PUT") {
          const body = await readJsonBody(req);
          return json(res, 200, { database: await conversationStore.replaceDatabase(identity.userId, body.database || body, body.expectedRevision ?? null) });
        }
        if (isConversationImport && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await conversationStore.importLegacy(identity.userId, body.database || body, body.sourceKey || "petrio-server"));
        }
        if (isConversationCollection && req.method === "GET") {
          return json(res, 200, { conversations: await conversationStore.list(identity.userId) });
        }
        if (isConversationCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          const conversation = await conversationStore.create(identity.userId, body.title);
          return json(res, 201, { conversation });
        }
        if (conversationMatch && req.method === "GET") {
          const conversation = await conversationStore.get(identity.userId, conversationMatch[1]);
          return json(res, 200, { conversation });
        }
        if (messageMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const message = await conversationStore.appendMessage(identity.userId, messageMatch[1], body);
          return json(res, 201, { message });
        }
        if (conversationMatch && req.method === "DELETE") {
          return json(res, 200, await conversationStore.remove(identity.userId, conversationMatch[1]));
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Conversation operation failed.",
          ...(error.code ? { code: error.code } : {}),
          ...(Number.isInteger(error.revision) ? { revision: error.revision } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (req.method === "GET" && url.pathname === "/v1/providers") {
      return json(res, 200, publicConfig(providers));
    }

    if (req.method === "GET" && url.pathname === "/v1/providers/health") {
      const health = await Promise.all(providers.endpoints.map((endpoint) =>
        providerRegistry.inspectCached(endpoint, providers.healthIntervalSeconds)));
      return json(res, 200, { mode: providers.mode, endpoints: health });
    }


    if (req.method === "POST" && url.pathname === "/v1/chat/stream") {
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        const identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search });
        const body = await readJsonBody(req);
        const result = await agentLoop.run({
          userId: identity.userId, messages: cleanMessages(body.messages),
          dashboardState: body.dashboardState || {},
          mode: ["auto", "light", "standard", "work"].includes(body.mode) ? body.mode : providers.mode,
          turnId: body.turnId || randomUUID(), signal: controller.signal
        });
        if (controller.signal.aborted) return;
        res.writeHead(result.status === "awaiting_user_approval" ? 202 : 200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no"
        });
        res.flushHeaders?.();
        writeStreamEvent(res, { type: "meta", status: result.status, steps: result.steps });
        if (result.message) writeStreamEvent(res, { type: "delta", content: result.message });
        if (result.status === "awaiting_user_approval") {
          writeStreamEvent(res, { type: "approval_required", actionId: result.actionId, toolId: result.toolId, summary: result.summary });
        }
        writeStreamEvent(res, { type: "done", ...result });
        res.end();
      } catch (error) {
        if (controller.signal.aborted) return;
        return json(res, Number.isInteger(error.status) ? error.status : 502, { error: error.message || "Alfie could not complete the response." });
      }
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/chat" || url.pathname === "/v1/agent/run")) {
      const controller = new AbortController();
      req.on("aborted", () => controller.abort(new Error("Petrio client disconnected.")));
      res.on("close", () => { if (!res.writableEnded) controller.abort(new Error("Petrio client disconnected.")); });
      try {
        const identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search });
        const body = await readJsonBody(req);
        const messages = cleanMessages(body.messages);
        const requestedMode = ["auto", "light", "standard", "work"].includes(body.mode) ? body.mode : providers.mode;
        const turnId = randomUUID();
        try {
          const result = await agentLoop.run({
            userId: identity.userId, messages, dashboardState: body.dashboardState || {},
            mode: requestedMode, turnId, signal: controller.signal
          });
          return json(res, result.status === "awaiting_user_approval" ? 202 : 200, result);
        } finally {
          toolDispatcher.resetTurn(turnId);
        }
      } catch (error) {
        return json(res, Number.isInteger(error.status) ? error.status : 502, {
          error: error.message || "Alfie could not complete the response."
        });
      }
    }

    return json(res, 404, { error: "Route not found." });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT || 8780);
  const server = createAlfieCoreServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`Alfie Core foundation listening on port ${port}.\n`);
  });
}
