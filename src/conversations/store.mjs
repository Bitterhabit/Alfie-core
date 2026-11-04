import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const CONVERSATION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 50000;

function safeUserKey(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw Object.assign(new Error("A verified user identity is required."), { status: 401 });
  }
  return createHash("sha256").update(userId).digest("hex");
}

export class ConversationStore {
  constructor({ dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data", now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.now = now;
    this.uuid = uuid;
    this.queues = new Map();
  }

  fileFor(userId) {
    const key = safeUserKey(userId);
    return path.join(this.dataDirectory, "users", key, "conversations.json");
  }

  async exclusive(userId, operation) {
    const key = safeUserKey(userId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const queued = current.catch(() => {});
    this.queues.set(key, queued);
    try { return await current; }
    finally { if (this.queues.get(key) === queued) this.queues.delete(key); }
  }

  async load(userId) {
    const file = this.fileFor(userId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const store = JSON.parse(raw);
      if (store.schemaVersion !== 1 || store.ownerId !== userId || !Array.isArray(store.conversations)) {
        throw new Error("Conversation store failed its integrity check.");
      }
      return store;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, revision: 0, ownerId: userId, activeConversationId: null, conversations: [] };
      throw error;
    }
  }

  async save(userId, store) {
    const file = this.fileFor(userId);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `conversations.${this.uuid()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      store.revision = Math.max(0, Number(store.revision) || 0) + 1;
      await handle.writeFile(JSON.stringify(store, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
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
          const card = rawMessage.actionCard;
          const safeCard = {
            state: ["success", "read", "cancelled", "rejected", "error", "approval"].includes(card.state) ? card.state : "error",
            label: String(card.label || "Alfie Action").slice(0, 120),
            detail: String(card.detail || (["confirm", "working"].includes(card.state) ? "This temporary action state expired when the conversation was restored." : "")).slice(0, 1000)
          };
          for (const key of ["actionId", "toolId", "risk", "target"]) {
            if (typeof card[key] === "string") safeCard[key] = card[key].slice(0, 160);
          }
          if (card.arguments && typeof card.arguments === "object" && !Array.isArray(card.arguments)) {
            try {
              const serialised = JSON.stringify(card.arguments);
              if (serialised.length <= 12000) safeCard.arguments = JSON.parse(serialised);
            } catch {}
          }
          message.actionCard = safeCard;
        }
        messages.push(message);
      }
      conversations.push({
        id,
        title: String(raw.title || "New conversation").slice(0, 160),
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

  async list(userId) {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      return store.conversations
        .slice()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 100)
        .map(({ messages, ...summary }) => summary);
    });
  }

  async create(userId, title = "New conversation") {
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      if (store.conversations.length >= MAX_CONVERSATIONS) {
        throw Object.assign(new Error("This account has reached its conversation limit."), { status: 409 });
      }
      const now = this.now();
      const conversation = {
        id: this.uuid(),
        title: String(title || "New conversation").trim().slice(0, 120) || "New conversation",
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      store.conversations.push(conversation);
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
      if (conversation.messages.length >= MAX_MESSAGES) {
        throw Object.assign(new Error("This conversation has reached its message limit."), { status: 409 });
      }
      const message = { id: this.uuid(), role, content, createdAt: this.now() };
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      if (role === "user" && conversation.title === "New conversation") {
        conversation.title = content.replace(/\s+/g, " ").slice(0, 80);
      }
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

  async remove(userId, conversationId) {
    if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
      throw Object.assign(new Error("Conversation not found."), { status: 404 });
    }
    return this.exclusive(userId, async () => {
      const store = await this.load(userId);
      const index = store.conversations.findIndex((item) => item.id === conversationId);
      if (index < 0) throw Object.assign(new Error("Conversation not found."), { status: 404 });
      store.conversations.splice(index, 1);
      await this.save(userId, store);
      return { deleted: true };
    });
  }
}
