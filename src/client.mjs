function configurationError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

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

  async function request(userId, route, { method = "GET", body, signal, stream = false } = {}) {
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
    const timeout = AbortSignal.timeout(timeoutMs);
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
        revision: payload.revision
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
    unlinkIdentity(userId) { return request(userId, "/v1/identity/unlink", { method: "POST", body: {} }); },
    chat(userId, body, options = {}) { return request(userId, "/v1/chat", { method: "POST", body, ...options }); },
    runAgent(userId, body, options = {}) { return request(userId, "/v1/agent/run", { method: "POST", body, ...options }); },
    stream(userId, body, options = {}) { return request(userId, "/v1/chat/stream", { method: "POST", body, stream: true, ...options }); },
    conversationsDatabase(userId) { return request(userId, "/v1/conversations/database"); },
    saveConversationsDatabase(userId, database, expectedRevision = null) {
      return request(userId, "/v1/conversations/database", { method: "PUT", body: { database, expectedRevision } });
    },
    listConversations(userId) { return request(userId, "/v1/conversations"); },
    createConversation(userId, body = {}) { return request(userId, "/v1/conversations", { method: "POST", body }); },
    getConversation(userId, id) { return request(userId, "/v1/conversations/" + encodeURIComponent(id)); },
    appendMessage(userId, id, body) { return request(userId, "/v1/conversations/" + encodeURIComponent(id) + "/messages", { method: "POST", body }); },
    deleteConversation(userId, id) { return request(userId, "/v1/conversations/" + encodeURIComponent(id), { method: "DELETE" }); },
    listMemories(userId, query = "") { return request(userId, "/v1/memories" + (query ? "?" + query : "")); },
    createMemory(userId, body) { return request(userId, "/v1/memories", { method: "POST", body }); },
    getMemory(userId, id) { return request(userId, "/v1/memories/" + encodeURIComponent(id)); },
    updateMemory(userId, id, body) { return request(userId, "/v1/memories/" + encodeURIComponent(id), { method: "PATCH", body }); },
    deleteMemory(userId, id) { return request(userId, "/v1/memories/" + encodeURIComponent(id), { method: "DELETE" }); },
    listTools(userId) { return request(userId, "/v1/tools"); },
    listPermissions(userId) { return request(userId, "/v1/permissions"); },
    listPendingActions(userId) { return request(userId, "/v1/tools/pending"); },
    approveAction(userId, actionId) { return request(userId, "/v1/tools/approve", { method: "POST", body: { actionId } }); },
    rejectAction(userId, actionId) { return request(userId, "/v1/tools/reject", { method: "POST", body: { actionId } }); },
    listAudit(userId, limit = 50) { return request(userId, "/v1/audit?limit=" + encodeURIComponent(limit)); }
  });
}
