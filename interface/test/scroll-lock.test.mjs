import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);

test("index.html contains scroll-to-bottom button for user jump action", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");

  assert.match(html, /id="scroll-to-bottom"/);
  assert.match(html, /class="[^"]*scroll-to-bottom-btn[^"]*"/);
  assert.match(html, /Latest messages/);
});

test("styles.css styles messages container with scroll-behavior: auto and scroll-to-bottom button", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  assert.match(css, /\.messages\s*\{[^}]*scroll-behavior:\s*auto;/s);
  assert.match(css, /\.scroll-to-bottom-btn\s*\{/);
  assert.match(css, /@keyframes scroll-btn-appear/);
});

test("app.js implements scroll-lock protection and conditional auto-scrolling during streaming", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  // Threshold and state tracking
  assert.match(app, /const SCROLL_BOTTOM_THRESHOLD\s*=\s*\d+/);
  assert.match(app, /let chatAutoScrollEnabled\s*=/);

  // Functions
  assert.match(app, /function isMessagesNearBottom/);
  assert.match(app, /function updateScrollToBottomIndicator/);
  assert.match(app, /function scrollChatToBottom/);

  // Public scroller helper
  assert.match(app, /window\.chatScroller\s*=\s*\{/);

  // Scroll listener to detect when user scrolls up
  assert.match(app, /messagesHost\.addEventListener\("scroll"/);

  // Conditional delta scrolling
  assert.match(app, /if\s*\(chatAutoScrollEnabled\)\s*\{\s*const host\s*=\s*\$\("#messages"\);\s*if\s*\(host\)\s*host\.scrollTop\s*=\s*host\.scrollHeight;/);

  // Jump to latest button listener
  assert.match(app, /\$\("#scroll-to-bottom"\)\?\.addEventListener\("click"/);
});
