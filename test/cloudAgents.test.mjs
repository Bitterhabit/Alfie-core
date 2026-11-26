import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCloudPrivacyPolicy, DEFAULT_CLOUD_VISIBILITY, filterWorkflowProfileForCloud, redactPersonalText } from "../src/privacy/policy.mjs";
import { CloudAgentStore } from "../src/providers/cloudAgentStore.mjs";
import { CloudAgentAdapters } from "../src/providers/cloudAdapters.mjs";
import { createAlfieCoreServer } from "../src/server.mjs";
import { createAlfieCoreClient } from "../src/client.mjs";
import { createPetrioIdentityAuth } from "../src/auth/petrioIdentity.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { ConversationStore } from "../src/conversations/store.mjs";
import { AuditStore } from "../src/audit/store.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { ProjectStore } from "../src/projects/store.mjs";

const SERVICE_TOKEN = "alfie-cloud-agents-test-service-token-0123456789";
const IDENTITY_SECRET = "alfie-cloud-agents-identity-secret-0123456789";

test("applyCloudPrivacyPolicy blocks mail, calendar, journal, memories, and personal tools by default", () => {
  const registry = new ToolRegistry();
  const noop = async () => ({ ok: true });
  registry.register({ id: "get_calendar_events", name: "Calendar", description: "Cal", scope: "calendar:read", trust: "external", network: false, externalAction: false, handler: noop });
  registry.register({ id: "read_journal", name: "Journal", description: "Journal", scope: "journal:read", trust: "external", network: false, externalAction: false, handler: noop });
  registry.register({ id: "read_inbox_mail", name: "Inbox", description: "Mail", scope: "mail:read", trust: "external", network: false, externalAction: false, handler: noop });
  registry.register({ id: "memory.search", name: "Memory", description: "Memory", scope: "memory:read", trust: "internal", network: false, externalAction: false, handler: noop });
  registry.register({ id: "get_implementation_audit", name: "Code Audit", description: "Audit", scope: "petrio:audit:read", trust: "external", network: false, externalAction: false, handler: noop });

  const result = applyCloudPrivacyPolicy({
    provider: "gemini",
    model: "gemini-4-hydrogen",
    visibility: DEFAULT_CLOUD_VISIBILITY,
    dashboardState: {
      mailSummary: "Secret email from boss@company.com about salary",
      calendarSummary: "Dentist appointment at 3pm",
      selectedDate: "2026-11-20",
      journalSummary: "Private personal reflection",
      systemSummary: "Private desktop notifications",
      notificationsCount: 4,
      attachedContext: "Project: API Refactor — contact dev@example.com for schema"
    },
    memories: [{ id: "m1", title: "Personal note", text: "My private address is 123 Lane" }],
    grantedScopes: ["calendar:read", "journal:read", "mail:read", "memory:read", "petrio:audit:read"],
    toolRegistry: registry,
    history: [{ role: "user", content: "Refactor auth.ts and ignore alice@private.org" }]
  });

  assert.equal(result.dashboardState.mailSummary, undefined);
  assert.equal(result.dashboardState.calendarSummary, undefined);
  assert.equal(result.dashboardState.selectedDate, undefined);
  assert.equal(result.dashboardState.journalSummary, undefined);
  assert.equal(result.dashboardState.systemSummary, undefined);
  assert.equal(result.dashboardState.notificationsCount, undefined);
  assert.match(result.dashboardState.attachedContext, /API Refactor/);
  assert.doesNotMatch(result.dashboardState.attachedContext, /dev@example\.com/);
  assert.match(result.dashboardState.attachedContext, /\[redacted-email\]/);
  assert.deepEqual(result.memories, []);
  assert.deepEqual(result.grantedScopes, ["petrio:audit:read"]);
  assert.deepEqual(result.blockedScopes.sort(), ["calendar:read", "journal:read", "mail:read", "memory:read"]);
  assert.equal(result.history[0].content, "Refactor auth.ts and ignore [redacted-email]");
  assert.equal(result.privacyReport.personalDataIsolated, true);
  assert.equal(result.privacyReport.redactedCount, 2);
  assert.ok(result.privacyReport.blockedCategories.includes("Emails & Inbox"));
  assert.ok(result.privacyReport.blockedCategories.includes("Calendar & Schedule"));
  assert.ok(result.privacyReport.blockedCategories.includes("Personal Journal"));
  assert.ok(result.privacyReport.blockedCategories.includes("Garden Memories"));
});

test("redactPersonalText scrubs email addresses cleanly", () => {
  const res = redactPersonalText("Reach me at sam.dev@example.co.uk or backup@test.io");
  assert.equal(res.count, 2);
  assert.equal(res.text, "Reach me at [redacted-email] or [redacted-email]");
});

test("CloudAgentStore enforces privacy warning acknowledgement, rejects browser API keys, and isolates users with 0600 files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-cloud-store-"));
  try {
    const store = new CloudAgentStore({
      dataDirectory: dir,
      env: { GEMINI_API_KEY: "test-gemini-key", OPENAI_API_KEY: "" }
    });

    const initial = await store.getPublicState("user-a");
    const gemini = initial.agents.find((a) => a.provider === "gemini");
    const openai = initial.agents.find((a) => a.provider === "openai");
    assert.equal(gemini.enabled, false);
    assert.equal(gemini.secretConfigured, true);
    assert.equal(gemini.model, "gemini-4-hydrogen");
    assert.equal(openai.secretConfigured, false);
    assert.equal(openai.model, "gpt-4.1-mini");
    assert.equal(gemini.visibility.allowMail, false);
    assert.equal(gemini.visibility.allowCalendar, false);
    assert.equal(gemini.visibility.allowJournal, false);
    assert.equal(gemini.visibility.allowPersonalMemories, false);

    // Reject enabling without privacy warning acceptance
    await assert.rejects(
      () => store.updateAgent("user-a", "gemini", { enabled: true }),
      (err) => err.status === 400 && err.code === "PRIVACY_WARNING_REQUIRED"
    );

    // Reject client-submitted API keys
    await assert.rejects(
      () => store.updateAgent("user-a", "openai", { apiKey: "sk-should-be-blocked" }),
      (err) => err.status === 400 && err.code === "SECRET_IN_CLIENT_FORBIDDEN"
    );

    // Enable with privacy warning accepted
    const updated = await store.updateAgent("user-a", "gemini", {
      privacyWarningAccepted: true,
      enabled: true,
      model: "gemini-3.1-flash-lite"
    });
    assert.equal(updated.enabled, true);
    assert.equal(updated.ready, true);
    assert.equal(updated.model, "gemini-3.1-flash-lite");

    // Verify 0600 permissions & user isolation
    const stat = await fs.stat(store.filePath("user-a"));
    assert.equal(stat.mode & 0o777, 0o600);
    const otherUser = await store.getAgent("user-b", "gemini");
    assert.equal(otherUser.enabled, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Core server routes Gemini & ChatGPT coding agents with strict server-side personal data isolation and tool blocking", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-cloud-e2e-"));
  const identityAuth = createPetrioIdentityAuth({ secret: IDENTITY_SECRET });
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const conversationStore = new ConversationStore({ dataDirectory: dir });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const auditStore = new AuditStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const toolRegistry = new ToolRegistry();
  const cloudAgentStore = new CloudAgentStore({
    dataDirectory: dir,
    env: { GEMINI_API_KEY: "fake-gemini-key", OPENAI_API_KEY: "fake-openai-key" }
  });

  let calendarToolCalled = false;
  toolRegistry.register({
    id: "get_calendar_events",
    name: "Calendar events",
    description: "Read calendar events",
    scope: "calendar:read",
    trust: "external",
    network: false,
    externalAction: false,
    tags: ["calendar"],
    handler: async () => {
      calendarToolCalled = true;
      return { events: ["Secret doctor visit"] };
    }
  });

  const capturedGeminiRequests = [];
  const capturedOpenAiRequests = [];
  let geminiCallCount = 0;

  const cloudAdapters = new CloudAgentAdapters({
    env: { GEMINI_API_KEY: "fake-gemini-key", OPENAI_API_KEY: "fake-openai-key" },
    geminiClientFactory: () => ({
      models: {
        generateContent: async (req) => {
          capturedGeminiRequests.push(req);
          geminiCallCount += 1;
          // First call simulates model trying to invoke a blocked calendar tool even when granted locally
          if (geminiCallCount === 1) {
            return {
              text: JSON.stringify({ type: "tool_call", tool: "get_calendar_events", arguments: {} }),
              usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 15, totalTokenCount: 55 }
            };
          }
          return {
            text: "```ts\nexport const sum = (a: number, b: number) => a + b;\n```",
            usageMetadata: { promptTokenCount: 45, candidatesTokenCount: 20, totalTokenCount: 65 }
          };
        }
      }
    }),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      capturedOpenAiRequests.push({ url: String(url), auth: init.headers.authorization, body });
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { content: "Here is the refactored TypeScript helper." } }],
        usage: { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  // Seed personal memory and grant calendar:read for local Alfie
  await memoryStore.create("user-1", { title: "Private diary", text: "TOP_SECRET_MEMORY_TOKEN_999", importance: 9 });
  await permissionStore.grant("user-1", "calendar:read");

  const server = createAlfieCoreServer({
    serviceToken: SERVICE_TOKEN,
    identityAuth,
    petrioIdentityAuth: identityAuth,
    petrioHarnessClient: { enabled: false },
    memoryStore,
    permissionStore,
    conversationStore,
    projectStore,
    auditStore,
    toolRegistry,
    pendingActionStore,
    cloudAgentStore,
    cloudAdapters,
    profileStore: {
      get: async () => ({
        explanationStyle: "concise",
        changePresentation: "diffs_and_rollback",
        interruptionTolerance: "balanced",
        chunkSize: "small_steps",
        learningMode: "explain",
        customNotes: "CLOUD_PRIVATE_NOTE_LEAK",
        location: { enabled: true, label: "CLOUD_PRIVATE_LOCATION_LEAK", latitude: 1, longitude: 2, timezone: "Europe/London" },
        learningTopics: [{ topic: "CLOUD_PRIVATE_TOPIC_LEAK", confidence: "practicing" }],
        learnedStyle: { traits: ["CLOUD_PRIVATE_STYLE_LEAK"] }
      })
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = createAlfieCoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
    serviceToken: SERVICE_TOKEN,
    identityAuth
  });

  try {
    // 1. Blocked before enabled
    await assert.rejects(
      () => client.chat("user-1", {
        agentProvider: "gemini",
        messages: [{ role: "user", content: "Write a sum helper" }]
      }),
      (err) => err.status === 403 && err.code === "CLOUD_AGENT_DISABLED"
    );

    // 2. Enable Gemini & ChatGPT after acknowledging privacy warning
    await client.updateCloudAgent("user-1", "gemini", {
      privacyWarningAccepted: true,
      enabled: true
    });
    await client.updateCloudAgent("user-1", "openai", {
      privacyWarningAccepted: true,
      enabled: true,
      model: "gpt-4.1"
    });

    // 3. Preview confirms calendar:read is blocked for Gemini
    const preview = await client.previewCloudAgentPrivacy("user-1", "gemini", {});
    assert.deepEqual(preview.blockedScopes, ["calendar:read"]);
    assert.equal(preview.summary.personalDataIsolated, true);

    // 4. Send coding prompt to Gemini with sensitive dashboardState — verify ZERO leakage & blocked tool call
    const geminiReply = await client.chat("user-1", {
      agentProvider: "gemini",
      messages: [{ role: "user", content: "Check my calendar and write sum(a,b) for private@home.test" }],
      dashboardState: {
        mailSummary: "PRIVATE_EMAIL_LEAK_CHECK",
        calendarSummary: "PRIVATE_CALENDAR_LEAK_CHECK",
        journalSummary: "PRIVATE_JOURNAL_LEAK_CHECK",
        attachedContext: "Project: Math Utils — pure TS functions"
      }
    });

    assert.equal(geminiReply.status, "completed");
    assert.equal(geminiReply.provider, "gemini");
    assert.equal(geminiReply.model, "gemini-4-hydrogen");
    assert.match(geminiReply.message, /export const sum/);
    assert.equal(geminiReply.privacyReport.personalDataIsolated, true);
    assert.equal(calendarToolCalled, false, "Cloud agent must never execute blocked calendar tool");

    const serializedGeminiPayload = JSON.stringify(capturedGeminiRequests);
    assert.doesNotMatch(serializedGeminiPayload, /PRIVATE_EMAIL_LEAK_CHECK/);
    assert.doesNotMatch(serializedGeminiPayload, /PRIVATE_CALENDAR_LEAK_CHECK/);
    assert.doesNotMatch(serializedGeminiPayload, /PRIVATE_JOURNAL_LEAK_CHECK/);
    assert.doesNotMatch(serializedGeminiPayload, /TOP_SECRET_MEMORY_TOKEN_999/);
    assert.doesNotMatch(serializedGeminiPayload, /private@home\.test/);
    assert.match(serializedGeminiPayload, /Math Utils/);
    for (const marker of ["CLOUD_PRIVATE_NOTE_LEAK", "CLOUD_PRIVATE_LOCATION_LEAK", "CLOUD_PRIVATE_TOPIC_LEAK", "CLOUD_PRIVATE_STYLE_LEAK"]) {
      assert.doesNotMatch(serializedGeminiPayload, new RegExp(marker), `Cloud provider must not receive ${marker}`);
    }

    // 5. Send coding prompt to ChatGPT (OpenAI) — verify ZERO leakage & proper Bearer header
    const openaiReply = await client.chat("user-1", {
      agentProvider: "openai",
      messages: [{ role: "user", content: "Refactor this helper function" }],
      dashboardState: {
        mailSummary: "PRIVATE_EMAIL_OPENAI_CHECK",
        calendarSummary: "PRIVATE_CALENDAR_OPENAI_CHECK",
        journalSummary: "PRIVATE_JOURNAL_OPENAI_CHECK"
      }
    });

    assert.equal(openaiReply.status, "completed");
    assert.equal(openaiReply.provider, "openai");
    assert.equal(openaiReply.model, "gpt-4.1");
    assert.equal(openaiReply.privacyReport.personalDataIsolated, true);
    assert.equal(capturedOpenAiRequests.length, 1);
    assert.equal(capturedOpenAiRequests[0].auth, "Bearer fake-openai-key");
    const serializedOpenAiPayload = JSON.stringify(capturedOpenAiRequests[0].body);
    assert.doesNotMatch(serializedOpenAiPayload, /PRIVATE_EMAIL_OPENAI_CHECK/);
    assert.doesNotMatch(serializedOpenAiPayload, /PRIVATE_CALENDAR_OPENAI_CHECK/);
    assert.doesNotMatch(serializedOpenAiPayload, /PRIVATE_JOURNAL_OPENAI_CHECK/);
    assert.doesNotMatch(serializedOpenAiPayload, /TOP_SECRET_MEMORY_TOKEN_999/);

    // 6. Optional private section access requires explicit privateAccessOptIn: true
    await assert.rejects(
      () => client.updateCloudAgent("user-1", "gemini", {
        visibility: { allowCalendar: true }
      }),
      (err) => err.status === 400 && err.code === "PRIVATE_ACCESS_OPT_IN_REQUIRED"
    );

    // 7. Opt Gemini into ONLY Calendar & Garden Memories (keep Mail & Journal blocked; keep OpenAI strictly coding-only)
    const optedInGemini = await client.updateCloudAgent("user-1", "gemini", {
      privateAccessOptIn: true,
      visibility: {
        allowCalendar: true,
        allowPersonalMemories: true,
        allowMail: false,
        allowJournal: false,
        allowDashboardState: false
      }
    });
    assert.equal(optedInGemini.agent.privateAccessOptIn, true);
    assert.equal(optedInGemini.agent.visibility.allowCalendar, true);
    assert.equal(optedInGemini.agent.visibility.allowPersonalMemories, true);
    assert.equal(optedInGemini.agent.visibility.allowMail, false);
    assert.deepEqual(
      optedInGemini.agent.privacySummary.allowedPersonalCategories,
      ["Calendar & Schedule", "Garden Memories"]
    );

    // Confirm calendar tool & memories now reach Gemini while Mail & Journal stay strictly blocked
    geminiCallCount = 0;
    capturedGeminiRequests.length = 0;
    const optedInReply = await client.chat("user-1", {
      agentProvider: "gemini",
      messages: [{ role: "user", content: "Check my calendar and my Private diary memory" }],
      dashboardState: {
        mailSummary: "STILL_BLOCKED_EMAIL_SECRET",
        calendarSummary: "OPTED_IN_CALENDAR_EVENT_42",
        journalSummary: "STILL_BLOCKED_JOURNAL_SECRET"
      }
    });

    assert.equal(optedInReply.status, "completed");
    assert.equal(calendarToolCalled, true, "Opted-in calendar tool should execute for Gemini");
    assert.equal(optedInReply.privacyReport.personalDataIsolated, false);
    assert.deepEqual(
      optedInReply.privacyReport.allowedPersonalCategories,
      ["Calendar & Schedule", "Garden Memories"]
    );
    const optedInGeminiPayload = JSON.stringify(capturedGeminiRequests);
    assert.match(optedInGeminiPayload, /OPTED_IN_CALENDAR_EVENT_42/);
    assert.match(optedInGeminiPayload, /TOP_SECRET_MEMORY_TOKEN_999/);
    assert.doesNotMatch(optedInGeminiPayload, /STILL_BLOCKED_EMAIL_SECRET/);
    assert.doesNotMatch(optedInGeminiPayload, /STILL_BLOCKED_JOURNAL_SECRET/);

    // OpenAI remains independently locked to strict coding-only mode
    const openaiStillLocked = await client.chat("user-1", {
      agentProvider: "openai",
      messages: [{ role: "user", content: "Check my calendar and Private diary memory" }],
      dashboardState: {
        calendarSummary: "SHOULD_NOT_REACH_OPENAI"
      }
    });
    assert.equal(openaiStillLocked.privacyReport.personalDataIsolated, true);
    const secondOpenAiPayload = JSON.stringify(capturedOpenAiRequests[1].body);
    assert.doesNotMatch(secondOpenAiPayload, /SHOULD_NOT_REACH_OPENAI/);
    assert.doesNotMatch(secondOpenAiPayload, /TOP_SECRET_MEMORY_TOKEN_999/);

    // 8. Turning off privateAccessOptIn immediately revokes all private sections
    const revoked = await client.updateCloudAgent("user-1", "gemini", {
      privateAccessOptIn: false
    });
    assert.equal(revoked.agent.privateAccessOptIn, false);
    assert.equal(revoked.agent.visibility.allowCalendar, false);
    assert.equal(revoked.agent.visibility.allowPersonalMemories, false);
    assert.equal(revoked.agent.privacySummary.personalDataIsolated, true);

    // 9. Verify privacy changes were recorded in AuditStore
    const auditEvents = await auditStore.list("user-1", { limit: 20 });
    const privacyAuditEvents = auditEvents.filter((e) => e.event === "cloud_agent.privacy_updated");
    assert.ok(privacyAuditEvents.length >= 3, "Cloud agent privacy changes should be audited");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CloudAgentStore encrypts UI-configured Gemini & OpenAI API keys at rest on the server, never exposes plaintext, and powers live chat without env vars", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-cloud-vault-"));
  const identityAuth = createPetrioIdentityAuth({ secret: IDENTITY_SECRET });
  const memoryStore = new MemoryStore({ dataDirectory: dir });
  const permissionStore = new PermissionStore({ dataDirectory: dir });
  const conversationStore = new ConversationStore({ dataDirectory: dir });
  const projectStore = new ProjectStore({ dataDirectory: dir });
  const auditStore = new AuditStore({ dataDirectory: dir });
  const pendingActionStore = new PendingActionStore({ dataDirectory: dir });
  const toolRegistry = new ToolRegistry();
  // Explicitly NO GEMINI_API_KEY or OPENAI_API_KEY in env!
  const cloudAgentStore = new CloudAgentStore({
    dataDirectory: dir,
    env: {}
  });

  const seenGeminiKeys = [];
  const seenOpenAiCalls = [];
  const cloudAdapters = new CloudAgentAdapters({
    env: {},
    geminiClientFactory: ({ apiKey }) => {
      seenGeminiKeys.push(apiKey);
      return {
        models: {
          generateContent: async () => ({
            text: "Gemini reply using encrypted server vault key.",
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12, totalTokenCount: 22 }
          })
        }
      };
    },
    fetchImpl: async (url, init) => {
      seenOpenAiCalls.push({ url: String(url), auth: init.headers.authorization });
      return new Response(JSON.stringify({
        model: "gpt-4.1-mini",
        choices: [{ message: { content: "OpenAI reply using encrypted server vault key." } }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const server = createAlfieCoreServer({
    serviceToken: SERVICE_TOKEN,
    identityAuth,
    petrioIdentityAuth: identityAuth,
    petrioHarnessClient: { enabled: false },
    memoryStore,
    permissionStore,
    conversationStore,
    projectStore,
    auditStore,
    toolRegistry,
    pendingActionStore,
    cloudAgentStore,
    cloudAdapters
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = createAlfieCoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
    serviceToken: SERVICE_TOKEN,
    identityAuth
  });

  const geminiSecret = "AIzaSyVaultSecretGeminiKey2026Test";
  const openaiSecret = "sk-proj-VaultSecretOpenAiKey2026Test";

  try {
    // 1. Initially neither provider has a secret configured, and default URLs are present
    const initial = await client.listCloudAgents("user-vault");
    const initGemini = initial.agents.find((a) => a.provider === "gemini");
    const initOpenAi = initial.agents.find((a) => a.provider === "openai");
    assert.equal(initGemini.secretConfigured, false);
    assert.equal(initGemini.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(initOpenAi.secretConfigured, false);
    assert.equal(initOpenAi.defaultBaseUrl, "https://api.openai.com/v1");

    // 2. Reject insecure/private URLs when saving credentials
    await assert.rejects(
      () => client.setCloudAgentCredential("user-vault", "openai", {
        credential: openaiSecret,
        baseUrl: "http://169.254.169.254/v1"
      }),
      (err) => err.status === 400
    );

    // 3. Save encrypted Gemini & OpenAI keys via server-side vault endpoint
    const savedGemini = await client.setCloudAgentCredential("user-vault", "gemini", {
      credential: geminiSecret,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
    });
    assert.equal(savedGemini.agent.secretConfigured, true);
    assert.equal(savedGemini.agent.vaultKeyConfigured, true);
    assert.equal(savedGemini.agent.secretSource, "server_vault");
    assert.equal(JSON.stringify(savedGemini).includes(geminiSecret), false);

    const savedOpenAi = await client.setCloudAgentCredential("user-vault", "openai", {
      credential: openaiSecret,
      baseUrl: "https://api.openai.com/v1"
    });
    assert.equal(savedOpenAi.agent.secretConfigured, true);
    assert.equal(savedOpenAi.agent.vaultKeyConfigured, true);
    assert.equal(savedOpenAi.agent.secretSource, "server_vault");
    assert.equal(JSON.stringify(savedOpenAi).includes(openaiSecret), false);

    // 4. Verify on-disk file is 0600, uses aes-256-gcm, and contains ZERO plaintext secret
    const diskText = await fs.readFile(cloudAgentStore.filePath("user-vault"), "utf8");
    assert.equal(diskText.includes(geminiSecret), false, "Gemini plaintext key must never be stored on disk");
    assert.equal(diskText.includes(openaiSecret), false, "OpenAI plaintext key must never be stored on disk");
    assert.match(diskText, /"alg":\s*"aes-256-gcm"/);
    const stat = await fs.stat(cloudAgentStore.filePath("user-vault"));
    assert.equal(stat.mode & 0o777, 0o600);

    // 5. Verify user isolation (another user sees secretConfigured: false)
    const otherUserState = await client.listCloudAgents("user-other");
    assert.equal(otherUserState.agents.find((a) => a.provider === "gemini").secretConfigured, false);
    assert.equal(otherUserState.agents.find((a) => a.provider === "openai").secretConfigured, false);

    // 6. Enable both and run live chat turns — verify server-resolved vault keys are passed cleanly
    await client.updateCloudAgent("user-vault", "gemini", { privacyWarningAccepted: true, enabled: true });
    await client.updateCloudAgent("user-vault", "openai", { privacyWarningAccepted: true, enabled: true });

    const geminiChat = await client.chat("user-vault", {
      agentProvider: "gemini",
      messages: [{ role: "user", content: "Ping Gemini" }]
    });
    assert.equal(geminiChat.status, "completed");
    assert.match(geminiChat.message, /Gemini reply using encrypted server vault key/);
    assert.deepEqual(seenGeminiKeys, [geminiSecret]);

    const openaiChat = await client.chat("user-vault", {
      agentProvider: "openai",
      messages: [{ role: "user", content: "Ping OpenAI" }]
    });
    assert.equal(openaiChat.status, "completed");
    assert.match(openaiChat.message, /OpenAI reply using encrypted server vault key/);
    assert.equal(seenOpenAiCalls.length, 1);
    assert.equal(seenOpenAiCalls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seenOpenAiCalls[0].auth, `Bearer ${openaiSecret}`);

    // 7. Audit events record updates without leaking any secret
    const auditEvents = await auditStore.list("user-vault", { limit: 20 });
    const serializedAudit = JSON.stringify(auditEvents);
    assert.equal(serializedAudit.includes(geminiSecret), false);
    assert.equal(serializedAudit.includes(openaiSecret), false);
    assert.ok(auditEvents.some((e) => e.event === "cloud_agent.credential_updated"));

    // 8. Clearing credential removes key cleanly
    const cleared = await client.clearCloudAgentCredential("user-vault", "openai");
    assert.equal(cleared.agent.secretConfigured, false);
    assert.equal(cleared.agent.vaultKeyConfigured, false);
    assert.equal(cleared.agent.secretSource, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cloud workflow profile only includes enum-backed interaction preferences", () => {
  const profile = filterWorkflowProfileForCloud({
    explanationStyle: "concise",
    changePresentation: "diffs_and_rollback",
    interruptionTolerance: "quiet",
    chunkSize: "small_steps",
    learningMode: "explain",
    customNotes: "Private notes: customer names and internal details",
    location: {
      enabled: true,
      label: "Example City, UK",
      latitude: 53.39,
      longitude: -3.02,
      timezone: "Europe/London"
    },
    learningTopics: [{ topic: "personal finances", confidence: "practicing" }],
    learnedStyle: { promptHints: ["Personal response preference"] },
    autoMemoryEnabled: true,
    learnFromFeedbackEnabled: true
  });

  assert.deepEqual(profile, {
    explanationStyle: "concise",
    changePresentation: "diffs_and_rollback",
    interruptionTolerance: "quiet",
    chunkSize: "small_steps",
    learningMode: "explain"
  });
  assert.equal(JSON.stringify(profile).includes("Example City"), false);
  assert.equal(JSON.stringify(profile).includes("Private notes"), false);
  assert.equal(filterWorkflowProfileForCloud(null), null);
});

