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

  assert.match(html, /styles\.css\?v=alfie-workspace-0\.9\.0/);
  assert.match(html, /app\.js\?v=alfie-workspace-0\.9\.0/);
  assert.doesNotMatch(html, /value="admin"/);
  assert.doesNotMatch(html, /alfie123/);
  assert.match(html, /id="setup-form"/);

  assert.match(sw, /alfie-core-v4/);
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

  assert.match(html, /src="\/voice-waveform\.mjs\?v=alfie-workspace-0\.9\.0"/);
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


