const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  csrfToken: "",
  linked: false,
  activeConversationId: null,
  messages: [],
  view: "chat",
  sending: false
};

async function api(route, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  const response = await fetch(route, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    method,
    headers
  });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("Alfie returned an unreadable response."); }
  if (!response.ok) {
    const error = new Error(payload.error || "The request could not be completed.");
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => el.classList.remove("visible"), 3200);
}

function setConnection(online, label) {
  $("#connection-dot").classList.toggle("online", Boolean(online));
  $("#connection-label").textContent = label;
}

function showLogin() {
  $("#login-screen").hidden = false;
  $("#app-shell").hidden = true;
}

function showApp() {
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
  $("#user-name").textContent = state.user?.displayName || state.user?.username || "Account";
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => { section.hidden = section.id !== "view-" + view; });
  const titles = { chat: "Chat", garden: "The Garden", tools: "Tools & access", settings: "Settings" };
  $("#view-title").textContent = titles[view] || "Alfie";
  if (view === "garden") loadMemories();
  if (view === "tools") loadToolsAndApprovals();
  if (view === "settings") loadSettings();
}

function showLinkRequired() {
  $("#link-required").hidden = false;
  document.querySelectorAll(".view").forEach((section) => { section.hidden = true; });
  $("#view-title").textContent = "Connect account";
  setConnection(false, "Account not linked");
}

function showWorkspace() {
  $("#link-required").hidden = true;
  setView(state.view || "chat");
  setConnection(true, "Connected");
}

async function refreshIdentity() {
  const who = await api("/api/core/whoami");
  state.linked = Boolean(who.linked);
  if (state.linked) showWorkspace();
  else showLinkRequired();
  return who;
}

async function initialise() {
  try {
    const session = await api("/api/auth/me");
    if (session.setupRequired) {
      showLogin();
      $("#setup-message").hidden = false;
      $("#login-error").textContent = "Create the first account by setting the bootstrap username and password in the server environment.";
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    state.user = session.user;
    state.csrfToken = session.csrfToken;
    showApp();
    try {
      await refreshIdentity();
      if (state.linked) await loadConversations();
    } catch (error) {
      setConnection(false, "Core unavailable");
      toast(error.message);
    }
  } catch (error) {
    showLogin();
    $("#login-error").textContent = error.message;
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
    });
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    showApp();
    await refreshIdentity();
    if (state.linked) await loadConversations();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
  catch (error) { toast(error.message); }
  state.user = null;
  state.csrfToken = "";
  state.linked = false;
  state.activeConversationId = null;
  state.messages = [];
  showLogin();
}

$("#logout-button").addEventListener("click", logout);
$("#mobile-logout").addEventListener("click", logout);
$("#mobile-new-chat").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
$("#mobile-history-button").addEventListener("click", () => {
  $("#mobile-history-sheet").hidden = !$("#mobile-history-sheet").hidden;
});
$("#mobile-history-close").addEventListener("click", () => { $("#mobile-history-sheet").hidden = true; });

$("#link-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#link-error").textContent = "";
  try {
    await api("/api/auth/link", { method: "POST", body: JSON.stringify({ code: String(form.get("code") || "").trim().toUpperCase() }) });
    state.linked = true;
    event.currentTarget.reset();
    toast("Your standalone interface is now linked to Petrio.");
    await refreshIdentity();
    await loadConversations();
  } catch (error) {
    $("#link-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

function renderConversationList(host, conversations = []) {
  if (!host) return;
  host.replaceChildren();
  for (const item of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item" + (item.id === state.activeConversationId ? " active" : "");
    button.textContent = item.title || "New conversation";
    button.addEventListener("click", () => {
      $("#mobile-history-sheet").hidden = true;
      loadConversation(item.id).catch((error) => toast(error.message));
    });
    host.appendChild(button);
  }
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Your conversations will appear here.";
    host.appendChild(empty);
  }
}

function renderConversations(conversations = []) {
  renderConversationList($("#conversation-list"), conversations);
  renderConversationList($("#mobile-conversation-list"), conversations);
}

async function loadConversations() {
  const payload = await api("/api/core/conversations");
  const conversations = payload.conversations || [];
  renderConversations(conversations);
  if (!state.activeConversationId && conversations.length) await loadConversation(conversations[0].id);
}

async function loadConversation(id) {
  const payload = await api("/api/core/conversations/" + encodeURIComponent(id));
  state.activeConversationId = id;
  state.messages = payload.conversation?.messages || [];
  renderMessages();
  const list = await api("/api/core/conversations");
  renderConversations(list.conversations || []);
}

async function newConversation() {
  $("#mobile-history-sheet").hidden = true;
  const payload = await api("/api/core/conversations", { method: "POST", body: JSON.stringify({ title: "New conversation" }) });
  state.activeConversationId = payload.conversation.id;
  state.messages = [];
  renderMessages();
  await loadConversations();
  setView("chat");
}

$("#new-chat").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
$("#refresh-conversations").addEventListener("click", () => loadConversations().catch((error) => toast(error.message)));

function appendInlineMarkdown(parent, source) {
  const text = String(source || "");
  const pattern = /\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    if (token.startsWith("**")) { const node = document.createElement("strong"); node.textContent = token.slice(2, -2); parent.appendChild(node); }
    else if (token.startsWith("`")) { const node = document.createElement("code"); node.textContent = token.slice(1, -1); parent.appendChild(node); }
    else if (token.startsWith("*")) { const node = document.createElement("em"); node.textContent = token.slice(1, -1); parent.appendChild(node); }
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (link) { const node = document.createElement("a"); node.textContent = link[1]; node.href = link[2]; node.target = "_blank"; node.rel = "noopener noreferrer nofollow"; parent.appendChild(node); }
      else parent.appendChild(document.createTextNode(token));
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = []; let list = null; let listType = ""; let codeLines = null;
  const flushParagraph = () => { if (!paragraph.length) return; const node = document.createElement("p"); appendInlineMarkdown(node, paragraph.join("\n")); container.appendChild(node); paragraph = []; };
  const flushList = () => { if (list) container.appendChild(list); list = null; listType = ""; };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph(); flushList();
      if (codeLines) { const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = codeLines.join("\n"); pre.appendChild(code); container.appendChild(pre); codeLines = null; }
      else codeLines = [];
      continue;
    }
    if (codeLines) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const node = document.createElement("h" + heading[1].length); appendInlineMarkdown(node, heading[2]); container.appendChild(node); continue; }
    const item = /^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/.exec(line);
    if (item) { flushParagraph(); const type = /^\s*\d+\.\s+/.test(line) ? "ol" : "ul"; if (list && listType !== type) flushList(); if (!list) { list = document.createElement(type); listType = type; } const li = document.createElement("li"); appendInlineMarkdown(li, item[1]); list.appendChild(li); continue; }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList();
  if (codeLines) { const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = codeLines.join("\n"); pre.appendChild(code); container.appendChild(pre); }
}
function appendMessageElement(message) {
  const article = document.createElement("article");
  article.className = "message " + (message.role === "user" ? "user" : "assistant");
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "YOU" : "ALFIE";
  const body = document.createElement("div");
  body.className = "message-body";
  renderMarkdown(body, message.content || "");
  article.append(label, body);
  $("#messages").appendChild(article);
  return body;
}

function renderMessages() {
  const host = $("#messages");
  host.replaceChildren();
  if (!state.messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    welcome.innerHTML = '<div class="welcome-mark">A</div><h2>What shall we work on?</h2><p>I’m here when you need me. No rush.</p><div class="suggestion-grid"><button type="button" data-prompt="Give me a concise overview of my current priorities.">A quick overview <span>↗</span></button><button type="button" data-prompt="Help me think through an idea I’m developing.">Think through an idea <span>↗</span></button><button type="button" data-prompt="Summarise the recent activity and pending actions available to you.">Review recent activity <span>↗</span></button></div>';
    host.appendChild(welcome);
    welcome.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
    return;
  }
  for (const message of state.messages) appendMessageElement(message);
  host.scrollTop = host.scrollHeight;
}

async function persistMessage(role, content) {
  const payload = await api("/api/core/conversations/" + encodeURIComponent(state.activeConversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({ role, content })
  });
  state.messages.push(payload.message || { role, content });
  return payload.message;
}

async function sendMessage(rawText) {
  const content = String(rawText || "").trim();
  if (!content || state.sending || !state.linked) return;
  state.sending = true;
  const form = $("#chat-form");
  const input = form.elements.message;
  input.disabled = true;
  let assistantBody = null;
  try {
    if (!state.activeConversationId) await newConversation();
    await persistMessage("user", content);
    renderMessages();
    assistantBody = appendMessageElement({ role: "assistant", content: "Thinking…" });
    const response = await fetch("/api/core/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrfToken },
      body: JSON.stringify({ messages: state.messages.slice(-16).map(({ role, content: text }) => ({ role, content: text })) })
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || "Alfie could not complete the response.");
    }
    let buffer = "";
    let assistantText = "";
    let finalEvent = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "delta") {
          assistantText += event.content || "";
          renderMarkdown(assistantBody, assistantText);
          $("#messages").scrollTop = $("#messages").scrollHeight;
        }
        if (event.type === "done") finalEvent = event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer);
      if (event.type === "delta") assistantText += event.content || "";
      if (event.type === "done") finalEvent = event;
    }
    if (!assistantText && finalEvent?.message) assistantText = finalEvent.message;
    if (finalEvent?.status === "awaiting_user_approval") {
      assistantText = assistantText || "This action is ready for your approval. Open Tools & access to review it.";
    }
    renderMarkdown(assistantBody, assistantText || "I couldn't produce a response.");
    await persistMessage("assistant", assistantBody.textContent);
    await loadConversations();
    if (finalEvent?.status === "awaiting_user_approval") {
      toast("Alfie is waiting for your approval.");
      await loadToolsAndApprovals();
    }
  } catch (error) {
    if (assistantBody) renderMarkdown(assistantBody, "I couldn't complete that response. " + error.message);
    toast(error.message);
  } finally {
    state.sending = false;
    input.disabled = false;
    input.value = "";
    input.focus();
  }
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(event.currentTarget.elements.message.value);
});

const composerInput = $("#chat-form").elements.message;
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + "px";
});

function createItem(title, detail, actions = []) {
  const row = document.createElement("article");
  row.className = "list-item";
  const info = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = detail || "";
  info.append(heading, description);
  row.appendChild(info);
  if (actions.length) {
    const controls = document.createElement("div");
    controls.className = "item-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.className = action.kind || "secondary-button";
      button.addEventListener("click", action.onClick);
      controls.appendChild(button);
    }
    row.appendChild(controls);
  }
  return row;
}

async function loadMemories() {
  const host = $("#memory-list");
  host.replaceChildren();
  const query = $("#memory-search").value.trim();
  try {
    const payload = await api("/api/core/memories" + (query ? "?q=" + encodeURIComponent(query) : ""));
    for (const memory of (payload.memories || [])) {
      const meta = [memory.origin, "importance " + memory.importance, ...(memory.tags || [])].join(" · ");
      const edit = {
        label: "Edit",
        onClick: async () => {
          const text = prompt("Update this memory", memory.text || "");
          if (text === null || !text.trim()) return;
          try { await api("/api/core/memories/" + encodeURIComponent(memory.id), { method: "PATCH", body: JSON.stringify({ text }) }); await loadMemories(); }
          catch (error) { toast(error.message); }
        }
      };
      const forget = {
        label: "Forget",
        onClick: async () => {
          if (!confirm("Forget this Garden entry?")) return;
          try { await api("/api/core/memories/" + encodeURIComponent(memory.id), { method: "DELETE", body: "{}" }); await loadMemories(); }
          catch (error) { toast(error.message); }
        }
      };
      host.appendChild(createItem(memory.title || memory.text, meta, [edit, forget]));
    }
    if (!payload.memories?.length) host.textContent = "No matching memories yet.";
  } catch (error) { host.textContent = error.message; }
}

$("#refresh-memories").addEventListener("click", loadMemories);
$("#memory-search").addEventListener("input", () => {
  clearTimeout(loadMemories.timer);
  loadMemories.timer = setTimeout(loadMemories, 250);
});
$("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = event.currentTarget.elements.text.value.trim();
  if (!text) return;
  try {
    await api("/api/core/memories", { method: "POST", body: JSON.stringify({ text, origin: "user-seeded", source: "user", type: "note" }) });
    event.currentTarget.reset();
    await loadMemories();
    toast("Memory planted in the Garden.");
  } catch (error) { toast(error.message); }
});

async function loadToolsAndApprovals() {
  const toolsHost = $("#tool-list");
  const pendingHost = $("#pending-list");
  const auditHost = $("#audit-list");
  toolsHost.replaceChildren();
  pendingHost.replaceChildren();
  auditHost.replaceChildren();
  try {
    const [tools, permissions, pending, audit] = await Promise.all([
      api("/api/core/tools"), api("/api/core/permissions"), api("/api/core/tools/pending"), api("/api/core/audit?limit=30")
    ]);
    const scopes = new Set(permissions.scopes || []);
    const groups = new Map();
    for (const tool of (tools.tools || [])) {
      if (!groups.has(tool.scope)) groups.set(tool.scope, []);
      groups.get(tool.scope).push(tool);
    }
    for (const [scope, scopedTools] of groups) {
      const allowed = scopes.has(scope);
      const names = scopedTools.map((tool) => tool.name || tool.id).join(", ");
      const button = {
        label: allowed ? "Revoke" : "Allow",
        kind: allowed ? "secondary-button" : "primary-button",
        onClick: async () => {
          try {
            await api("/api/core/permissions", { method: allowed ? "DELETE" : "POST", body: JSON.stringify({ scope }) });
            await loadToolsAndApprovals();
          } catch (error) { toast(error.message); }
        }
      };
      toolsHost.appendChild(createItem(scope, (allowed ? "Granted" : "Not granted") + " · " + scopedTools.length + " tool(s): " + names, [button]));
    }
    if (!tools.tools?.length) toolsHost.textContent = "No registered tools.";
    for (const action of (pending.actions || [])) {
      const approve = {
        label: "Approve",
        kind: "primary-button",
        onClick: async () => {
          try { await api("/api/core/tools/approve", { method: "POST", body: JSON.stringify({ actionId: action.id }) }); toast("Action approved."); await loadToolsAndApprovals(); }
          catch (error) { toast(error.message); }
        }
      };
      const reject = {
        label: "Reject",
        onClick: async () => {
          try { await api("/api/core/tools/reject", { method: "POST", body: JSON.stringify({ actionId: action.id }) }); toast("Action rejected."); await loadToolsAndApprovals(); }
          catch (error) { toast(error.message); }
        }
      };
      pendingHost.appendChild(createItem(action.toolId, action.preview || action.reason || "Waiting for your decision.", [reject, approve]));
    }
    if (!pending.actions?.length) pendingHost.textContent = "Nothing is waiting for approval.";
    for (const event of (audit.events || [])) {
      auditHost.appendChild(createItem(event.event, [event.toolId, event.status, event.at ? new Date(event.at).toLocaleString() : ""].filter(Boolean).join(" · ")));
    }
    if (!audit.events?.length) auditHost.textContent = "No recent actions.";
  } catch (error) {
    toolsHost.textContent = error.message;
    pendingHost.textContent = "Approval history unavailable.";
    auditHost.textContent = "Activity history unavailable.";
  }
}

async function loadSettings() {
  const account = $("#account-status");
  const providers = $("#provider-status");
  const core = $("#core-status");
  account.textContent = "Checking…";
  providers.replaceChildren();
  core.replaceChildren();
  try {
    const [who, status, providerList, health] = await Promise.all([
      api("/api/core/whoami"), api("/api/core/status"), api("/api/core/providers"), api("/api/core/providers/health")
    ]);
    account.textContent = who.linked ? "Linked to your Petrio account · " + who.userId : "Not linked";
    for (const endpoint of (health.endpoints || [])) {
      providers.appendChild(createItem(endpoint.id, (endpoint.online ? "Online" : "Offline") + " · " + (endpoint.model || "No model configured")));
    }
    if (!health.endpoints?.length) providers.textContent = "No model endpoints configured.";
    core.textContent = (status.implemented || []).length + " capabilities active · " + (status.planned || []).length + " planned";
  } catch (error) {
    account.textContent = error.message;
    providers.textContent = "Provider information unavailable.";
    core.textContent = "Core status unavailable.";
  }
}

initialise();
