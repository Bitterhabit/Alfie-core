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
