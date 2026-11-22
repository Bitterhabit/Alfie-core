import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const root = new URL("../public/", import.meta.url);

test("standalone workspace exposes independent navigation and model routing controls", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  assert.match(html, /id="model-mode"/);
  for (const mode of ["auto", "light", "standard", "work"]) {
    assert.match(html, new RegExp(`<option value="${mode}">`));
  }
  assert.match(app, /mode: \$\("#model-mode"\)\.value/);
  assert.match(app, /chat-approval-card/);
  assert.match(app, /Review in Tools & access/);
  assert.match(html, /data-view="garden"/);
  assert.match(html, /data-view="tools"/);
  assert.match(html, /data-view="settings"/);
});

test("password rotation has exactly one submit handler", async () => {
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const handlers = app.match(/\$\("#password-form"\)\.addEventListener\("submit"/g) || [];
  assert.equal(handlers.length, 1);
});

test("assistant messages include performance metrics badge with hoverable tooltip", async () => {
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  assert.match(app, /createMetricsBadge/);
  assert.match(app, /message-meta-badge/);
  assert.match(app, /message-tooltip/);
  assert.match(app, /formatLatency/);
  assert.match(app, /formatTokens/);
  assert.match(css, /\.message-meta-badge/);
  assert.match(css, /\.message-tooltip/);
  assert.match(css, /\.tooltip-grid/);
  assert.match(css, /\.message-meta-badge:hover \.message-tooltip/);
});

test("login screen centers Alfie's Soul without legacy A brand mark and includes password toggle and footer", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  const loginBlock = html.match(/<main id="login-screen"[\s\S]*?<\/main>/)?.[0] || "";
  assert.ok(loginBlock.length > 0, "login screen markup should exist");
  assert.match(loginBlock, /class="alfie-soul large"[^>]*id="login-soul"/);
  assert.match(loginBlock, /poe-sprite-large/);
  assert.doesNotMatch(loginBlock, /brand-mark/);
  assert.match(loginBlock, /Welcome back\./);
  assert.match(loginBlock, /Your space is ready\./);
  assert.match(loginBlock, /id="toggle-password"/);
  assert.match(loginBlock, /class="login-footer"/);
  assert.match(loginBlock, /v0\.3\.0/);
  assert.doesNotMatch(loginBlock, /remember/i);

  assert.match(css, /\.login-soul-stage/);
  assert.match(css, /\.login-soul-halo/);
  assert.match(css, /\.login-screen\.is-form-focused/);
  assert.match(css, /\.login-screen\.is-leaving/);
  assert.match(css, /\.app-shell\.is-entering/);

  assert.match(app, /initLoginCompanion/);
  assert.match(app, /transitionToApp/);
  assert.match(app, /querySelector\('button\[type="submit"\]'\)/);
});

test("login screen removes hardcoded default credentials, updates asset version, and keeps reduced-motion last in CSS", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");

  assert.match(html, /styles\.css\?v=alfie-workspace-0\.10\.1/);
  assert.match(html, /app\.js\?v=alfie-workspace-0\.10\.1/);
  assert.doesNotMatch(html, /value="admin"/);
  assert.doesNotMatch(html, /alfie123/);
  assert.match(html, /id="setup-form"/);

  assert.match(sw, /alfie-core-v6/);
  assert.doesNotMatch(sw, /offline-mode-token/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);

  const mobileIdx = css.indexOf("@media(max-width:768px)");
  const reducedIdx = css.lastIndexOf("@media(prefers-reduced-motion:reduce)");
  assert.ok(mobileIdx > 0 && reducedIdx > mobileIdx, "prefers-reduced-motion must appear after mobile breakpoint");
  const afterMobile = css.slice(mobileIdx, reducedIdx);
  assert.match(afterMobile, /\.password-toggle\{\s*width:44px;\s*height:44px;/);
  assert.match(afterMobile, /\.login-screen input\{\s*font-size:16px;/);
  const afterReduced = css.slice(reducedIdx);
  assert.doesNotMatch(afterReduced, /\.password-toggle\s*\{/);
});

test("workspace includes Projects management, 80% VRAM warning banner, and context handoff controls", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  assert.match(html, /id="project-list"/);
  assert.match(html, /id="new-project-btn"/);
  assert.match(html, /id="project-modal"/);
  assert.match(html, /id="chat-project-select"/);
  assert.match(html, /id="continue-chat-btn"/);
  assert.match(html, /id="vram-warning-banner"/);
  assert.match(html, /id="vram-continue-btn"/);
  assert.match(html, /id="settings-vram-surface"/);
  assert.match(html, /id="vram-notify-permission-btn"/);
  assert.match(html, /id="vram-connection-badge"/);
  assert.match(html, /id="vram-pc-setup"/);
  assert.match(html, /id="vram-setup-command"/);

  assert.match(css, /\.sidebar-projects-section/);
  assert.match(css, /\.vram-warning-banner/);
  assert.match(css, /\.toast\.toast-warning/);
  assert.match(css, /\.vram-pc-setup/);
  assert.match(css, /\.handoff-context-card/);
  assert.match(css, /\.project-modal/);

  assert.match(app, /continueInNewChat/);
  assert.match(app, /renderVramWarningBanner/);
  assert.match(app, /renderVramPcSetup/);
  assert.match(app, /triggerVramThresholdAlert/);
  assert.match(app, /applyVramSnapshot/);
  assert.match(app, /window\.Notification/);
  assert.match(app, /\/api\/telemetry\/vram/);
  assert.match(app, /createHandoffContextCard/);
  assert.match(app, /\/api\/core\/projects/);
  assert.match(app, /\/api\/core\/system\/vram/);
});

test("workspace includes Gemini & ChatGPT cloud coding agents with privacy warnings and zero API key input fields", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  assert.match(html, /id="agent-provider"/);
  assert.match(html, /id="cloud-privacy-banner"/);
  assert.match(html, /id="cloud-privacy-toggle-btn"/);
  assert.match(html, /id="cloud-privacy-drawer"/);
  assert.match(html, /id="cloud-privacy-lock-all-btn"/);
  assert.match(html, /id="settings-cloud-agents-surface"/);
  assert.match(html, /id="cloud-agents-list"/);
  assert.match(html, /Privacy Warning — External Cloud Providers/);
  assert.doesNotMatch(html, /name="apiKey"|name="geminiApiKey"|name="openaiApiKey"/i);

  assert.match(css, /\.cloud-privacy-banner/);
  assert.match(css, /\.cloud-privacy-drawer/);
  assert.match(css, /\.cloud-private-optin-box/);
  assert.match(css, /\.cloud-privacy-callout/);
  assert.match(css, /\.cloud-agents-grid/);
  assert.match(css, /\.cloud-visibility-row/);

  assert.match(app, /\/api\/core\/cloud-agents/);
  assert.match(app, /privateAccessOptIn/);
  assert.match(app, /renderCloudPrivacyDrawer/);
  assert.match(app, /renderCloudAgentsSettings/);
  assert.match(app, /renderCloudPrivacyBanner/);
  assert.match(app, /agentProvider: selectedAgentProvider/);
});

test("composer includes a Web Speech API microphone button placed next to the Send button", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const metadata = JSON.parse(await fs.readFile(new URL("../../metadata.json", root), "utf8"));

  assert.match(html, /src="\/voice-waveform\.mjs\?v=alfie-workspace-0\.10\.1"/);
  assert.match(html, /class="composer-action-group"[\s\S]*id="voice-input-btn"[\s\S]*class="voice-waveform"[\s\S]*class="voice-bar"[\s\S]*class="send-button"/);
  assert.match(css, /\.composer-action-group/);
  assert.match(css, /\.voice-button/);
  assert.match(css, /\.voice-button\.is-listening/);
  assert.match(css, /\.voice-waveform/);
  assert.match(css, /\.voice-bar/);
  assert.match(app, /webkitSpeechRecognition/);
  assert.match(app, /initVoiceInput/);
  assert.match(app, /attachVoiceAudioAnalyser/);
  assert.match(app, /startVoiceWaveform/);
  assert.match(app, /stopVoiceWaveform/);
  assert.match(app, /createAnalyser/);
  assert.match(app, /getByteTimeDomainData/);
  assert.match(app, /getByteFrequencyData/);
  assert.match(app, /computeBarHeightsFromAnalyser/);
  assert.match(app, /onspeechstart/);
  assert.ok(Array.isArray(metadata.permissions) && metadata.permissions.includes("microphone"));
});

test("workspace wires global keyboard shortcuts, Settings rebinding, and shortcut help dialog", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");

  assert.match(html, /src="\/shortcuts\.mjs\?v=alfie-workspace-0\.10\.1"/);
  assert.match(html, /aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(html, /aria-keyshortcuts="Control\+Shift\+L Meta\+Shift\+L"/);
  assert.match(html, /id="settings-shortcuts-surface"/);
  assert.match(html, /id="settings-shortcuts-list"/);
  assert.match(html, /id="shortcuts-reset-all-btn"/);
  assert.match(html, /id="shortcuts-help-btn"/);
  assert.match(html, /id="shortcuts-help-modal"/);
  assert.match(html, /id="shortcuts-help-custom-list"/);
  assert.match(html, /id="shortcuts-help-builtin-list"/);
  assert.match(css, /\.shortcuts-settings-list/);
  assert.match(css, /\.shortcut-kbd/);
  assert.match(css, /\.shortcuts-modal/);
  assert.match(css, /@keyframes shortcut-row-pulse/);
  assert.match(css, /@keyframes shortcut-prompt-pulse/);
  assert.match(css, /@keyframes shortcut-dot-pulse/);
  assert.match(css, /\.shortcut-recording-dot/);
  assert.match(sw, /\/shortcuts\.mjs\?v=alfie-workspace-0\.10\.1/);
  assert.match(app, /initGlobalKeyboardShortcuts/);
  assert.match(app, /renderShortcutSettings/);
  assert.match(app, /renderShortcutsHelpModal/);
  assert.match(app, /openShortcutsHelpModal/);
  assert.match(app, /handleShortcutRecordingKeydown/);
  assert.match(app, /closeAnyOpenModal/);
  assert.match(app, /focusComposerFromShortcut/);
  assert.match(app, /cycleSoulMoodFromShortcut/);
  assert.match(app, /AlfieShortcuts/);
});

test("chat header includes client-side Markdown conversation export button", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");

  assert.match(html, /src="\/markdown-export\.mjs\?v=alfie-workspace-0\.10\.1"/);
  assert.match(html, /id="export-chat-btn"/);
  assert.match(html, /Export \.md/);
  assert.match(css, /\.export-chat-btn/);
  assert.match(sw, /\/markdown-export\.mjs\?v=alfie-workspace-0\.10\.1/);
  assert.match(app, /exportCurrentConversationMarkdown/);
  assert.match(app, /AlfieMarkdownExport/);
  assert.match(app, /text\/markdown;charset=utf-8/);
});

test("workspace includes Adaptive Working Modes, Living Project Dossier, Ideas Vault, and Turn Provenance", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  assert.match(html, /id="working-mode-select"/);
  assert.match(html, /data-view="ideas"/);
  assert.match(html, /id="view-ideas"/);
  assert.match(html, /id="idea-form"/);
  assert.match(html, /id="idea-status-tabs"/);
  assert.match(html, /id="idea-tag-filters"/);
  assert.match(html, /id="idea-cmd-btn"/);
  assert.match(html, /id="project-vision-input"/);
  assert.match(html, /id="project-next-actions-input"/);
  assert.match(html, /id="project-blockers-input"/);
  assert.match(html, /id="project-decisions-input"/);

  assert.match(css, /\.turn-provenance/);
  assert.match(css, /\.idea-card/);
  assert.match(css, /\.idea-tag-filter-btn/);
  assert.match(css, /\.idea-card-tag-btn/);
  assert.match(css, /\.segmented-tabs/);

  assert.match(app, /createProvenanceDisclosure/);
  assert.match(app, /initWorkingModeSelector/);
  assert.match(app, /initIdeasVault/);
  assert.match(app, /renderIdeaTagFilters/);
  assert.match(app, /toggleIdeaTagFilter/);
  assert.match(app, /\/api\/core\/ideas/);
});

test("audit regressions: prop-types loads before Recharts, no async event.currentTarget.reset(), and single Copy button per message", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const ifaceServer = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

  const propTypesIdx = html.indexOf("/vendor/prop-types.min.js");
  const rechartsIdx = html.indexOf("/vendor/recharts.js");
  assert.ok(propTypesIdx > 0 && rechartsIdx > propTypesIdx, "prop-types.min.js must load before recharts.js");
  assert.match(sw, /\/vendor\/prop-types\.min\.js/);
  assert.match(ifaceServer, /"vendor\/prop-types\.min\.js"/);

  // Never call event.currentTarget.reset() after an await
  assert.doesNotMatch(app, /event\.currentTarget\.reset\(\)/);

  // Tightened feature controls: in-chat Dossier button, Promoted Ideas tab, project filter, inline editing, and explore-in-chat
  assert.match(html, /id="chat-project-dossier-btn"/);
  assert.match(html, /data-idea-status="promoted"/);
  assert.match(html, /id="idea-project-filter"/);
  assert.match(app, /createIdeaInlineEditForm/);
  assert.match(app, /exploreIdeaInChat/);
  assert.match(app, /resetIdeaFilters/);
  assert.match(app, /updateSlashSuggestions/);
  assert.match(app, /WORKING_MODE_DESCRIPTIONS/);
});

test("workspace includes Typed Memory v2 Garden controls, Capability Leases, and Deterministic Watchers & Attention Budget UI", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  assert.match(html, /id="memory-kind-tabs"/);
  assert.match(html, /id="memory-kind-select"/);
  assert.match(html, /id="memory-ttl-select"/);
  assert.match(html, /id="memory-show-archived"/);
  assert.match(html, /id="permission-lease-ttl"/);
  assert.match(html, /id="permission-lease-project"/);
  assert.match(html, /id="watchers-surface"/);
  assert.match(html, /id="watcher-form"/);
  assert.match(html, /id="watcher-list"/);
  assert.match(html, /id="watcher-event-tabs"/);
  assert.match(html, /id="watcher-event-list"/);

  assert.match(css, /\.garden-toolbar/);
  assert.match(css, /\.lease-selector-bar/);
  assert.match(css, /\.watchers-surface/);
  assert.match(css, /\.watcher-event-urgent/);

  assert.match(app, /initWatchers/);
  assert.match(app, /loadWatchers/);
  assert.match(app, /\/api\/core\/watchers/);
  assert.match(app, /MEMORY_KIND_LABELS/);
  assert.match(app, /MEMORY_TRUST_LABELS/);
  assert.match(app, /formatShortExpiry/);
});

test("workspace includes Simulation & Action Receipts, Learning Companion & Workflow Profile, and Context Capsules UI", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");

  assert.match(html, /id="learning-mode-select"/);
  assert.match(html, /id="chat-capsule-select"/);
  assert.match(html, /id="receipt-list"/);
  assert.match(html, /id="capsules-surface"/);
  assert.match(html, /id="capsule-form"/);
  assert.match(html, /id="capsule-list"/);
  assert.match(html, /id="settings-workflow-surface"/);
  assert.match(html, /id="workflow-profile-form"/);
  assert.match(html, /id="learning-topic-form"/);
  assert.match(html, /id="learning-topic-list"/);

  assert.match(css, /\.simulation-preview/);
  assert.match(css, /\.receipt-verified/);
  assert.match(css, /\.capsules-surface/);
  assert.match(css, /\.workflow-profile-surface/);
  assert.match(css, /\.learning-topic-form/);

  assert.match(app, /initWorkflowProfile/);
  assert.match(app, /initCapsules/);
  assert.match(app, /\/api\/core\/profile/);
  assert.match(app, /\/api\/core\/capsules/);
  assert.match(app, /\/api\/core\/tools\/receipts/);
});

test("workspace includes Personal Knowledge Graph Explorer, Multi-Lease capability controls, and Watcher Quiet Hours IANA timezone UI", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");

  assert.match(html, /src="\/knowledge-graph\.mjs\?v=alfie-workspace-0\.10\.1"/);
  assert.match(html, /id="garden-graph-surface"/);
  assert.match(html, /id="kg-kind-tabs"/);
  assert.match(html, /id="kg-canvas-wrap"/);
  assert.match(html, /id="kg-inspector"/);
  assert.match(html, /id="watcher-quiet-enabled"/);
  assert.match(html, /id="watcher-quiet-timezone"/);
  assert.match(sw, /\/knowledge-graph\.mjs\?v=alfie-workspace-0\.10\.1/);

  assert.match(css, /\.scope-lease-list/);
  assert.match(css, /\.watcher-quiet-row/);
  assert.match(css, /\.kg-surface/);
  assert.match(css, /\.kg-workspace/);

  assert.match(app, /initKnowledgeGraph/);
  assert.match(app, /loadKnowledgeGraph/);
  assert.match(app, /\/api\/core\/graph/);
  assert.match(app, /syncWatcherQuietControls/);
  assert.match(app, /scope-lease-row/);
});

test("workspace includes 100% Roadmap UI: SQLite WAL Storage, Account Recovery, Hybrid Search, Reflections, Optional Virtual Room, Workshop, Integrations, Airlock Preview, and Voice Loop TTS", async () => {
  const html = await fs.readFile(new URL("index.html", root), "utf8");
  const css = await fs.readFile(new URL("styles.css", root), "utf8");
  const app = await fs.readFile(new URL("app.js", root), "utf8");
  const sw = await fs.readFile(new URL("sw.js", root), "utf8");

  assert.match(html, /src="\/virtual-room\.mjs\?v=alfie-workspace-0\.10\.1"/);
  assert.match(sw, /\/virtual-room\.mjs\?v=alfie-workspace-0\.10\.1/);

  for (const id of [
    "recovery-disclosure",
    "recovery-form",
    "voice-tts-toggle",
    "voice-tts-stop",
    "hybrid-search-surface",
    "workspace-search-form",
    "reflections-surface",
    "reflection-save-btn",
    "virtual-room-details",
    "virtual-room-canvas",
    "ambient-push-btn",
    "workshop-surface",
    "workshop-form",
    "integrations-surface",
    "integrations-grid",
    "airlock-form",
    "settings-storage-surface",
    "storage-migrate-btn",
    "settings-voice-ambient-surface",
    "settings-recovery-surface",
    "recovery-generate-form"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected HTML id="${id}"`);
  }

  assert.match(css, /\.hybrid-search-surface/);
  assert.match(css, /\.virtual-room-details/);
  assert.match(css, /\.workshop-job-card/);
  assert.match(css, /\.integrations-grid/);
  assert.match(css, /\.airlock-preview-block/);
  assert.match(css, /\.storage-status-grid/);

  assert.match(app, /initVoiceLoopTts/);
  assert.match(app, /initAccountRecovery/);
  assert.match(app, /initStorageAndAirlock/);
  assert.match(app, /initHybridSearch/);
  assert.match(app, /initReflectionsAndVirtualRoom/);
  assert.match(app, /initWorkshopAndIntegrations/);
  assert.match(app, /\/api\/core\/storage\/status/);
  assert.match(app, /\/api\/core\/privacy\/airlock\/preview/);
  assert.match(app, /\/api\/core\/workshop\/delegate/);
  assert.match(app, /\/api\/core\/reflections/);
  assert.match(app, /\/api\/core\/ambient\/state/);
});

test("Phase 6 UI surfaces (Encrypted Vault, Self-Audit Diagnostics, Peer Client Tokens, Deterministic Playbooks, Continuity Timeline & Markdown Digest) are wired", async () => {
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

  for (const id of [
    "timeline-surface",
    "timeline-kind-tabs",
    "markdown-digest-btn",
    "playbooks-surface",
    "playbook-form",
    "peer-tokens-surface",
    "peer-token-form",
    "settings-diagnostics-surface",
    "diagnostics-score-badge",
    "settings-vault-surface",
    "vault-export-form",
    "vault-restore-form",
    "vault-verify-btn"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected Phase 6 HTML id="${id}"`);
  }

  assert.match(css, /\.timeline-surface/);
  assert.match(css, /\.playbooks-surface/);
  assert.match(css, /\.peer-tokens-surface/);
  assert.match(css, /\.diagnostics-checks-grid/);
  assert.match(css, /\.vault-split-grid/);

  assert.match(app, /initPhase6Vault/);
  assert.match(app, /initPhase6Diagnostics/);
  assert.match(app, /initPhase6PeerTokens/);
  assert.match(app, /initPhase6Playbooks/);
  assert.match(app, /initPhase6Timeline/);
  assert.match(app, /\/api\/core\/vault\/export/);
  assert.match(app, /\/api\/core\/diagnostics\/audit/);
  assert.match(app, /\/api\/core\/clients\/tokens/);
  assert.match(app, /\/api\/core\/playbooks/);
  assert.match(app, /\/api\/core\/timeline/);
  assert.match(app, /\/api\/core\/export\/markdown/);
});



