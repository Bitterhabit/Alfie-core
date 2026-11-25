function configurationError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

export const CHAT_REQUEST_TIMEOUT_MS = 35 * 60 * 1000;
export const APPROVAL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function createAlfieCoreClient({
  baseUrl = process.env.ALFIE_CORE_URL || "http://alfie-core:8780",
  serviceToken = process.env.ALFIE_CORE_SERVICE_TOKEN || "",
  identityAuth,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000
} = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw configurationError("Alfie Core URL is not configured correctly."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw configurationError("Alfie Core must use an HTTP(S) URL without embedded credentials.");
  }
  if (typeof serviceToken !== "string" || Buffer.byteLength(serviceToken, "utf8") < 32) {
    throw configurationError("Alfie Core service authentication is not configured.");
  }
  if (typeof identityAuth?.sign !== "function" || !identityAuth.configured) {
    throw configurationError("A configured signed identity provider is required.");
  }
  if (typeof fetchImpl !== "function") throw configurationError("Fetch is unavailable in this Node runtime.");

  const root = base.toString().replace(/\/$/, "");

  async function request(userId, route, { method = "GET", body, signal, stream = false, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    if (typeof route !== "string" || !route.startsWith("/v1/") || route.length > 2048 || /\s/.test(route)) {
      throw new TypeError("Alfie Core client routes must be versioned /v1 paths.");
    }
    const url = new URL(route, root);
    if (url.origin !== base.origin || !url.pathname.startsWith("/v1/") || url.hash) throw new TypeError("Alfie Core client route escaped its configured API boundary.");
    const requestMethod = String(method).toUpperCase();
    const identity = identityAuth.sign(userId, { method: requestMethod, path: url.pathname + url.search });
    const headers = {
      authorization: "Bearer " + serviceToken,
      ...identity
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(url, {
      method: requestMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
      redirect: "error"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.error || "Alfie Core request failed."), {
        status: response.status,
        code: payload.code,
        revision: payload.revision,
        actionConsumed: payload.actionConsumed === true,
        actionCompleted: payload.actionCompleted === true,
        actionOutcomeUnknown: payload.actionOutcomeUnknown === true,
        retryable: payload.retryable !== false,
        actionId: payload.actionId || null,
        toolId: payload.toolId || null
      });
    }
    if (stream) return response;
    if (response.status === 204) return {};
    return response.json();
  }

  return Object.freeze({
    request,
    status(userId) { return request(userId, "/v1/status"); },
    whoami(userId) { return request(userId, "/v1/whoami"); },
    createIdentityLinkCode(userId) { return request(userId, "/v1/identity/link-codes", { method: "POST", body: {} }); },
    linkIdentity(userId, code) { return request(userId, "/v1/identity/link", { method: "POST", body: { code } }); },
    createStandaloneWorkspace(userId) { return request(userId, "/v1/identity/standalone", { method: "POST", body: {} }); },
    unlinkIdentity(userId) { return request(userId, "/v1/identity/unlink", { method: "POST", body: {} }); },
    chat(userId, body, options = {}) { return request(userId, "/v1/chat", { method: "POST", body, ...options, timeoutMs: options.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS }); },
    runAgent(userId, body, options = {}) { return request(userId, "/v1/agent/run", { method: "POST", body, ...options, timeoutMs: options.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS }); },
    stream(userId, body, options = {}) { return request(userId, "/v1/chat/stream", { method: "POST", body, stream: true, ...options, timeoutMs: options.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS }); },
    conversationsDatabase(userId) { return request(userId, "/v1/conversations/database"); },
    saveConversationsDatabase(userId, database, expectedRevision = null) {
      return request(userId, "/v1/conversations/database", { method: "PUT", body: { database, expectedRevision } });
    },
    listProjects(userId) { return request(userId, "/v1/projects"); },
    createProject(userId, body = {}) { return request(userId, "/v1/projects", { method: "POST", body }); },
    getProject(userId, id) { return request(userId, "/v1/projects/" + encodeURIComponent(id)); },
    updateProject(userId, id, body = {}) { return request(userId, "/v1/projects/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteProject(userId, id) { return request(userId, "/v1/projects/" + encodeURIComponent(id), { method: "DELETE" }); },
    listWorkingModes(userId) { return request(userId, "/v1/modes"); },
    listIdeas(userId, query = "") { return request(userId, "/v1/ideas" + (query ? "?" + query : "")); },
    createIdea(userId, body = {}) { return request(userId, "/v1/ideas", { method: "POST", body }); },
    getIdea(userId, id) { return request(userId, "/v1/ideas/" + encodeURIComponent(id)); },
    updateIdea(userId, id, body = {}) { return request(userId, "/v1/ideas/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteIdea(userId, id) { return request(userId, "/v1/ideas/" + encodeURIComponent(id), { method: "DELETE" }); },
    listWatchers(userId) { return request(userId, "/v1/watchers"); },
    createWatcher(userId, body = {}) { return request(userId, "/v1/watchers", { method: "POST", body }); },
    updateWatcher(userId, id, body = {}) { return request(userId, "/v1/watchers/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteWatcher(userId, id) { return request(userId, "/v1/watchers/" + encodeURIComponent(id), { method: "DELETE" }); },
    checkWatcher(userId, id) { return request(userId, "/v1/watchers/" + encodeURIComponent(id) + "/check", { method: "POST", body: {} }); },
    ingestWatcherMetric(userId, id, body = {}) { return request(userId, "/v1/watchers/" + encodeURIComponent(id) + "/ingest", { method: "POST", body }); },
    listWatcherEvents(userId, query = "") { return request(userId, "/v1/watchers/events" + (query ? "?" + query : "")); },
    acknowledgeWatcherEvent(userId, id) { return request(userId, "/v1/watchers/events/" + encodeURIComponent(id) + "/ack", { method: "POST", body: {} }); },
    getWorkflowProfile(userId) { return request(userId, "/v1/profile"); },
    updateWorkflowProfile(userId, body = {}) { return request(userId, "/v1/profile", { method: "PUT", body }); },
    addLearningTopic(userId, body = {}) { return request(userId, "/v1/profile/topics", { method: "POST", body }); },
    updateLearningTopic(userId, id, body = {}) { return request(userId, "/v1/profile/topics/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteLearningTopic(userId, id) { return request(userId, "/v1/profile/topics/" + encodeURIComponent(id), { method: "DELETE" }); },
    updateFeedbackPreference(userId, traitKey, body = {}) { return request(userId, "/v1/profile/feedback/" + encodeURIComponent(traitKey), { method: "PATCH", body }); },
    deleteFeedbackPreference(userId, traitKey) { return request(userId, "/v1/profile/feedback/" + encodeURIComponent(traitKey), { method: "DELETE" }); },
    deleteFeedbackSignal(userId, signalId) { return request(userId, "/v1/profile/feedback/signals/" + encodeURIComponent(signalId), { method: "DELETE" }); },
    listCapsules(userId) { return request(userId, "/v1/capsules"); },
    createCapsule(userId, body = {}) { return request(userId, "/v1/capsules", { method: "POST", body }); },
    updateCapsule(userId, id, body = {}) { return request(userId, "/v1/capsules/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteCapsule(userId, id) { return request(userId, "/v1/capsules/" + encodeURIComponent(id), { method: "DELETE" }); },
    activateCapsule(userId, id) { return request(userId, "/v1/capsules/" + encodeURIComponent(id) + "/activate", { method: "POST", body: {} }); },
    getKnowledgeGraph(userId, query = "") { return request(userId, "/v1/graph" + (query ? "?" + query : "")); },
    getVramStatus(userId) { return request(userId, "/v1/system/vram"); },
    reportVramStatus(userId, body = {}) { return request(userId, "/v1/system/vram/report", { method: "POST", body }); },
    async reportExternalVram(body = {}) {
      const url = new URL("/v1/system/vram/host-report", root);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + serviceToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(payload.error || "External VRAM report failed."), {
          status: response.status,
          code: payload.code
        });
      }
      return payload;
    },
    listConversations(userId, query = "") { return request(userId, "/v1/conversations" + (query ? "?" + query : "")); },
    createConversation(userId, body = {}) { return request(userId, "/v1/conversations", { method: "POST", body }); },
    getConversation(userId, id) { return request(userId, "/v1/conversations/" + encodeURIComponent(id)); },
    handoffConversation(userId, id, body = {}) { return request(userId, "/v1/conversations/" + encodeURIComponent(id) + "/handoff", { method: "POST", body }); },
    appendMessage(userId, id, body) { return request(userId, "/v1/conversations/" + encodeURIComponent(id) + "/messages", { method: "POST", body }); },
    reactMessage(userId, conversationId, messageId, reaction) {
      return request(userId, "/v1/conversations/" + encodeURIComponent(conversationId) + "/messages/" + encodeURIComponent(messageId) + "/reaction", { method: "POST", body: { reaction } });
    },
    renameConversation(userId, id, title) { return request(userId, "/v1/conversations/" + encodeURIComponent(id), { method: "PATCH", body: { title } }); },
    updateConversation(userId, id, body = {}) { return request(userId, "/v1/conversations/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteConversation(userId, id) { return request(userId, "/v1/conversations/" + encodeURIComponent(id), { method: "DELETE" }); },
    listMemories(userId, query = "") { return request(userId, "/v1/memories" + (query ? "?" + query : "")); },
    createMemory(userId, body) { return request(userId, "/v1/memories", { method: "POST", body }); },
    getMemory(userId, id) { return request(userId, "/v1/memories/" + encodeURIComponent(id)); },
    updateMemory(userId, id, body) { return request(userId, "/v1/memories/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteMemory(userId, id) { return request(userId, "/v1/memories/" + encodeURIComponent(id), { method: "DELETE" }); },
    listTools(userId) { return request(userId, "/v1/tools"); },
    listPermissions(userId) { return request(userId, "/v1/permissions"); },
    listPendingActions(userId) { return request(userId, "/v1/tools/pending"); },
    listActionReceipts(userId, limit = 25) { return request(userId, "/v1/tools/receipts?limit=" + encodeURIComponent(limit)); },
    approveAction(userId, actionId, options = {}) {
      return request(userId, "/v1/tools/approve", { method: "POST", body: { actionId }, ...options, timeoutMs: options.timeoutMs ?? APPROVAL_REQUEST_TIMEOUT_MS });
    },
    rejectAction(userId, actionId) { return request(userId, "/v1/tools/reject", { method: "POST", body: { actionId } }); },
    listAudit(userId, limit = 50) { return request(userId, "/v1/audit?limit=" + encodeURIComponent(limit)); },
    getStorageStatus(userId) { return request(userId, "/v1/storage/status"); },
    migrateStorage(userId) { return request(userId, "/v1/storage/migrate", { method: "POST", body: {} }); },
    searchWorkspace(userId, query = "") { return request(userId, "/v1/search" + (query ? "?" + query : "")); },
    getIntegrationsStatus(userId) { return request(userId, "/v1/integrations/status"); },
    listJobs(userId, query = "") { return request(userId, "/v1/jobs" + (query ? "?" + query : "")); },
    getJob(userId, jobId) { return request(userId, "/v1/jobs/" + encodeURIComponent(jobId)); },
    createJob(userId, body = {}) { return request(userId, "/v1/jobs", { method: "POST", body }); },
    createChatTask(userId, body = {}) { return request(userId, "/v1/chat/tasks", { method: "POST", body }); },
    cancelJob(userId, jobId, body = {}) { return request(userId, "/v1/jobs/" + encodeURIComponent(jobId) + "/cancel", { method: "POST", body }); },
    listWorkshopRoles(userId) { return request(userId, "/v1/workshop/roles"); },
    delegateWorkshopTask(userId, body = {}) { return request(userId, "/v1/workshop/delegate", { method: "POST", body }); },
    previewPrivacyAirlock(userId, body = {}) { return request(userId, "/v1/privacy/airlock/preview", { method: "POST", body }); },
    getVoiceStatus(userId) { return request(userId, "/v1/voice/status"); },
    transcribeVoice(userId, body = {}) { return request(userId, "/v1/voice/transcribe", { method: "POST", body }); },
    synthesizeVoice(userId, body = {}) { return request(userId, "/v1/voice/synthesize", { method: "POST", body }); },
    getReflections(userId, query = "") { return request(userId, "/v1/reflections" + (query ? "?" + query : "")); },
    saveReflectionSnapshot(userId, body = {}) { return request(userId, "/v1/reflections/snapshot", { method: "POST", body }); },
    getAmbientState(userId) { return request(userId, "/v1/ambient/state"); },
    pushAmbientBridge(userId) { return request(userId, "/v1/ambient/push", { method: "POST", body: {} }); },
    exportVault(userId, body = {}) { return request(userId, "/v1/vault/export", { method: "POST", body }); },
    verifyVault(userId, body = {}) { return request(userId, "/v1/vault/verify", { method: "POST", body }); },
    restoreVault(userId, body = {}) { return request(userId, "/v1/vault/restore", { method: "POST", body }); },
    getDiagnosticsAudit(userId) { return request(userId, "/v1/diagnostics/audit"); },
    remediateDiagnostics(userId, body = {}) { return request(userId, "/v1/diagnostics/remediate", { method: "POST", body }); },
    listPeerTokens(userId) { return request(userId, "/v1/clients/tokens"); },
    createPeerToken(userId, body = {}) { return request(userId, "/v1/clients/tokens", { method: "POST", body }); },
    revokePeerToken(userId, id) { return request(userId, "/v1/clients/tokens/" + encodeURIComponent(id), { method: "DELETE" }); },
    listPlaybooks(userId) { return request(userId, "/v1/playbooks"); },
    createPlaybook(userId, body = {}) { return request(userId, "/v1/playbooks", { method: "POST", body }); },
    updatePlaybook(userId, id, body = {}) { return request(userId, "/v1/playbooks/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deletePlaybook(userId, id) { return request(userId, "/v1/playbooks/" + encodeURIComponent(id), { method: "DELETE" }); },
    runPlaybook(userId, id, body = {}) { return request(userId, "/v1/playbooks/" + encodeURIComponent(id) + "/run", { method: "POST", body }); },
    getTimeline(userId, query = "") { return request(userId, "/v1/timeline" + (query ? "?" + query : "")); },
    exportMarkdownDigest(userId, query = "") { return request(userId, "/v1/export/markdown" + (query ? "?" + query : "")); },
    async callPeerEndpoint(peerToken, pathname, { method = "GET", body, query = "" } = {}) {
      const target = new URL(pathname + (query ? "?" + query : ""), root);
      const headers = {
        authorization: "Bearer " + serviceToken,
        "x-alfie-peer-token": String(peerToken || ""),
        accept: "application/json"
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetchImpl(target, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(payload?.error || "Peer request failed."), { status: response.status, code: payload?.code });
      }
      return payload;
    },
    getProviders(userId) { return request(userId, "/v1/providers"); },
    getProvidersHealth(userId, { refresh = false } = {}) {
      return request(userId, "/v1/providers/health" + (refresh ? "?refresh=1" : ""));
    },
    updateProviderSettings(userId, body = {}) {
      return request(userId, "/v1/providers/settings", { method: "PUT", body });
    },
    addProviderEndpoint(userId, body = {}) {
      return request(userId, "/v1/providers/endpoints", { method: "POST", body });
    },
    updateProviderEndpoint(userId, id, body = {}) {
      return request(userId, "/v1/providers/endpoints/" + encodeURIComponent(id), { method: "PATCH", body });
    },
    removeProviderEndpoint(userId, id) {
      return request(userId, "/v1/providers/endpoints/" + encodeURIComponent(id), { method: "DELETE" });
    },
    testProviderEndpoint(userId, body = {}) {
      return request(userId, "/v1/providers/test", { method: "POST", body });
    },
    listCloudAgents(userId) { return request(userId, "/v1/cloud-agents"); },
    updateCloudAgent(userId, provider, body = {}) {
      return request(userId, "/v1/cloud-agents/" + encodeURIComponent(provider), { method: "PATCH", body });
    },
    previewCloudAgentPrivacy(userId, provider, body = {}) {
      return request(userId, "/v1/cloud-agents/" + encodeURIComponent(provider) + "/privacy-preview", { method: "POST", body });
    },
    setCloudAgentCredential(userId, provider, body = {}) {
      return request(userId, "/v1/cloud-agents/" + encodeURIComponent(provider) + "/credential", { method: "PUT", body });
    },
    clearCloudAgentCredential(userId, provider) {
      return request(userId, "/v1/cloud-agents/" + encodeURIComponent(provider) + "/credential", { method: "DELETE" });
    },
    generateImage(userId, body) { return request(userId, "/v1/images/generate", { method: "POST", body }); },
    async getImage(filename) {
      const url = new URL("/v1/images/" + encodeURIComponent(filename), root);
      const headers = { authorization: "Bearer " + serviceToken };
      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) {
        throw Object.assign(new Error("Visual asset not found."), { status: response.status });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get("content-type") || "application/octet-stream";
      return { buffer, mimeType };
    }
  });
}
