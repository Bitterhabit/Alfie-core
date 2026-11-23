import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { ProviderRegistry, normaliseConfig, publicConfig } from "./providers/registry.mjs";
import { ProviderStore } from "./providers/store.mjs";
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
import { ImageGenerator } from "./integrations/imageGenerator.mjs";
import { registerImageTools } from "./integrations/imageTools.mjs";
import { ProjectStore } from "./projects/store.mjs";
import { IdeaStore } from "./ideas/store.mjs";
import { WatcherStore } from "./watchers/store.mjs";
import { WorkflowProfileStore, EXPLANATION_STYLES, CHANGE_PRESENTATIONS, INTERRUPTION_TOLERANCES, CHUNK_SIZES, LEARNING_MODES, TOPIC_CONFIDENCE_LEVELS } from "./profile/store.mjs";
import { ContextCapsuleStore, PRIVACY_POSTURES } from "./capsules/store.mjs";
import { listWorkingModes, resolveWorkingMode } from "./agent/workingModes.mjs";
import { buildHandoffBrief } from "./conversations/handoff.mjs";
import { VramMonitor } from "./system/vramMonitor.mjs";
import { CloudAgentStore } from "./providers/cloudAgentStore.mjs";
import { CloudAgentAdapters } from "./providers/cloudAdapters.mjs";
import { filterGrantedScopes, summarizePrivacy } from "./privacy/policy.mjs";
import { buildUserKnowledgeGraph } from "./graph/builder.mjs";
import { getUserStorageStatus, migrateUserStorageToSqlite, resolveStorageBackend } from "./storage/sqliteStore.mjs";
import { hybridSearchWorkspace } from "./retrieval/hybrid.mjs";
import { registerModularConnectorTools, getModularIntegrationsStatus } from "./integrations/modularConnectors.mjs";
import { AsyncJobStore, AsyncJobEngine } from "./jobs/engine.mjs";
import { listSpecialistRoles, createWorkshopTask } from "./agents/workshop.mjs";
import { sanitizeForCloud, rehydrateFromCloud } from "./privacy/broker.mjs";
import { getVoiceStatus, transcribeAudio, synthesizeSpeech } from "./voice/service.mjs";
import { buildContinuityReflection, ReflectionStore } from "./reflections/generator.mjs";
import { deriveAmbientPresence, dispatchAmbientBridge } from "./ambient/bridge.mjs";
import { exportEncryptedVault, verifyEncryptedVault, restoreEncryptedVault } from "./vault/backup.mjs";
import { runWorkspaceSelfAudit, applySafeRemediation } from "./diagnostics/selfAudit.mjs";
import { PeerTokenStore, PEER_TOKEN_SCOPES } from "./clients/tokenStore.mjs";
import { PlaybookStore, PLAYBOOK_TRIGGERS, PLAYBOOK_ACTIONS, runPlaybook } from "./playbooks/store.mjs";
import { buildContinuityTimeline, exportMarkdownDigest } from "./timeline/builder.mjs";

const SERVICE_VERSION = "0.3.0";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VAULT_BODY_BYTES = 8 * 1024 * 1024;


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

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
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
    content: String(message?.content || "").slice(0, 12000),
    ...(message?.reaction && ["like", "flag"].includes(String(message.reaction)) ? { reaction: String(message.reaction) } : {})
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
  providerStore = null,
  identityAuth = createDefaultIdentityAuth(),
  identityLinkStore = new IdentityLinkStore(),
  petrioIdentityAuth = createPetrioIdentityAuth(),
  conversationStore = new ConversationStore(),
  projectStore = new ProjectStore(),
  ideaStore = new IdeaStore(),
  watcherStore = new WatcherStore(),
  profileStore = new WorkflowProfileStore(),
  capsuleStore = new ContextCapsuleStore(),
  vramMonitor = new VramMonitor(),
  memoryStore = new MemoryStore(),
  auditStore = new AuditStore(),
  permissionStore = new PermissionStore(),
  toolRegistry = new ToolRegistry(),
  pendingActionStore = new PendingActionStore(),
  contextAssembler = new ContextAssembler(),
  petrioHarnessClient = new PetrioHarnessClient({ serviceToken, identityAuth: petrioIdentityAuth }),
  imageGenerator = new ImageGenerator(),
  cloudAgentStore = new CloudAgentStore(),
  cloudAdapters = new CloudAgentAdapters(),
  jobStore = new AsyncJobStore({ dataDirectory: memoryStore.dataDirectory }),
  reflectionStore = new ReflectionStore({ dataDirectory: memoryStore.dataDirectory }),
  peerTokenStore = new PeerTokenStore({ dataDirectory: memoryStore.dataDirectory }),
  playbookStore = new PlaybookStore({ dataDirectory: memoryStore.dataDirectory }),
  assetsDirectory = process.env.ALFIE_ASSETS_DIR || path.resolve(process.cwd(), "assets")
} = {}) {
  const providers = normaliseConfig(providerConfig, { defaultTrustedLocal: true, enforceUrlPolicy: false });
  const resolvedProviderStore = providerStore || new ProviderStore({
    dataDirectory: memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || path.resolve(process.cwd(), "data"),
    fallbackConfig: providers
  });
  registerPetrioHarnessTools(toolRegistry, petrioHarnessClient);
  registerMemoryTools(toolRegistry, memoryStore);
  registerImageTools(toolRegistry, imageGenerator);
  registerModularConnectorTools(toolRegistry, {
    dataDirectory: memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data",
    petrioHarnessClient
  });
  const jobEngine = new AsyncJobEngine({ jobStore, vramMonitor, auditStore });
  const workshopStores = { projectStore, memoryStore, ideaStore, watcherStore, capsuleStore, profileStore, permissionStore, jobStore };
  const workshopDataDirectory = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
  jobEngine.registerHandler("subagent_delegation", async ({ userId, job }) => {
    const task = await createWorkshopTask({ userId, roleId: job.role, objective: job.objective, projectId: job.projectId, existingJob: job, stores: workshopStores, dataDirectory: workshopDataDirectory });
    return task.steps;
  });
  const toolDispatcher = new ToolDispatcher({ registry: toolRegistry, permissionStore, pendingActionStore, auditStore, assetsDirectory });
  const agentLoop = new AgentLoop({ providerRegistry, providerConfig: providers, providerStore: resolvedProviderStore, toolRegistry, dispatcher: toolDispatcher, contextAssembler, memoryStore, projectStore, watcherStore, profileStore, imageGenerator, cloudAgentStore, cloudAdapters, assetsDirectory });
  jobEngine.registerHandler("chat_turn", async ({ userId, job }) => [{
    name: "Run background chat turn",
    async run({ context, signal }) {
      const input = job.payload || {};
      const result = await agentLoop.run({
        userId,
        messages: cleanMessages(input.messages),
        dashboardState: input.dashboardState || {},
        mode: ["auto", "light", "standard", "work"].includes(input.mode) ? input.mode : "auto",
        workingMode: resolveWorkingMode(input.workingMode).id,
        projectId: input.projectId || null,
        agentProvider: ["local", "gemini", "openai"].includes(input.agentProvider) ? input.agentProvider : "local",
        turnId: job.turnId || job.id,
        signal,
        onProgress: (event) => {
          const progress = event?.type === "tool_start" ? 35 : 15;
          const detail = event?.toolName ? `Using ${String(event.toolName).slice(0, 80)}` : "Working on your request";
          jobEngine.reportProgress(userId, job.id, progress, detail).catch(() => {});
        }
      });
      if (result.status === "timeout") throw Object.assign(new Error(result.message || "Chat task exceeded its processing budget."), { code: "CHAT_TASK_TIMEOUT" });
      const assistantMessage = String(result.message || "The background task finished without a response.").slice(0, 12000);
      await conversationStore.appendMessage(userId, job.conversationId, {
        role: "assistant",
        content: assistantMessage,
        taskId: job.id,
        metrics: result.metrics,
        provenance: result.provenance
      });
      context.summary = assistantMessage;
      if (result.status === "awaiting_user_approval") {
        return { awaitingApproval: true, pendingActionId: result.actionId, summary: "Paused for explicit user approval.", artifact: { summary: assistantMessage, status: "awaiting_approval", actionId: result.actionId || null } };
      }
      return { summary: assistantMessage };
    }
  }]);

  const hasIdentityHeaders = (headers = {}) => Boolean(
    headers["x-alfie-identity-signature"] ||
    headers["x-alfie-identity-user-id"] ||
    headers["x-alfie-identity-provider"] ||
    headers["x-petrio-signature"] ||
    headers["x-petrio-user-id"]
  );

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
        storageBackend: resolveStorageBackend(),
        identityProviders: identityAuth.providerIds || [identityAuth.providerId].filter(Boolean),
        implemented: [
          "multi-client-signed-identity", "cross-client-account-linking", "service-authentication",
          "health", "readiness", "provider-registry", "provider-health", "model-selection",
          "cloud-coding-agents", "cloud-privacy-controls", "split-brain-privacy-broker",
          "adaptive-working-modes", "living-project-dossiers", "ideas-vault",
          "typed-memory-v2", "persistent-trust-provenance", "capability-leases",
          "deterministic-watcher-framework", "attention-budget-router", "dry-run-simulation-receipts",
          "workflow-learning-profile", "context-capsules", "knowledge-graph",
          "sqlite-wal-storage", "fts5-workspace-search", "hybrid-semantic-retrieval",
          "modular-integration-suite", "async-job-engine", "bounded-multi-agent-workshop", "background-workshop-worker", "queued-job-recovery-on-reconnect", "safe-interruption-after-core-restart",
          "local-hybrid-voice-loop", "life-continuity-reflections", "ambient-hardware-bridges",
          "optional-virtual-room", "sovereign-encrypted-vault", "workspace-self-audit-diagnostics",
          "scoped-peer-client-tokens", "peer-quick-capture-api", "deterministic-playbooks",
          "continuity-timeline", "portable-markdown-digest", "turn-provenance", "bounded-agent-loop",
          "intent-based-context-assembly", "strict-json-schema-tool-validation",
          "read-draft-write-risk-tiers", "persistent-pending-actions", "explicit-approve-reject",
          "untrusted-data-envelopes", "tool-call-deduplication", "four-step-turn-budget",
          "30-minute-wall-clock-budget", "35-minute-chat-transport-timeout", "15-second-stream-heartbeats", "tool-output-truncation", "signed-identity-provider-contract",
          "conversation-persistence", "conversation-snapshot-migration", "projects", "context-handoff",
          "vram-monitoring", "memory-crud", "memory-provenance", "ranked-memory-retrieval",
          "untrusted-memory-context", "memory-search-tool", "memory-read-tool",
          "approval-gated-memory-create", "approval-gated-memory-update", "approval-gated-memory-forget",
          "per-user-action-audit-log", "scoped-tool-registry", "permission-grants",
          "dashboard-approval-ui", "dashboard-permission-management"
        ],
        planned: []
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/modes") {
      try {
        await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search });
        return json(res, 200, { modes: listWorkingModes() });
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    }





    const isToolsCollection = url.pathname === "/v1/tools";
    const isPermissionsCollection = url.pathname === "/v1/permissions";
    const isToolPlan = url.pathname === "/v1/tools/plan";
    const isToolApproval = url.pathname === "/v1/tools/approve";
    const isToolExecution = url.pathname === "/v1/tools/execute";
    const isToolRejection = url.pathname === "/v1/tools/reject";
    const isPendingActions = url.pathname === "/v1/tools/pending";
    const isActionReceipts = url.pathname === "/v1/tools/receipts";
    if (isToolsCollection || isPermissionsCollection || isToolPlan || isToolApproval || isToolExecution || isToolRejection || isPendingActions || isActionReceipts) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const detailed = typeof permissionStore.listDetailed === "function"
          ? await permissionStore.listDetailed(identity.userId)
          : { scopes: await permissionStore.list(identity.userId), leases: [] };
        const scopes = detailed.scopes;
        if (isToolsCollection && req.method === "GET") {
          return json(res, 200, { tools: toolRegistry.list(scopes), leases: detailed.leases });
        }
        if (isPermissionsCollection && req.method === "GET") {
          return json(res, 200, { scopes, leases: detailed.leases });
        }
        if (isPendingActions && req.method === "GET") {
          return json(res, 200, { actions: await pendingActionStore.list(identity.userId) });
        }
        if (isActionReceipts && req.method === "GET") {
          const receipts = typeof pendingActionStore.listReceipts === "function"
            ? await pendingActionStore.listReceipts(identity.userId, { limit: url.searchParams.get("limit") || 25 })
            : [];
          return json(res, 200, { receipts });
        }
        if (isPermissionsCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          const knownScope = toolRegistry.list().some((tool) => tool.scope === body.scope);
          if (!knownScope) return json(res, 404, { error: "No registered tool currently uses that permission scope." });
          if (body.projectId) await projectStore.get(identity.userId, body.projectId);
          await permissionStore.grant(identity.userId, body.scope, {
            ttlMinutes: body.ttlMinutes,
            expiresAt: body.expiresAt,
            projectId: body.projectId,
            note: body.note
          });
          const next = typeof permissionStore.listDetailed === "function"
            ? await permissionStore.listDetailed(identity.userId)
            : { scopes: await permissionStore.list(identity.userId), leases: [] };
          await auditStore.record(identity.userId, {
            event: "permission.granted",
            actor: "user",
            toolId: body.scope,
            risk: "low",
            status: "granted",
            detail: body.ttlMinutes
              ? `Granted capability lease for ${body.scope} (${body.ttlMinutes} min${body.projectId ? ", project-scoped" : ""}).`
              : `Granted ${body.scope}${body.projectId ? " (project-scoped)" : ""}.`
          });
          return json(res, 200, next);
        }
        if (isPermissionsCollection && req.method === "DELETE") {
          const body = await readJsonBody(req);
          const revokeOptions = Object.prototype.hasOwnProperty.call(body, "projectId")
            ? { projectId: body.projectId }
            : {};
          await permissionStore.revoke(identity.userId, body.scope, revokeOptions);
          const next = typeof permissionStore.listDetailed === "function"
            ? await permissionStore.listDetailed(identity.userId)
            : { scopes: await permissionStore.list(identity.userId), leases: [] };
          return json(res, 200, next);
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
            kind: url.searchParams.get("kind") || undefined,
            trust: url.searchParams.get("trust") || undefined,
            tag: url.searchParams.get("tag") || undefined,
            minImportance: url.searchParams.get("minImportance") || 0,
            includeArchived: url.searchParams.get("includeArchived") === "true",
            includeExpired: url.searchParams.get("includeExpired") === "true",
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

    const projectMatch = /^\/v1\/projects\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const isProjectCollection = url.pathname === "/v1/projects";
    if (isProjectCollection || projectMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isProjectCollection && req.method === "GET") {
          const [projects, conversations] = await Promise.all([
            projectStore.list(identity.userId),
            conversationStore.list(identity.userId)
          ]);
          const counts = new Map();
          for (const conversation of conversations) {
            if (conversation.projectId) {
              counts.set(conversation.projectId, (counts.get(conversation.projectId) || 0) + 1);
            }
          }
          return json(res, 200, {
            projects: projects.map((project) => ({
              ...project,
              conversationCount: counts.get(project.id) || 0
            }))
          });
        }
        if (isProjectCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          const project = await projectStore.create(identity.userId, body);
          return json(res, 201, { project: { ...project, conversationCount: 0 } });
        }
        if (projectMatch && req.method === "GET") {
          const project = await projectStore.get(identity.userId, projectMatch[1]);
          const conversations = await conversationStore.list(identity.userId, { projectId: project.id });
          return json(res, 200, { project: { ...project, conversationCount: conversations.length }, conversations });
        }
        if (projectMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          const project = await projectStore.update(identity.userId, projectMatch[1], body);
          return json(res, 200, { project });
        }
        if (projectMatch && req.method === "DELETE") {
          const removed = await projectStore.remove(identity.userId, projectMatch[1]);
          const cleared = await conversationStore.clearProject(identity.userId, projectMatch[1]);
          const clearedIdeas = await ideaStore.clearProject(identity.userId, projectMatch[1]);
          return json(res, 200, { deleted: removed.deleted, unassignedConversations: cleared.cleared, unassignedIdeas: clearedIdeas.cleared });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Project operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const ideaMatch = /^\/v1\/ideas\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const isIdeaCollection = url.pathname === "/v1/ideas";
    if (isIdeaCollection || ideaMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isIdeaCollection && req.method === "GET") {
          const filters = {
            status: url.searchParams.get("status") || "",
            projectId: url.searchParams.get("projectId") || "",
            query: url.searchParams.get("q") || ""
          };
          const tag = url.searchParams.get("tag") || "";
          const [ideas, tags] = await Promise.all([
            ideaStore.list(identity.userId, { ...filters, tag }),
            ideaStore.listTags(identity.userId, filters)
          ]);
          return json(res, 200, { ideas, tags });
        }
        if (isIdeaCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.projectId) {
            await projectStore.get(identity.userId, body.projectId);
          }
          const idea = await ideaStore.create(identity.userId, body);
          return json(res, 201, { idea });
        }
        if (ideaMatch && req.method === "GET") {
          return json(res, 200, { idea: await ideaStore.get(identity.userId, ideaMatch[1]) });
        }
        if (ideaMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          if (body.projectId) {
            await projectStore.get(identity.userId, body.projectId);
          }
          return json(res, 200, { idea: await ideaStore.update(identity.userId, ideaMatch[1], body) });
        }
        if (ideaMatch && req.method === "DELETE") {
          return json(res, 200, await ideaStore.remove(identity.userId, ideaMatch[1]));
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Idea operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const watcherMatch = /^\/v1\/watchers\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const watcherCheckMatch = /^\/v1\/watchers\/([a-f0-9-]{36})\/check$/i.exec(url.pathname);
    const watcherIngestMatch = /^\/v1\/watchers\/([a-f0-9-]{36})\/ingest$/i.exec(url.pathname);
    const watcherEventAckMatch = /^\/v1\/watchers\/events\/([a-f0-9-]{36})\/ack$/i.exec(url.pathname);
    const isWatchersCollection = url.pathname === "/v1/watchers";
    const isWatcherEventsCollection = url.pathname === "/v1/watchers/events";
    if (isWatchersCollection || isWatcherEventsCollection || watcherMatch || watcherCheckMatch || watcherIngestMatch || watcherEventAckMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isWatchersCollection && req.method === "GET") {
          const [watchers, events] = await Promise.all([
            watcherStore.list(identity.userId),
            watcherStore.listEvents(identity.userId, { limit: 40 })
          ]);
          const unacknowledgedCount = events.filter((e) => !e.acknowledged).length;
          return json(res, 200, { watchers, unacknowledgedCount });
        }
        if (isWatchersCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.kind === "project_stall" && body.config?.projectId) {
            await projectStore.get(identity.userId, body.config.projectId);
          }
          const watcher = await watcherStore.create(identity.userId, body);
          await auditStore.record(identity.userId, {
            event: "watcher.created",
            actor: "user",
            toolId: watcher.kind,
            risk: "low",
            status: "active",
            detail: `Created deterministic watcher "${watcher.name}" (${watcher.tier}).`
          });
          return json(res, 201, { watcher });
        }
        if (watcherMatch && req.method === "GET") {
          return json(res, 200, { watcher: await watcherStore.get(identity.userId, watcherMatch[1]) });
        }
        if (watcherMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          return json(res, 200, { watcher: await watcherStore.update(identity.userId, watcherMatch[1], body) });
        }
        if (watcherMatch && req.method === "DELETE") {
          const removed = await watcherStore.remove(identity.userId, watcherMatch[1]);
          return json(res, 200, removed);
        }
        if (watcherCheckMatch && req.method === "POST") {
          const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
          const result = await watcherStore.runCheck(identity.userId, watcherCheckMatch[1], {
            projectStore,
            vramMonitor,
            endpoints: userProviders.endpoints
          });
          return json(res, 200, result);
        }
        if (watcherIngestMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await watcherStore.ingestMetric(identity.userId, watcherIngestMatch[1], body);
          return json(res, 200, result);
        }
        if (isWatcherEventsCollection && req.method === "GET") {
          const events = await watcherStore.listEvents(identity.userId, {
            tier: url.searchParams.get("tier") || "",
            unacknowledged: url.searchParams.get("unacknowledged") === "true",
            limit: url.searchParams.get("limit") || 50
          });
          return json(res, 200, { events });
        }
        if (watcherEventAckMatch && req.method === "POST") {
          const event = await watcherStore.acknowledgeEvent(identity.userId, watcherEventAckMatch[1]);
          return json(res, 200, { event });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Watcher operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const isProfileRoot = url.pathname === "/v1/profile";
    const isProfileTopics = url.pathname === "/v1/profile/topics";
    const profileTopicMatch = /^\/v1\/profile\/topics\/([a-f0-9-]{36})$/i.exec(url.pathname);
    if (isProfileRoot || isProfileTopics || profileTopicMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (isProfileRoot && req.method === "GET") {
          return json(res, 200, {
            profile: await profileStore.get(identity.userId),
            options: {
              explanationStyles: EXPLANATION_STYLES,
              changePresentations: CHANGE_PRESENTATIONS,
              interruptionTolerances: INTERRUPTION_TOLERANCES,
              chunkSizes: CHUNK_SIZES,
              learningModes: LEARNING_MODES,
              confidenceLevels: TOPIC_CONFIDENCE_LEVELS
            }
          });
        }
        if (isProfileRoot && (req.method === "PUT" || req.method === "PATCH")) {
          const body = await readJsonBody(req);
          const profile = await profileStore.update(identity.userId, body);
          return json(res, 200, { profile });
        }
        if (isProfileTopics && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 201, await profileStore.addTopic(identity.userId, body));
        }
        if (profileTopicMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          return json(res, 200, await profileStore.updateTopic(identity.userId, profileTopicMatch[1], body));
        }
        if (profileTopicMatch && req.method === "DELETE") {
          return json(res, 200, await profileStore.removeTopic(identity.userId, profileTopicMatch[1]));
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Workflow profile operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const isCapsulesCollection = url.pathname === "/v1/capsules";
    const capsuleMatch = /^\/v1\/capsules\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const capsuleActivateMatch = /^\/v1\/capsules\/([a-f0-9-]{36})\/activate$/i.exec(url.pathname);
    if (isCapsulesCollection || capsuleMatch || capsuleActivateMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const knownScopes = new Set(toolRegistry.list().map((tool) => tool.scope));
        if (isCapsulesCollection && req.method === "GET") {
          const data = await capsuleStore.list(identity.userId);
          return json(res, 200, { ...data, privacyPostures: PRIVACY_POSTURES });
        }
        if (isCapsulesCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.projectId) await projectStore.get(identity.userId, body.projectId);
          const capsule = await capsuleStore.create(identity.userId, body, { allowedScopes: knownScopes });
          return json(res, 201, { capsule });
        }
        if (capsuleMatch && req.method === "GET") {
          return json(res, 200, { capsule: await capsuleStore.get(identity.userId, capsuleMatch[1]) });
        }
        if (capsuleMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          if (body.projectId) await projectStore.get(identity.userId, body.projectId);
          const capsule = await capsuleStore.update(identity.userId, capsuleMatch[1], body, { allowedScopes: knownScopes });
          return json(res, 200, { capsule });
        }
        if (capsuleMatch && req.method === "DELETE") {
          return json(res, 200, await capsuleStore.remove(identity.userId, capsuleMatch[1]));
        }
        if (capsuleActivateMatch && req.method === "POST") {
          const { activeCapsuleId, capsule } = await capsuleStore.markActivated(identity.userId, capsuleActivateMatch[1]);
          const profile = await profileStore.update(identity.userId, { learningMode: capsule.learningMode });
          const grantedLeases = [];
          for (const lease of (capsule.leaseTemplate || [])) {
            if (!knownScopes.has(lease.scope)) continue;
            await permissionStore.grant(identity.userId, lease.scope, {
              ttlMinutes: lease.ttlMinutes ?? null,
              projectId: capsule.projectId || null,
              note: `Activated via capsule "${capsule.name}"`
            });
            grantedLeases.push({ scope: lease.scope, ttlMinutes: lease.ttlMinutes ?? null, projectId: capsule.projectId || null });
          }
          await auditStore.record(identity.userId, {
            event: "capsule.activated",
            actor: "user",
            toolId: capsule.id,
            risk: "low",
            status: "active",
            detail: `Activated Context Capsule "${capsule.name}" (${capsule.workingMode} · ${capsule.learningMode} · ${grantedLeases.length} lease(s)).`
          });
          return json(res, 200, { activeCapsuleId, capsule, profile, grantedLeases });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Context capsule operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/graph") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const graph = await buildUserKnowledgeGraph(
          identity.userId,
          { projectStore, memoryStore, ideaStore, watcherStore, capsuleStore, profileStore },
          {
            projectId: url.searchParams.get("projectId") || "",
            kind: url.searchParams.get("kind") || "",
            query: url.searchParams.get("q") || "",
            focusNodeId: url.searchParams.get("focusNodeId") || "",
            hops: url.searchParams.get("hops") || 2
          }
        );
        return json(res, 200, { graph });
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Knowledge graph unavailable.",
          ...(error.code ? { code: error.code } : {})
        });
      }
    }

    if (url.pathname === "/v1/storage/status" || url.pathname === "/v1/storage/migrate") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const storageDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      try {
        if (url.pathname === "/v1/storage/status" && req.method === "GET") {
          const storage = await getUserStorageStatus(storageDataDir, identity.userId);
          return json(res, 200, { storage });
        }
        if (url.pathname === "/v1/storage/migrate" && req.method === "POST") {
          const migration = await migrateUserStorageToSqlite(storageDataDir, identity.userId);
          await auditStore.record(identity.userId, {
            event: "storage.migrate",
            actor: "user",
            risk: "low",
            status: "completed",
            detail: `SQLite WAL sync complete: ${migration.migratedCollections.length} migrated, ${migration.ftsIndexedRows} FTS5 rows indexed.`
          });
          const storage = await getUserStorageStatus(storageDataDir, identity.userId);
          return json(res, 200, { ok: true, migration, storage });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Storage operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/search") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const storageDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      try {
        const search = await hybridSearchWorkspace(storageDataDir, identity.userId, {
          q: url.searchParams.get("q") || "",
          collection: url.searchParams.get("collection") || "",
          entityType: url.searchParams.get("entityType") || "",
          mode: url.searchParams.get("mode") || "hybrid",
          limit: url.searchParams.get("limit") || 20
        });
        return json(res, 200, { search });
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Workspace search failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
    }

    if (url.pathname === "/v1/integrations/status") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
      try { await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      return json(res, 200, { integrations: getModularIntegrationsStatus({ petrioHarnessClient }) });
    }

    const jobMatch = /^\/v1\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
    const jobCancelMatch = /^\/v1\/jobs\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
    if (url.pathname === "/v1/jobs" || jobMatch || jobCancelMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/jobs" && req.method === "GET") {
          await jobEngine.recoverUser(identity.userId);
          const jobs = await jobStore.list(identity.userId, {
            status: url.searchParams.get("status") || "",
            limit: url.searchParams.get("limit") || 40
          });
          return json(res, 200, { jobs });
        }
        if (url.pathname === "/v1/jobs" && req.method === "POST") {
          return json(res, 400, { error: "Submit a typed task through its dedicated endpoint. Arbitrary job kinds are not executable." });
        }
        if (jobMatch && req.method === "GET") {
          await jobEngine.recoverUser(identity.userId);
          return json(res, 200, { job: await jobStore.get(identity.userId, jobMatch[1]) });
        }
        if (jobCancelMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const cancelled = await jobEngine.cancel(identity.userId, jobCancelMatch[1], body.reason || "Cancelled by user");
          return json(res, 200, { job: cancelled });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Job operation failed.", ...(error.code ? { code: error.code } : {}) });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/workshop/roles" || url.pathname === "/v1/workshop/delegate") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/workshop/roles" && req.method === "GET") {
          return json(res, 200, { roles: listSpecialistRoles() });
        }
        if (url.pathname === "/v1/workshop/delegate" && req.method === "POST") {
          const body = await readJsonBody(req);
          const storageDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
          const task = await createWorkshopTask({
            userId: identity.userId,
            roleId: body.role || body.roleId,
            objective: body.objective,
            projectId: body.projectId || null,
            stores: workshopStores,
            dataDirectory: storageDataDir
          });
          jobEngine.enqueue(identity.userId, task.job);
          return json(res, 202, { job: task.job });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Workshop delegation failed.", ...(error.code ? { code: error.code } : {}) });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/privacy/airlock/preview") {
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
      try { await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const body = await readJsonBody(req);
        const sanitized = sanitizeForCloud(body.text || "", { customTerms: body.customTerms || [] });
        const rehydratedSample = rehydrateFromCloud(sanitized.sanitizedText, sanitized.tokenMap);
        return json(res, 200, {
          airlock: {
            sanitizedText: sanitized.sanitizedText,
            redactedCount: sanitized.redactedCount,
            categoryCounts: sanitized.categoryCounts,
            redactions: sanitized.redactions,
            rehydrationVerified: rehydratedSample === String(body.text || "")
          }
        });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message || "Airlock preview failed." });
      }
    }

    if (url.pathname === "/v1/voice/status" || url.pathname === "/v1/voice/transcribe" || url.pathname === "/v1/voice/synthesize") {
      try { await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/voice/status" && req.method === "GET") {
          return json(res, 200, { voice: getVoiceStatus() });
        }
        if (url.pathname === "/v1/voice/transcribe" && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await transcribeAudio(body));
        }
        if (url.pathname === "/v1/voice/synthesize" && req.method === "POST") {
          const body = await readJsonBody(req);
          return json(res, 200, await synthesizeSpeech(body));
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Voice operation failed.", ...(error.code ? { code: error.code } : {}) });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/reflections" || url.pathname === "/v1/reflections/snapshot") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const [projects, memories, ideas, watchers, watcherEvents, profile] = await Promise.all([
          projectStore.list(identity.userId),
          memoryStore.list(identity.userId, { limit: 200 }),
          ideaStore.list(identity.userId),
          watcherStore.list(identity.userId),
          watcherStore.listEvents(identity.userId, { limit: 50 }),
          profileStore.get(identity.userId)
        ]);
        if (url.pathname === "/v1/reflections" && req.method === "GET") {
          const period = url.searchParams.get("period") || "weekly";
          const reflection = buildContinuityReflection({ projects, memories, ideas, watchers, watcherEvents, profile }, { period });
          const snapshots = await reflectionStore.list(identity.userId, { limit: 12 });
          return json(res, 200, { reflection, snapshots });
        }
        if (url.pathname === "/v1/reflections/snapshot" && req.method === "POST") {
          const body = await readJsonBody(req);
          const reflection = buildContinuityReflection({ projects, memories, ideas, watchers, watcherEvents, profile }, { period: body.period || "weekly" });
          const saved = await reflectionStore.saveSnapshot(identity.userId, reflection);
          return json(res, 201, { snapshot: saved });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Reflection generation failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/ambient/state" || url.pathname === "/v1/ambient/push") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        const [projects, memories, ideas, watchers, watcherEvents, capsuleState, profile, pendingApprovals, activeJobs, vram] = await Promise.all([
          projectStore.list(identity.userId),
          memoryStore.list(identity.userId, { limit: 200 }),
          ideaStore.list(identity.userId),
          watcherStore.list(identity.userId),
          watcherStore.listEvents(identity.userId, { limit: 40 }),
          capsuleStore.list(identity.userId),
          profileStore.get(identity.userId),
          pendingActionStore.list(identity.userId),
          jobStore.list(identity.userId, { status: "running", limit: 20 }),
          resolvedProviderStore.getEffectiveConfig(identity.userId)
            .then(({ config }) => vramMonitor.inspect({ endpoints: config.endpoints }))
            .catch(() => null)
        ]);
        const presence = deriveAmbientPresence({
          projects,
          memories,
          ideas,
          watchers,
          watcherEvents,
          capsules: capsuleState.capsules,
          activeCapsuleId: capsuleState.activeCapsuleId,
          profile,
          vram,
          pendingApprovals,
          activeJobs
        });
        if (url.pathname === "/v1/ambient/state" && req.method === "GET") {
          return json(res, 200, { presence });
        }
        if (url.pathname === "/v1/ambient/push" && req.method === "POST") {
          const bridgeResult = await dispatchAmbientBridge(presence);
          return json(res, 200, { presence, bridge: bridgeResult });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Ambient state unavailable." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    // --- Phase 6.1: Sovereign Encrypted Vault Backup, Verify & Restore ---
    if (url.pathname === "/v1/vault/export" || url.pathname === "/v1/vault/verify" || url.pathname === "/v1/vault/restore") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const vaultDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      try {
        if (url.pathname === "/v1/vault/export" && req.method === "POST") {
          const body = await readJsonBody(req);
          const exported = await exportEncryptedVault({
            dataDirectory: vaultDataDir,
            userId: identity.userId,
            passphrase: body.passphrase
          });
          await auditStore.record(identity.userId, {
            event: "vault.exported",
            actor: "user",
            risk: "medium",
            status: "completed",
            detail: `Exported AES-256-GCM sovereign vault (${exported.summary.collectionCount} collections, sha256=${exported.summary.manifestSha256.slice(0, 12)}…).`
          });
          return json(res, 200, exported);
        }
        if (url.pathname === "/v1/vault/verify" && req.method === "POST") {
          const body = await readJsonBody(req, MAX_VAULT_BODY_BYTES);
          const verification = verifyEncryptedVault({
            archive: body.archive,
            userId: identity.userId,
            passphrase: body.passphrase
          });
          return json(res, 200, { verification });
        }
        if (url.pathname === "/v1/vault/restore" && req.method === "POST") {
          const body = await readJsonBody(req, MAX_VAULT_BODY_BYTES);
          const restored = await restoreEncryptedVault({
            dataDirectory: vaultDataDir,
            userId: identity.userId,
            archive: body.archive,
            passphrase: body.passphrase,
            mode: body.mode === "replace" ? "replace" : "merge"
          });
          await auditStore.record(identity.userId, {
            event: "vault.restored",
            actor: "user",
            risk: "high",
            status: "completed",
            detail: `Restored encrypted vault (${restored.mode} mode, ${restored.restoredCollections.length} collections).`
          });
          return json(res, 200, { restored });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Vault operation failed.", ...(error.code ? { code: error.code } : {}) });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    // --- Phase 6.2: Deterministic Workspace Self-Audit & Safe Remediations ---
    if (url.pathname === "/v1/diagnostics/audit" || url.pathname === "/v1/diagnostics/remediate") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const diagDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      const allStores = {
        projectStore,
        memoryStore,
        ideaStore,
        watcherStore,
        permissionStore,
        pendingActionStore,
        jobStore,
        playbookStore
      };
      try {
        if (url.pathname === "/v1/diagnostics/audit" && req.method === "GET") {
          const audit = await runWorkspaceSelfAudit({ userId: identity.userId, dataDirectory: diagDataDir, stores: allStores });
          return json(res, 200, { audit });
        }
        if (url.pathname === "/v1/diagnostics/remediate" && req.method === "POST") {
          const body = await readJsonBody(req);
          const remediation = await applySafeRemediation({
            userId: identity.userId,
            dataDirectory: diagDataDir,
            stores: allStores,
            action: body.action
          });
          await auditStore.record(identity.userId, {
            event: "diagnostics.remediated",
            actor: "user",
            risk: "low",
            status: "completed",
            detail: remediation.detail
          });
          const audit = await runWorkspaceSelfAudit({ userId: identity.userId, dataDirectory: diagDataDir, stores: allStores });
          return json(res, 200, { remediation, audit });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Workspace diagnostics failed.", ...(error.code ? { code: error.code } : {}) });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    // --- Phase 6.3: Scoped Peer Client Tokens & Quick-Capture API ---
    if (url.pathname === "/v1/clients/tokens" || /^\/v1\/clients\/tokens\/[a-f0-9-]{36}$/i.test(url.pathname)) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/clients/tokens" && req.method === "GET") {
          const tokens = await peerTokenStore.list(identity.userId);
          return json(res, 200, { tokens, availableScopes: PEER_TOKEN_SCOPES });
        }
        if (url.pathname === "/v1/clients/tokens" && req.method === "POST") {
          const body = await readJsonBody(req);
          const minted = await peerTokenStore.create(identity.userId, body);
          await auditStore.record(identity.userId, {
            event: "peer_token.created",
            actor: "user",
            risk: "medium",
            status: "completed",
            detail: `Minted peer client token "${minted.record.name}" [${minted.record.scopes.join(", ")}].`
          });
          return json(res, 201, minted);
        }
        const tokenMatch = /^\/v1\/clients\/tokens\/([a-f0-9-]{36})$/i.exec(url.pathname);
        if (tokenMatch && req.method === "DELETE") {
          const revoked = await peerTokenStore.revoke(identity.userId, tokenMatch[1]);
          await auditStore.record(identity.userId, {
            event: "peer_token.revoked",
            actor: "user",
            risk: "low",
            status: "completed",
            detail: `Revoked peer client token "${revoked.name}".`
          });
          return json(res, 200, { token: revoked });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Peer token request failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/peer/status" || url.pathname === "/v1/peer/capture" || url.pathname === "/v1/peer/search") {
      const peerHeader = String(req.headers["x-alfie-peer-token"] || "").trim();
      const requiredScope = url.pathname === "/v1/peer/capture"
        ? "capture:write"
        : (url.pathname === "/v1/peer/search" ? "search:read" : "status:read");
      let peerAuth;
      try {
        peerAuth = await peerTokenStore.authenticate(peerHeader, requiredScope);
      } catch (error) {
        return json(res, error.status || 403, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      if (!peerAuth) {
        return json(res, 401, { error: "Valid, unrevoked Alfie Peer Token required." });
      }
      const peerDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      try {
        if (url.pathname === "/v1/peer/status" && req.method === "GET") {
          const [projects, ideas, memories] = await Promise.all([
            projectStore.list(peerAuth.userId),
            ideaStore.list(peerAuth.userId),
            memoryStore.list(peerAuth.userId, { limit: 200 })
          ]);
          return json(res, 200, {
            status: "ok",
            client: { name: peerAuth.name, scopes: peerAuth.scopes },
            counts: { projects: projects.length, ideas: ideas.length, memories: memories.length }
          });
        }
        if (url.pathname === "/v1/peer/capture" && req.method === "POST") {
          const body = await readJsonBody(req);
          const kind = body.kind === "memory" ? "memory" : "idea";
          const text = String(body.text || body.title || "").trim();
          if (!text) return json(res, 400, { error: "text is required for quick capture." });
          if (kind === "memory") {
            const memory = await memoryStore.create(peerAuth.userId, {
              kind: body.memoryKind || "note",
              text,
              trust: "user_authored",
              source: `peer:${peerAuth.name}`
            });
            return json(res, 201, { captured: "memory", memory });
          }
          const idea = await ideaStore.create(peerAuth.userId, {
            title: text.slice(0, 140),
            notes: body.notes || `Captured via Peer CLI (${peerAuth.name})`,
            priority: body.priority || "medium",
            projectId: body.projectId || ""
          });
          return json(res, 201, { captured: "idea", idea });
        }
        if (url.pathname === "/v1/peer/search" && req.method === "GET") {
          const q = url.searchParams.get("q") || "";
          const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") || 10)));
          const search = await hybridSearchWorkspace(peerDataDir, peerAuth.userId, { q, limit, mode: "hybrid" });
          return json(res, 200, { search });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Peer endpoint failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    // --- Phase 6.4: Deterministic Automation Playbooks ---
    if (url.pathname === "/v1/playbooks" || /^\/v1\/playbooks\/[a-f0-9-]{36}(\/run)?$/i.test(url.pathname)) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const pbDataDir = memoryStore.dataDirectory || projectStore.dataDirectory || process.env.ALFIE_CORE_DATA_DIR || "/data";
      try {
        if (url.pathname === "/v1/playbooks" && req.method === "GET") {
          const playbooks = await playbookStore.list(identity.userId);
          return json(res, 200, { playbooks, triggers: PLAYBOOK_TRIGGERS, actions: PLAYBOOK_ACTIONS });
        }
        if (url.pathname === "/v1/playbooks" && req.method === "POST") {
          const body = await readJsonBody(req);
          const playbook = await playbookStore.create(identity.userId, body);
          return json(res, 201, { playbook });
        }
        const runMatch = /^\/v1\/playbooks\/([a-f0-9-]{36})\/run$/i.exec(url.pathname);
        if (runMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await runPlaybook({
            userId: identity.userId,
            playbookId: runMatch[1],
            dryRun: body.dryRun === true,
            stores: {
              playbookStore,
              projectStore,
              memoryStore,
              ideaStore,
              watcherStore,
              capsuleStore,
              profileStore,
              permissionStore,
              reflectionStore,
              auditStore
            },
            jobEngine,
            dataDirectory: pbDataDir
          });
          return json(res, 200, result);
        }
        const pbMatch = /^\/v1\/playbooks\/([a-f0-9-]{36})$/i.exec(url.pathname);
        if (pbMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          const playbook = await playbookStore.update(identity.userId, pbMatch[1], body);
          return json(res, 200, { playbook });
        }
        if (pbMatch && req.method === "DELETE") {
          return json(res, 200, await playbookStore.delete(identity.userId, pbMatch[1]));
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Playbook request failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    // --- Phase 6.5: Chronological Continuity Timeline & Portable Markdown Digest ---
    if (url.pathname === "/v1/timeline" || url.pathname === "/v1/export/markdown") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      const exportStores = { projectStore, memoryStore, ideaStore, jobStore, reflectionStore, profileStore };
      try {
        if (url.pathname === "/v1/timeline" && req.method === "GET") {
          const timeline = await buildContinuityTimeline({
            userId: identity.userId,
            stores: exportStores,
            projectId: url.searchParams.get("projectId") || "",
            kind: url.searchParams.get("kind") || "all",
            limit: Number(url.searchParams.get("limit") || 40)
          });
          return json(res, 200, { timeline });
        }
        if (url.pathname === "/v1/export/markdown" && req.method === "GET") {
          const digest = await exportMarkdownDigest({
            userId: identity.userId,
            stores: exportStores,
            projectId: url.searchParams.get("projectId") || ""
          });
          return json(res, 200, { digest });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "Timeline/export failed." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    if (url.pathname === "/v1/system/vram/host-report") {
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
      try {
        const body = await readJsonBody(req);
        const result = vramMonitor.reportExternalHost(body);
        if (body.clear === true) {
          const vram = await vramMonitor.inspect({ endpoints: providers.endpoints });
          return json(res, 200, { ok: true, cleared: true, vram });
        }
        return json(res, 200, { ok: true, vram: result });
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "External VRAM report failed." });
      }
    }

    if (url.pathname === "/v1/system/vram" || url.pathname === "/v1/system/vram/report") {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/system/vram" && req.method === "GET") {
          const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
          const vram = await vramMonitor.inspect({ userId: identity.userId, endpoints: userProviders.endpoints });
          return json(res, 200, { vram });
        }
        if (url.pathname === "/v1/system/vram/report" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = vramMonitor.report(identity.userId, body);
          if (body.clear === true) {
            const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
            const vram = await vramMonitor.inspect({ userId: identity.userId, endpoints: userProviders.endpoints });
            return json(res, 200, { cleared: true, vram });
          }
          return json(res, 200, { vram: result });
        }
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || "VRAM status unavailable." });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const conversationMatch = /^\/v1\/conversations\/([a-f0-9-]{36})$/i.exec(url.pathname);
    const handoffMatch = /^\/v1\/conversations\/([a-f0-9-]{36})\/handoff$/i.exec(url.pathname);
    const messageMatch = /^\/v1\/conversations\/([a-f0-9-]{36})\/messages$/i.exec(url.pathname);
    const reactionMatch = /^\/v1\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/reaction$/i.exec(url.pathname);
    const isConversationCollection = url.pathname === "/v1/conversations";
    const isConversationDatabase = url.pathname === "/v1/conversations/database";
    const isConversationImport = url.pathname === "/v1/conversations/import";
    if (isConversationCollection || isConversationDatabase || isConversationImport || conversationMatch || handoffMatch || messageMatch || reactionMatch) {
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
          const projectId = url.searchParams.get("projectId") || undefined;
          return json(res, 200, { conversations: await conversationStore.list(identity.userId, { projectId }) });
        }
        if (isConversationCollection && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.projectId) {
            await projectStore.get(identity.userId, body.projectId);
          }
          const conversation = await conversationStore.create(identity.userId, {
            title: body.title,
            projectId: body.projectId ?? null,
            parentConversationId: body.parentConversationId ?? null,
            continuedFromTitle: body.continuedFromTitle ?? null,
            handoffContext: body.handoffContext ?? null
          });
          return json(res, 201, { conversation });
        }
        if (handoffMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const source = await conversationStore.get(identity.userId, handoffMatch[1]);
          const targetProjectId = body.projectId !== undefined ? (body.projectId || null) : (source.projectId || null);
          let project = null;
          if (targetProjectId) {
            project = await projectStore.get(identity.userId, targetProjectId);
          }
          const brief = buildHandoffBrief(source, {
            project,
            extraNotes: body.extraNotes || "",
            reason: body.reason === "vram_threshold" ? "vram_threshold" : "context_handoff"
          });
          const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : brief.title;
          const conversation = await conversationStore.create(identity.userId, {
            title,
            projectId: targetProjectId,
            parentConversationId: source.id,
            continuedFromTitle: source.title,
            handoffContext: brief.summary
          });
          return json(res, 201, { conversation, handoff: brief });
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
        if (reactionMatch && (req.method === "POST" || req.method === "PUT")) {
          const body = await readJsonBody(req);
          const message = await conversationStore.reactMessage(identity.userId, reactionMatch[1], reactionMatch[2], body.reaction);
          return json(res, 200, { message });
        }
        if (conversationMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "") {
            await projectStore.get(identity.userId, body.projectId);
          }
          const updated = body.projectId !== undefined
            ? await conversationStore.update(identity.userId, conversationMatch[1], {
                ...(body.title !== undefined ? { title: body.title } : {}),
                projectId: body.projectId
              })
            : await conversationStore.rename(identity.userId, conversationMatch[1], body.title);
          return json(res, 200, { conversation: updated });
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

    const providerEndpointMatch = /^\/v1\/providers\/endpoints\/([a-z0-9_-]{1,64})$/i.exec(url.pathname);
    if (
      url.pathname === "/v1/providers" ||
      url.pathname === "/v1/providers/health" ||
      url.pathname === "/v1/providers/settings" ||
      url.pathname === "/v1/providers/endpoints" ||
      url.pathname === "/v1/providers/test" ||
      providerEndpointMatch
    ) {
      // Backwards-compatible read path: allow service-token-only GET /v1/providers & /v1/providers/health
      // when no user identity headers are supplied; require signed identity on all user reads and mutations.
      if (req.method === "GET" && (url.pathname === "/v1/providers" || url.pathname === "/v1/providers/health") && !hasIdentityHeaders(req.headers)) {
        if (url.pathname === "/v1/providers") {
          return json(res, 200, { ...publicConfig(providers), source: "environment", updatedAt: null, maxEndpoints: 8 });
        }
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const health = await Promise.all(providers.endpoints.map((endpoint) =>
          forceRefresh
            ? providerRegistry.inspect(endpoint)
            : providerRegistry.inspectCached(endpoint, providers.healthIntervalSeconds)));
        return json(res, 200, { mode: providers.mode, endpoints: health });
      }

      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }

      try {
        if (req.method === "GET" && url.pathname === "/v1/providers") {
          return json(res, 200, await resolvedProviderStore.getPublicState(identity.userId));
        }
        if (req.method === "GET" && url.pathname === "/v1/providers/health") {
          const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
          const forceRefresh = url.searchParams.get("refresh") === "1";
          const health = await Promise.all(userProviders.endpoints.map((endpoint) =>
            forceRefresh
              ? providerRegistry.inspect(endpoint)
              : providerRegistry.inspectCached(endpoint, userProviders.healthIntervalSeconds)));
          return json(res, 200, { mode: userProviders.mode, endpoints: health });
        }
        if (req.method === "PUT" && url.pathname === "/v1/providers/settings") {
          const body = await readJsonBody(req);
          const updated = await resolvedProviderStore.updateSettings(identity.userId, body);
          providerRegistry.clearHealthCache();
          await auditStore.record(identity.userId, {
            event: "provider.settings_updated",
            actor: "user",
            toolId: "providers",
            risk: "low",
            status: "updated",
            detail: `Routing mode set to ${updated.mode}, health interval ${updated.healthIntervalSeconds}s.`
          });
          return json(res, 200, { config: updated });
        }
        if (req.method === "POST" && url.pathname === "/v1/providers/endpoints") {
          const body = await readJsonBody(req);
          const created = await resolvedProviderStore.addEndpoint(identity.userId, body);
          providerRegistry.clearHealthCache(created.endpoint.id);
          await auditStore.record(identity.userId, {
            event: "provider.endpoint_added",
            actor: "user",
            toolId: created.endpoint.id,
            risk: created.endpoint.trustedLocal ? "medium" : "low",
            status: created.endpoint.enabled ? "enabled" : "disabled",
            detail: `Added ${created.endpoint.provider} endpoint "${created.endpoint.name}" (${created.endpoint.baseUrl}, model: ${created.endpoint.model || "unset"}, trustedLocal: ${created.endpoint.trustedLocal}, keyConfigured: ${created.endpoint.apiKeyConfigured}).`
          });
          return json(res, 201, created);
        }
        if (req.method === "PATCH" && providerEndpointMatch) {
          const body = await readJsonBody(req);
          const updated = await resolvedProviderStore.updateEndpoint(identity.userId, providerEndpointMatch[1], body);
          providerRegistry.clearHealthCache(updated.endpoint.id);
          await auditStore.record(identity.userId, {
            event: "provider.endpoint_updated",
            actor: "user",
            toolId: updated.endpoint.id,
            risk: updated.endpoint.trustedLocal ? "medium" : "low",
            status: updated.endpoint.enabled ? "enabled" : "disabled",
            detail: `Updated ${updated.endpoint.provider} endpoint "${updated.endpoint.name}" (${updated.endpoint.baseUrl}, model: ${updated.endpoint.model || "unset"}, priority: ${updated.endpoint.priority}, key: ${updated.keyAction}).`
          });
          return json(res, 200, { endpoint: updated.endpoint, config: updated.config });
        }
        if (req.method === "DELETE" && providerEndpointMatch) {
          const removed = await resolvedProviderStore.removeEndpoint(identity.userId, providerEndpointMatch[1]);
          providerRegistry.clearHealthCache(removed.removed.id);
          await auditStore.record(identity.userId, {
            event: "provider.endpoint_removed",
            actor: "user",
            toolId: removed.removed.id,
            risk: "low",
            status: "removed",
            detail: `Removed ${removed.removed.provider} endpoint "${removed.removed.name}" (${removed.removed.baseUrl}).`
          });
          return json(res, 200, removed);
        }
        if (req.method === "POST" && url.pathname === "/v1/providers/test") {
          const body = await readJsonBody(req);
          const candidate = await resolvedProviderStore.prepareTestEndpoint(identity.userId, body);
          const result = await providerRegistry.inspect(candidate);
          await auditStore.record(identity.userId, {
            event: "provider.connection_tested",
            actor: "user",
            toolId: candidate.id,
            risk: "low",
            status: result.online ? "online" : "offline",
            detail: result.online
              ? `Tested ${candidate.provider} endpoint (${candidate.baseUrl}): online in ${result.latencyMs}ms, ${result.models.length} model(s) discovered.`
              : `Tested ${candidate.provider} endpoint (${candidate.baseUrl}): offline (${result.error || "unreachable"}).`
          });
          return json(res, 200, {
            ok: result.online,
            provider: candidate.provider,
            baseUrl: candidate.baseUrl,
            trustedLocal: candidate.trustedLocal,
            ...result
          });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Provider configuration operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const cloudAgentMatch = /^\/v1\/cloud-agents\/(gemini|openai)$/.exec(url.pathname);
    const cloudAgentPreviewMatch = /^\/v1\/cloud-agents\/(gemini|openai)\/privacy-preview$/.exec(url.pathname);
    if (url.pathname === "/v1/cloud-agents" || cloudAgentMatch || cloudAgentPreviewMatch) {
      let identity;
      try { identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search }); }
      catch (error) { return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      try {
        if (url.pathname === "/v1/cloud-agents" && req.method === "GET") {
          return json(res, 200, await cloudAgentStore.getPublicState(identity.userId));
        }
        if (cloudAgentMatch && req.method === "GET") {
          return json(res, 200, { agent: await cloudAgentStore.getAgent(identity.userId, cloudAgentMatch[1]) });
        }
        if (cloudAgentMatch && req.method === "PATCH") {
          const body = await readJsonBody(req);
          const agent = await cloudAgentStore.updateAgent(identity.userId, cloudAgentMatch[1], body);
          const exposed = agent.privacySummary?.allowedPersonalCategories || [];
          await auditStore.record(identity.userId, {
            event: "cloud_agent.privacy_updated",
            actor: "user",
            toolId: agent.provider,
            risk: exposed.length ? "medium" : "low",
            status: agent.enabled ? "enabled" : "disabled",
            detail: exposed.length
              ? `Optional private access enabled for ${agent.name}: ${exposed.join(", ")}.`
              : `${agent.name} set to strict coding-only isolation (all private sections blocked).`
          });
          return json(res, 200, { agent });
        }
        if (cloudAgentPreviewMatch && req.method === "POST") {
          const body = await readJsonBody(req);
          const agent = await cloudAgentStore.getAgent(identity.userId, cloudAgentPreviewMatch[1]);
          const optIn = typeof body?.privateAccessOptIn === "boolean" ? body.privateAccessOptIn : agent.privateAccessOptIn;
          const rawVis = body?.visibility ? { ...agent.visibility, ...body.visibility } : agent.visibility;
          const visibility = optIn ? rawVis : {
            ...rawVis,
            allowMail: false,
            allowCalendar: false,
            allowJournal: false,
            allowPersonalMemories: false,
            allowDashboardState: false
          };
          const grantedScopes = await permissionStore.list(identity.userId);
          const scopeSplit = filterGrantedScopes(grantedScopes, toolRegistry, visibility);
          return json(res, 200, {
            provider: agent.provider,
            name: agent.name,
            privateAccessOptIn: optIn,
            summary: summarizePrivacy(visibility),
            allowedScopes: scopeSplit.allowedScopes,
            blockedScopes: scopeSplit.blockedScopes
          });
        }
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message || "Cloud agent settings operation failed.",
          ...(error.code ? { code: error.code } : {})
        });
      }
      return json(res, 405, { error: "Method not allowed." });
    }

    const imageFileMatch = /^\/v1\/images\/([a-zA-Z0-9._-]{1,128})$/.exec(url.pathname);
    if (imageFileMatch && req.method === "GET") {
      try {
        const { buffer, mimeType } = await imageGenerator.getImage(imageFileMatch[1]);
        res.writeHead(200, {
          "content-type": mimeType,
          "content-length": buffer.length,
          "cache-control": "public, max-age=86400, immutable",
          "x-content-type-options": "nosniff"
        });
        return res.end(buffer);
      } catch (err) {
        return json(res, err.status || 404, { error: err.message || "Visual asset not found." });
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/images/generate") {
      let identity;
      try {
        identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search });
      } catch (error) {
        return json(res, error.status || 401, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      try {
        const body = await readJsonBody(req);
        const image = await imageGenerator.generate({ prompt: body.prompt, style: body.style });
        return json(res, 201, {
          image,
          markdown: `![${image.prompt}](${image.url})`
        });
      } catch (err) {
        return json(res, err.status || 500, { error: err.message || "Failed to generate visual asset." });
      }
    }


    if (req.method === "POST" && url.pathname === "/v1/chat/stream") {
      const controller = new AbortController();
      let streamHeadersSent = false;
      req.on("aborted", () => controller.abort());
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        const identity = await resolveIdentity(identityAuth, identityLinkStore, req.headers, { method: req.method, path: url.pathname + url.search });
        const body = await readJsonBody(req);
        const ensureStreamHeaders = (status = 200) => {
          if (streamHeadersSent || res.headersSent) return;
          streamHeadersSent = true;
          res.writeHead(status, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no"
          });
          res.flushHeaders?.();
        };

        const onProgress = (event) => {
          ensureStreamHeaders(200);
          writeStreamEvent(res, event);
        };
        // Keep reverse proxies (including Cloudflare) aware that a long model turn is alive.
        // Heartbeats carry no model content and do not alter the conversation transcript.
        const heartbeat = setInterval(() => {
          if (controller.signal.aborted || res.destroyed) return;
          ensureStreamHeaders(200);
          writeStreamEvent(res, { type: "heartbeat", at: new Date().toISOString() });
        }, 15_000);
        heartbeat.unref?.();

        const agentProvider = ["local", "gemini", "openai"].includes(body.agentProvider) ? body.agentProvider : "local";
        const workingMode = resolveWorkingMode(body.workingMode).id;
        const projectId = typeof body.projectId === "string" && /^[a-f0-9-]{36}$/i.test(body.projectId) ? body.projectId : null;
        const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
        let result;
        try {
          result = await agentLoop.run({
            userId: identity.userId, messages: cleanMessages(body.messages),
            dashboardState: body.dashboardState || {},
            mode: ["auto", "light", "standard", "work"].includes(body.mode) ? body.mode : userProviders.mode,
            workingMode,
            projectId,
            agentProvider,
            turnId: body.turnId || randomUUID(), signal: controller.signal,
            onProgress
          });
        } finally {
          clearInterval(heartbeat);
        }
        if (controller.signal.aborted) return;
        ensureStreamHeaders(result.status === "awaiting_user_approval" ? 202 : 200);
        writeStreamEvent(res, { type: "meta", status: result.status, steps: result.steps, ...(result.privacyReport ? { privacyReport: result.privacyReport } : {}), ...(result.provenance ? { provenance: result.provenance } : {}) });
        if (result.message) writeStreamEvent(res, { type: "delta", content: result.message });
        if (result.status === "awaiting_user_approval") {
          writeStreamEvent(res, { type: "approval_required", actionId: result.actionId, toolId: result.toolId, summary: result.summary });
        }
        writeStreamEvent(res, { type: "done", ...result });
        res.end();
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error.message || "Alfie could not complete the response.";
        if (streamHeadersSent || res.headersSent) {
          writeStreamEvent(res, { type: "error", error: message, ...(error.code ? { code: error.code } : {}) });
          res.end();
          return;
        }
        return json(res, Number.isInteger(error.status) ? error.status : 502, { error: message, ...(error.code ? { code: error.code } : {}) });
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
        const { config: userProviders } = await resolvedProviderStore.getEffectiveConfig(identity.userId);
        const requestedMode = ["auto", "light", "standard", "work"].includes(body.mode) ? body.mode : userProviders.mode;
        const workingMode = resolveWorkingMode(body.workingMode).id;
        const projectId = typeof body.projectId === "string" && /^[a-f0-9-]{36}$/i.test(body.projectId) ? body.projectId : null;
        const agentProvider = ["local", "gemini", "openai"].includes(body.agentProvider) ? body.agentProvider : "local";
        const turnId = randomUUID();
        try {
          const result = await agentLoop.run({
            userId: identity.userId, messages, dashboardState: body.dashboardState || {},
            mode: requestedMode, workingMode, projectId, agentProvider, turnId, signal: controller.signal
          });
          return json(res, result.status === "awaiting_user_approval" ? 202 : 200, result);
        } finally {
          toolDispatcher.resetTurn(turnId);
        }
      } catch (error) {
        return json(res, Number.isInteger(error.status) ? error.status : 502, {
          error: error.message || "Alfie could not complete the response.",
          ...(error.code ? { code: error.code } : {})
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
