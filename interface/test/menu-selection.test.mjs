import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);

test("app.js handles menu selection across views and hides link-required appropriately", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  // setView hides link-required when selecting another view
  assert.match(app, /const linkReq = \$\("#link-required"\)/);
  assert.match(app, /const isChatUnlinked = view === "chat" && !state\.linked/);
  assert.match(app, /linkReq\.hidden = !isChatUnlinked/);

  // Delegated click listener handles [data-view] and .nav-item
  assert.match(app, /event\.target\.closest\("\.nav-item,\s*\[data-view\]"\)/);

  // Selecting conversation switches to chat view
  assert.match(app, /setView\("chat"\);\s*loadConversation\(item\.id\)/);

  // Model mode dropdown change is handled
  assert.match(app, /\$\("#model-mode"\)\?\.addEventListener\("change"/);
});

test("styles.css styles select options and nav-item cursor/pointer-events for reliable selection", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  assert.match(css, /select\s*option\s*\{/);
  assert.match(css, /\.nav-item\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.nav-item\s*\*\s*\{\s*pointer-events:\s*none/);
});
