import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeUserKey, userDataFile, UserMutex, readUserJsonDocument, writeUserJsonDocument } from "../storage/userJsonStore.mjs";

const CONVERSATION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 50000;

function cleanActionCard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const safeCard = {
    state: ["success", "read", "cancelled", "rejected", "error", "approval", "failed"].includes(raw.state) ? raw.state : "error",
    label: String(raw.label || "Alfie Action").slice(0, 120),
    detail: String(raw.detail || (["confirm", "working"].includes(raw.state) ? "This temporary action state expired when the conversation was restored." : "")).slice(0, 1000)
  };
  for (const key of ["actionId", "toolId", "risk", "target", "reason", "summary"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      safeCard[key] = raw[key].slice(0, key === "reason" || key === "summary" ? 400 : 160);
    }
  }
  if (raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)) {
    try {
      const serialised = JSON.stringify(raw.arguments);
      if (serialised.length <= 12000) safeCard.arguments = JSON.parse(serialised);
    } catch {}
  }
  return safeCard;
}

function cleanProvenance(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const workingMode = raw.workingMode && typeof raw.workingMode === "object"
    ? {
        id: String(raw.workingMode.id || "companion").slice(0, 40),
        label: String(raw.workingMode.label || "Companion").slice(0, 60)
      }
    : undefined;
  const project = raw.project && typeof raw.project === "object" && raw.project.name
    ? {
        id: CONVERSATION_ID_PATTERN.test(String(raw.project.id || "")) ? String(raw.project.id) : null,
        name: String(raw.project.name).slice(0, 80),
        status: String(raw.project.status || "active").slice(0, 32)
      }
    : null;
  const memoriesInjected = Array.isArray(raw.memoriesInjected)
    ? raw.memoriesInjected.slice(0, 8).map((m) => ({
        id: String(m?.id || "").slice(0, 64),
        title: String(m?.title || "Memory").slice(0, 120),
        kind: String(m?.kind || "note").slice(0, 40),
        trust: String(m?.trust || "user_authored").slice(0, 40),
        importance: Math.max(1, Math.min(10, Number(m?.importance) || 5))
      }))
    : [];
  const autoMemories = Array.isArray(raw.autoMemories)
    ? raw.autoMemories.slice(0, 4).map((m) => ({
        id: String(m?.id || "").slice(0, 64),
        title: String(m?.title || "Memory").slice(0, 120),
        text: String(m?.text || "").slice(0, 320),
        kind: String(m?.kind || "fact").slice(0, 40)
      })).filter((m) => m.id || m.title)
    : [];
  const toolsShortlisted = Array.isArray(raw.toolsShortlisted)
    ? raw.toolsShortlisted.slice(0, 12).map((t) => String(t).slice(0, 80))
    : [];
  const toolsUsed = Array.isArray(raw.toolsUsed)
    ? raw.toolsUsed.slice(0, 12).map((t) => String(t).slice(0, 80))
    : [];
  const blockedCategories = Array.isArray(raw.blockedCategories)
    ? raw.blockedCategories.slice(0, 10).map((c) => String(c).slice(0, 60))
    : [];
  return {
    ...(workingMode ? { workingMode } : {}),
    project,
    memoriesInjected,
    ...(autoMemories.length ? { autoMemories } : {}),
    toolsShortlisted,
    toolsUsed,
    tainted: Boolean(raw.tainted),
    privacyFiltered: Boolean(raw.privacyFiltered),
    blockedCategories,
    steps: Number.isFinite(Number(raw.steps)) ? Math.max(0, Math.min(20, Math.round(Number(raw.steps)))) : 1
  };
}

export class ConversationStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.mutex = new UserMutex();
  }

  fileFor(userId) {
    return userDataFile(this.dataDirectory, userId, "conversations.json");
  }

  async exclusive(userId, operation) {
    return this.mutex.run(safeUserKey(userId), operation);
  }

  async load(userId) {
    const store = await readUserJsonDocument(this.dataDirectory, userId, "conversations.json");
    if (!store) return { schemaVersion: 1, revision: 0, ownerId: userId, activeConversationId: null, conversations: [] };
    if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.conversations)) {
      throw new Error("Conversation store failed its integrity check.");
    }
    return store;
  }

  async save(userId, store) {
    store.revision = Math.max(0, Number(store.revision) || 0) + 1;
    await writeUserJsonDocument(this.dataDirectory, userId, "conversations.json", store, { uuid: this.uuid });
  }

  cleanDatabase(userId, source = {}) {
    const input = source && typeof source === "object" ? source : {};
    const rawConversations = Array.isArray(input.conversations) ? input.conversations.slice(0, MAX_CONVERSATIONS) : [];
    const conversations = [];
    const seen = new Set();
    const idMap = new Map();
    for (const raw of rawConversations) {
      if (!raw || typeof raw !== "object") continue;
      const legacyId = String(raw.id || "");
      const id = CONVERSATION_ID_PATTERN.test(legacyId) ? legacyId : this.uuid();
      if (seen.has(legacyId) || seen.has(id)) continue;
      seen.add(legacyId);
      seen.add(id);
      if (legacyId) idMap.set(legacyId, id);
      const messages = [];
      for (const rawMessage of (Array.isArray(raw.messages) ? raw.messages.slice(-500) : [])) {
        if (!rawMessage || typeof rawMessage !== "object") continue;
        const role = rawMessage.role === "assistant" ? "assistant" : rawMessage.role === "user" ? "user" : "";
        const content = String(rawMessage.content || "").slice(0, 50000);
        if (!role || !content.trim() || rawMessage.transient === true) continue;
        const message = {
          id: CONVERSATION_ID_PATTERN.test(String(rawMessage.id || "")) ? String(rawMessage.id) : this.uuid(),
          role,
          content,
          createdAt: String(rawMessage.createdAt || this.now()).slice(0, 40),
          meta: String(rawMessage.meta || "").slice(0, 1000)
        };
        if (role === "assistant" && rawMessage.actionCard && typeof rawMessage.actionCard === "object") {
          const safeCard = cleanActionCard(rawMessage.actionCard);
          if (safeCard) message.actionCard = safeCard;
        }
        if (rawMessage.metrics && typeof rawMessage.metrics === "object" && !Array.isArray(rawMessage.metrics)) {
          message.metrics = rawMessage.metrics;
        }
        if (role === "assistant" && rawMessage.provenance) {
          const safeProv = cleanProvenance(rawMessage.provenance);
          if (safeProv) message.provenance = safeProv;
        }
        if (rawMessage.reaction && ["like", "flag"].includes(String(rawMessage.reaction))) {
          message.reaction = String(rawMessage.reaction);
          if (rawMessage.reactedAt) message.reactedAt = String(rawMessage.reactedAt).slice(0, 40);
        }
        messages.push(message);
      }
      const projectId = CONVERSATION_ID_PATTERN.test(String(raw.projectId || "")) ? String(raw.projectId) : null;
      const parentConversationId = CONVERSATION_ID_PATTERN.test(String(raw.parentConversationId || "")) ? String(raw.parentConversationId) : null;
      const continuedFromTitle = typeof raw.continuedFromTitle === "string" && raw.continuedFromTitle.trim()
        ? raw.continuedFromTitle.trim().slice(0, 120)
        : null;
      const handoffContext = typeof raw.handoffContext === "string" && raw.handoffContext.trim()
        ? raw.handoffContext.trim().slice(0, 12000)
        : null;
      conversations.push({
        id,
        title: String(raw.title || "New conversation").slice(0, 160),
        projectId,
        parentConversationId,
        continuedFromTitle,
        handoffContext,
        createdAt: String(raw.createdAt || this.now()).slice(0, 40),
        updatedAt: String(raw.updatedAt || this.now()).slice(0, 40),
        messages
      });
    }
    const activeConversationId = idMap.get(String(input.activeConversationId || ""))
      || (conversations.some((item) => item.id === input.activeConversationId) ? input.activeConversationId : null)
      || conversations[0]?.id || null;
    return { schemaVersion: 1, ownerId: userId, activeConversationId, conversations };
  }

  async database(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return {
        revision: Number(store.revision) || 0,
        activeConversationId: store.activeConversationId || store.conversations[0]?.id || null,
        legacyImportCompleted: Boolean(store.legacyImports?.["petrio-server"] || store.importedAt),
        localStorageImportCompleted: Boolean(store.legacyImports?.["petrio-local-storage"]),
        conversations: store.conversations
      };
    });
  }

  async replaceDatabase(userId, source = {}, expectedRevision = null) {
    return this.exclusive(userId, async () => {
      const current = await this.load(userId);
      if (expectedRevision !== null && Number(expectedRevision) !== (Number(current.revision) || 0)) {
        throw Object.assign(new Error("Conversation history changed in another session. Reload before saving to avoid overwriting newer messages."), { status: 409, code: "conversation_revision_conflict", revision: Number(current.revision) || 0 });
      }
      const cleaned = this.cleanDatabase(userId, source);
      const next = {
        ...cleaned,
        importedAt: current.importedAt || null,
        legacyImports: current.legacyImports || {}
      };
      await this.save(userId, next);
      return { revision: next.revision, activeConversationId: next.activeConversationId, conversations: next.conversations };
    });
  }

  async importLegacy(userId, source = {}, sourceKey = "petrio-server") {
    if (!["petrio-server", "petrio-local-storage"].includes(sourceKey)) {
      throw Object.assign(new Error("Unsupported legacy conversation import source."), {
        status: 400, code: "CONVERSATION_IMPORT_SOURCE_INVALID"
      });
    }
    const input = source && typeof source === "object" ? source : {};
    if (!Array.isArray(input.conversations)) {
      throw Object.assign(new Error("Legacy conversation import requires a conversations array. No data was imported."), {
        status: 400, code: "CONVERSATION_IMPORT_INVALID"
      });
    }
    const rawConversations = input.conversations;
    if (rawConversations.length > MAX_CONVERSATIONS) {
      throw Object.assign(new Error(`Legacy history contains more than the supported ${MAX_CONVERSATIONS} conversations. No data was imported; export and migrate in reviewed batches.`), {
        status: 413, code: "CONVERSATION_IMPORT_LIMIT"
      });
    }
    const seenLegacyIds = new Set();
    for (const [index, conversation] of rawConversations.entries()) {
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
        throw Object.assign(new Error(`Legacy conversation ${index + 1} is not a valid object. No data was imported.`), {
          status: 400, code: "CONVERSATION_IMPORT_INVALID"
        });
      }
      const legacyId = String(conversation.id || "");
      if (legacyId && seenLegacyIds.has(legacyId)) {
        throw Object.assign(new Error(`Legacy conversation ID "${legacyId}" appears more than once. No data was imported.`), {
          status: 400, code: "CONVERSATION_IMPORT_DUPLICATE_ID"
        });
      }
      if (legacyId) seenLegacyIds.add(legacyId);
      if (conversation.messages !== undefined && !Array.isArray(conversation.messages)) {
        throw Object.assign(new Error(`Legacy conversation ${index + 1} has an invalid messages collection. No data was imported.`), {
          status: 400, code: "CONVERSATION_IMPORT_INVALID"
        });
      }
      if ((conversation.messages || []).length > MAX_MESSAGES) {
        throw Object.assign(new Error(`Legacy conversation ${index + 1} contains more than the supported ${MAX_MESSAGES} messages. No data was imported; export and migrate in reviewed batches.`), {
          status: 413, code: "CONVERSATION_IMPORT_LIMIT"
        });
      }
      for (const [messageIndex, message] of (conversation.messages || []).entries()) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw Object.assign(new Error(`Legacy conversation ${index + 1}, message ${messageIndex + 1} is invalid. No data was imported.`), {
            status: 400, code: "CONVERSATION_IMPORT_INVALID"
          });
        }
        if (message.transient === true) continue;
        if (!["user", "assistant"].includes(message.role) || !String(message.content || "").trim()) {
          throw Object.assign(new Error(`Legacy conversation ${index + 1}, message ${messageIndex + 1} has an unsupported role or empty content. No data was imported.`), {
            status: 400, code: "CONVERSATION_IMPORT_INVALID"
          });
        }
        if (String(message.content || "").length > 50000 || String(message.meta || "").length > 1000) {
          throw Object.assign(new Error(`Legacy conversation ${index + 1}, message ${messageIndex + 1} exceeds the supported content size. No data was imported.`), {
            status: 413, code: "CONVERSATION_IMPORT_LIMIT"
          });
        }
        const args = message.actionCard?.arguments;
        if (args && typeof args === "object" && !Array.isArray(args)) {
          let size = Infinity;
          try { size = JSON.stringify(args).length; } catch {}
          if (size > 12000) {
            throw Object.assign(new Error(`Legacy conversation ${index + 1}, message ${messageIndex + 1} contains oversized action metadata. No data was imported.`), {
              status: 413, code: "CONVERSATION_IMPORT_LIMIT"
            });
          }
        }
      }
    }
    return this.exclusive(userId, async () => {
      const current = await this.load(userId);
      if (current.legacyImports?.[sourceKey] || (sourceKey === "petrio-server" && current.importedAt)) {
        return { imported: false, reason: "legacy_history_already_imported", sourceKey, count: 0, skipped: rawConversations.length, total: current.conversations.length };
      }
      const cleaned = this.cleanDatabase(userId, source);
      const existingIds = new Set(current.conversations.map((item) => item.id));
      const additions = cleaned.conversations.filter((item) => !existingIds.has(item.id));
      const skipped = cleaned.conversations.length - additions.length;
      if (current.conversations.length + additions.length > MAX_CONVERSATIONS) {
        throw Object.assign(new Error("The combined Core and legacy history exceeds the supported conversation limit. No data was imported."), {
          status: 409, code: "CONVERSATION_IMPORT_LIMIT"
        });
      }
      const conversations = [...current.conversations, ...additions];
      const currentActiveConversationId = current.activeConversationId || current.conversations[0]?.id || null;
      const activeConversationId = conversations.some((item) => item.id === currentActiveConversationId)
        ? currentActiveConversationId
        : cleaned.activeConversationId && conversations.some((item) => item.id === cleaned.activeConversationId)
          ? cleaned.activeConversationId
          : conversations[0]?.id || null;
      const next = {
        ...current,
        activeConversationId,
        conversations,
        importedAt: sourceKey === "petrio-server" ? this.now() : current.importedAt || null,
        legacyImports: { ...(current.legacyImports || {}), [sourceKey]: this.now() }
      };
      await this.save(userId, next);
      return {
        imported: true,
        revision: next.revision,
        sourceKey,
        count: additions.length,
        skipped,
        total: conversations.length,
        activeConversationId: next.activeConversationId
      };
    });
  }

  async list(userId, options = {}) {
    const projectFilter = options?.projectId;
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      let items = store.conversations.slice();
      if (projectFilter === "unassigned") {
        items = items.filter((item) => !item.projectId);
      } else if (projectFilter && CONVERSATION_ID_PATTERN.test(String(projectFilter))) {
        items = items.filter((item) => item.projectId === projectFilter);
      }
      return items
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 100)
        .map(({ messages, handoffContext, ...summary }) => ({
          ...summary,
          projectId: summary.projectId || null,
          parentConversationId: summary.parentConversationId || null,
          continuedFromTitle: summary.continuedFromTitle || null,
          hasHandoffContext: Boolean(handoffContext && String(handoffContext).trim()),
          messageCount: Array.isArray(messages) ? messages.length : 0
        }));
    });
  }

  async create(userId, titleOrOptions = "New conversation") {
    const options = typeof titleOrOptions === "object" && titleOrOptions !== null
      ? titleOrOptions
      : { title: titleOrOptions };
    const rawProjectId = options.projectId;
    if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== "" && !CONVERSATION_ID_PATTERN.test(String(rawProjectId))) {
      throw Object.assign(new Error("Invalid project ID."), { status: 400, code: "PROJECT_ID_INVALID" });
    }
    const rawParentId = options.parentConversationId;
    if (rawParentId !== undefined && rawParentId !== null && rawParentId !== "" && !CONVERSATION_ID_PATTERN.test(String(rawParentId))) {
      throw Object.assign(new Error("Invalid parent conversation ID."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.conversations.length >= MAX_CONVERSATIONS) {
        throw Object.assign(new Error("This account has reached its conversation limit."), { status: 409 });
      }
      const now = this.now();
      const conversation = {
        id: this.uuid(),
        title: String(options.title || "New conversation").trim().slice(0, 120) || "New conversation",
        projectId: rawProjectId ? String(rawProjectId) : null,
        parentConversationId: rawParentId ? String(rawParentId) : null,
        continuedFromTitle: typeof options.continuedFromTitle === "string" && options.continuedFromTitle.trim()
          ? options.continuedFromTitle.trim().slice(0, 120)
          : null,
        handoffContext: typeof options.handoffContext === "string" && options.handoffContext.trim()
          ? options.handoffContext.trim().slice(0, 12000)
          : null,
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      store.conversations.push(conversation);
      store.activeConversationId = conversation.id;
      await this.save(userId, store);
      return conversation;
    });
  }

  async get(userId, conversationId) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      return conversation;
    });
  }

  async appendMessage(userId, conversationId, input = {}) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    const role = input.role === "assistant" ? "assistant" : input.role === "user" ? "user" : "";
    const content = String(input.content || "").trim().slice(0, MAX_CONTENT_LENGTH);
    if (!role || !content) throw Object.assign(new Error("A non-empty user or assistant message is required."), { status: 400 });
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      const taskId = CONVERSATION_ID_PATTERN.test(String(input.taskId || "")) ? String(input.taskId) : null;
      if (taskId) {
        const existing = conversation.messages.find((item) => item.taskId === taskId);
        if (existing) {
          if (existing.role !== role || existing.content !== content) throw Object.assign(new Error("This task ID was already used for a different conversation message."), { status: 409, code: "MESSAGE_IDEMPOTENCY_CONFLICT" });
          return existing;
        }
      }
      if (conversation.messages.length >= MAX_MESSAGES) {
        throw Object.assign(new Error("This conversation has reached its message limit."), { status: 409 });
      }
      const metrics = (input.metrics && typeof input.metrics === "object" && !Array.isArray(input.metrics))
        ? {
            latencyMs: Number.isFinite(Number(input.metrics.latencyMs)) ? Math.round(Number(input.metrics.latencyMs)) : null,
            totalTokens: Number.isFinite(Number(input.metrics.totalTokens)) ? Math.round(Number(input.metrics.totalTokens)) : null,
            completionTokens: Number.isFinite(Number(input.metrics.completionTokens)) ? Math.round(Number(input.metrics.completionTokens)) : null,
            model: typeof input.metrics.model === "string" ? input.metrics.model.slice(0, 100) : undefined,
            ...(typeof input.metrics.privacyLabel === "string" && input.metrics.privacyLabel.trim()
              ? { privacyLabel: input.metrics.privacyLabel.trim().slice(0, 80) }
              : {})
          }
        : undefined;
      const reaction = (input.reaction && ["like", "flag"].includes(String(input.reaction))) ? String(input.reaction) : undefined;
      const provenance = role === "assistant" ? cleanProvenance(input.provenance) : undefined;
      const actionCard = role === "assistant" ? cleanActionCard(input.actionCard) : undefined;
      const message = {
        id: this.uuid(),
        role,
        content,
        ...(taskId ? { taskId } : {}),
        createdAt: this.now(),
        ...(metrics ? { metrics } : {}),
        ...(provenance ? { provenance } : {}),
        ...(actionCard ? { actionCard } : {}),
        ...(reaction ? { reaction, reactedAt: this.now() } : {})
      };
      const afterTaskId = CONVERSATION_ID_PATTERN.test(String(input.afterTaskId || "")) ? String(input.afterTaskId) : null;
      const afterIndex = afterTaskId ? conversation.messages.findIndex((item) => item.taskId === afterTaskId && item.role === "user") : -1;
      if (afterIndex >= 0 && role === "assistant") conversation.messages.splice(afterIndex + 1, 0, message);
      else conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      store.activeConversationId = conversation.id;
      if (role === "user" && conversation.title === "New conversation") {
        conversation.title = content.replace(/\s+/g, " ").slice(0, 80);
      }
      await this.save(userId, store);
      return message;
    });
  }

  async updateActionCardState(userId, actionId, patch = {}) {
    const targetActionId = String(actionId || "").trim();
    if (!targetActionId) return { updated: false, conversationId: null, messageId: null };
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      let updatedConversationId = null;
      let updatedMessageId = null;
      for (const conversation of store.conversations) {
        if (!Array.isArray(conversation.messages)) continue;
        for (const message of conversation.messages) {
          if (message?.actionCard?.actionId === targetActionId) {
            const nextState = ["success", "read", "cancelled", "rejected", "error", "approval", "failed"].includes(patch.state)
              ? patch.state
              : message.actionCard.state;
            message.actionCard = {
              ...message.actionCard,
              state: nextState,
              ...(typeof patch.detail === "string" && patch.detail.trim()
                ? { detail: patch.detail.trim().slice(0, 1000) }
                : {})
            };
            conversation.updatedAt = this.now();
            updatedConversationId = conversation.id;
            updatedMessageId = message.id;
          }
        }
      }
      if (updatedConversationId) {
        await this.save(userId, store);
      }
      return {
        updated: Boolean(updatedConversationId),
        conversationId: updatedConversationId,
        messageId: updatedMessageId
      };
    });
  }

  async reactMessage(userId, conversationId, messageId, reaction) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    const cleanReaction = ["like", "flag"].includes(String(reaction)) ? String(reaction) : null;
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) throw Object.assign(new Error("Message not found."), { status: 404 });
      if (cleanReaction) {
        message.reaction = cleanReaction;
        message.reactedAt = this.now();
      } else {
        delete message.reaction;
        delete message.reactedAt;
      }
      conversation.updatedAt = this.now();
      await this.save(userId, store);
      return message;
    });
  }

  async rename(userId, conversationId, title) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    if (typeof title !== "string") {
      throw Object.assign(new Error("A conversation title is required."), { status: 400, code: "CONVERSATION_TITLE_INVALID" });
    }
    const cleanTitle = title.replace(/\s+/g, " ").trim();
    if (!cleanTitle || cleanTitle.length > 120) {
      throw Object.assign(new Error("Conversation titles must contain between 1 and 120 characters."), { status: 400, code: "CONVERSATION_TITLE_INVALID" });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      conversation.title = cleanTitle;
      conversation.updatedAt = this.now();
      await this.save(userId, store);
      return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
    });
  }

  async update(userId, conversationId, patch = {}) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    const updates = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string") {
        throw Object.assign(new Error("A conversation title is required."), { status: 400, code: "CONVERSATION_TITLE_INVALID" });
      }
      const cleanTitle = patch.title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || cleanTitle.length > 120) {
        throw Object.assign(new Error("Conversation titles must contain between 1 and 120 characters."), { status: 400, code: "CONVERSATION_TITLE_INVALID" });
      }
      updates.title = cleanTitle;
    }
    if (patch.projectId !== undefined) {
      if (patch.projectId === null || patch.projectId === "") {
        updates.projectId = null;
      } else if (CONVERSATION_ID_PATTERN.test(String(patch.projectId))) {
        updates.projectId = String(patch.projectId);
      } else {
        throw Object.assign(new Error("Invalid project ID."), { status: 400, code: "PROJECT_ID_INVALID" });
      }
    }
    if (!Object.keys(updates).length) {
      throw Object.assign(new Error("Provide a title or projectId to update."), { status: 400 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      Object.assign(conversation, updates, { updatedAt: this.now() });
      await this.save(userId, store);
      return {
        id: conversation.id,
        title: conversation.title,
        projectId: conversation.projectId || null,
        updatedAt: conversation.updatedAt
      };
    });
  }

  async clearProject(userId, projectId) {
    if (!CONVERSATION_ID_PATTERN.test(String(projectId || ""))) return { cleared: 0 };
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      let cleared = 0;
      for (const conversation of store.conversations) {
        if (conversation.projectId === projectId) {
          conversation.projectId = null;
          cleared += 1;
        }
      }
      if (cleared > 0) await this.save(userId, store);
      return { cleared };
    });
  }

  async remove(userId, conversationId) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.conversations.findIndex((item) => item.id === conversationId);
      if (index < 0) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      store.conversations.splice(index, 1);
      if (store.activeConversationId === conversationId) {
        store.activeConversationId = store.conversations[0]?.id || null;
      }
      await this.save(userId, store);
      return { deleted: true };
    });
  }
}
