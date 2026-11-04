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
