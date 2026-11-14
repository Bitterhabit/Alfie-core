import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);

test("styles.css styles copy-to-clipboard button and code snippet copy button", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  assert.match(css, /\.copy-clipboard-btn\s*\{/);
  assert.match(css, /\.copy-clipboard-btn:hover\s*\{/);
  assert.match(css, /\.copy-clipboard-btn\.copied\s*\{/);
  assert.match(css, /\.copy-code-btn\s*\{/);
  assert.match(css, /\.copy-clipboard-btn\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  // Mobile touch target styling
  assert.match(css, /\.copy-clipboard-btn\{min-height:36px;/);
});

test("app.js implements copyTextToClipboard with secure context and fallback support", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /async function copyTextToClipboard\(/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /document\.execCommand\("copy"\)/);
});

test("app.js implements attachCopyButtonToBody with 'Copy to clipboard' button and label", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /function attachCopyButtonToBody\(/);
  assert.match(app, /copy-clipboard-btn/);
  assert.match(app, /aria-label",\s*"Copy to clipboard"/);
  assert.match(app, /Copy to clipboard/);
  assert.match(app, /Copied to clipboard/);
  assert.match(app, /btn\.classList\.add\("copied"\)/);
});

test("styles.css styles .reaction-btn.copied state for message actions", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  assert.match(css, /\.reaction-btn\.copied\s*\{/);
  assert.match(css, /\.reaction-btn\.copied\s*\{[^}]*border-color:\s*var\(--green/);
});

test("app.js injects Copy to clipboard button into .message-actions container for every assistant message", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  // In createReactionControls
  assert.match(app, /function createReactionControls\(/);
  assert.match(app, /container\.className = "message-actions"/);
  assert.match(app, /const copyBtn = document\.createElement\("button"\)/);
  assert.match(app, /copyBtn\.className = "reaction-btn copy copy-clipboard-btn"/);
  assert.match(app, /copyBtn\.setAttribute\("aria-label",\s*"Copy to clipboard"\)/);
  assert.match(app, /container\.append\(\s*copyBtn,/);

  // In appendMessageElement
  assert.match(app, /if\s*\(message\.role === "assistant"\)\s*\{\s*const actions = createReactionControls\(message\);\s*article\.appendChild\(actions\);/);
});

test("app.js clipboard handler toggles .copied class and provides visual feedback", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  // Handler toggles .copied class and updates visual state
  assert.match(app, /copyBtn\.classList\.add\("copied"\)/);
  assert.match(app, /copyBtn\.setAttribute\("aria-label",\s*"Copied to clipboard"\)/);
  assert.match(app, /✓/);
  assert.match(app, /toast\("Copied to clipboard"\)/);
  assert.match(app, /copyBtn\.classList\.remove\("copied"\)/);
});

