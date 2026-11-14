import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);

test("index.html contains interface theme toggle controls in the settings view", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");

  assert.match(html, /id="settings-theme-surface"/);
  assert.match(html, /id="theme-toggle-group"/);
  assert.match(html, /data-theme-set="dark"/);
  assert.match(html, /data-theme-set="light"/);
  assert.match(html, /Dark theme/);
  assert.match(html, /Light theme/);
});

test("styles.css defines dark and light theme CSS variables and theme toggle styles", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  // Base root and light mode variables
  assert.match(css, /:root\s*\{/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{/);
  assert.match(css, /--bg:\s*#f5f2fa/);
  assert.match(css, /--panel:\s*#ffffff/);
  assert.match(css, /--text:\s*#221c35/);
  assert.match(css, /--purple:\s*#7052d4/);

  // Theme toggle group and buttons
  assert.match(css, /\.theme-toggle-group/);
  assert.match(css, /\.theme-choice-btn/);
  assert.match(css, /\.theme-choice-btn\.active/);
  assert.match(css, /\.dark-dot/);
  assert.match(css, /\.light-dot/);
  assert.match(css, /\.theme-status-pill/);
});

test("app.js implements AlfieThemeController that updates CSS variables and persists theme", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /class AlfieThemeController/);
  assert.match(app, /window\.alfieTheme = new AlfieThemeController\(\)/);
  assert.match(app, /THEME_DEFINITIONS/);
  assert.match(app, /document\.documentElement\.setAttribute\("data-theme",\s*selected\)/);
  assert.match(app, /document\.documentElement\.style\.setProperty\(key,\s*value\)/);
  assert.match(app, /localStorage\.setItem\(THEME_STORAGE_KEY,\s*selected\)/);
  assert.match(app, /data-theme-set/);
});

test("index.html contains Alfie Soul Palette Profile controls in settings view", async () => {
  const html = await fs.readFile(new URL("index.html", publicDir), "utf8");

  assert.match(html, /id="settings-soul-theme-surface"/);
  assert.match(html, /id="soul-theme-toggle-group"/);
  assert.match(html, /data-soul-theme-set="amethyst"/);
  assert.match(html, /data-soul-theme-set="cyber-cyan"/);
  assert.match(html, /data-soul-theme-set="solar-gold"/);
  assert.match(html, /data-soul-theme-set="emerald-matrix"/);
  assert.match(html, /data-soul-theme-set="rose-quartz"/);
  assert.match(html, /data-soul-theme-set="obsidian-silver"/);
  assert.match(html, /data-soul-theme-set="prism-sunset"/);
});

test("styles.css defines theme profiles mapping color palettes to existing soul CSS variables", async () => {
  const css = await fs.readFile(new URL("styles.css", publicDir), "utf8");

  // Theme profile selectors
  assert.match(css, /\[data-soul-theme="amethyst"\]/);
  assert.match(css, /\[data-soul-theme="cyber-cyan"\]/);
  assert.match(css, /\[data-soul-theme="solar-gold"\]/);
  assert.match(css, /\[data-soul-theme="emerald-matrix"\]/);
  assert.match(css, /\[data-soul-theme="rose-quartz"\]/);
  assert.match(css, /\[data-soul-theme="obsidian-silver"\]/);
  assert.match(css, /\[data-soul-theme="prism-sunset"\]/);

  // Mapped to existing CSS variables
  assert.match(css, /\[data-soul-theme="cyber-cyan"\][^}]*--soul-glow:\s*rgba\(6,\s*182,\s*212/);
  assert.match(css, /\[data-soul-theme="cyber-cyan"\][^}]*--soul-core-1:\s*#06b6d4/);
  assert.match(css, /\[data-soul-theme="cyber-cyan"\][^}]*--soul-core-2:\s*#164e63/);
  assert.match(css, /\[data-soul-theme="solar-gold"\][^}]*--soul-core-1:\s*#f59e0b/);
  assert.match(css, /\[data-soul-theme="emerald-matrix"\][^}]*--soul-core-1:\s*#22c55e/);
  assert.match(css, /\[data-soul-theme="rose-quartz"\][^}]*--soul-core-1:\s*#f43f5e/);
  assert.match(css, /\[data-soul-theme="obsidian-silver"\][^}]*--soul-core-1:\s*#cbd5e1/);

  // Palette picker UI styles
  assert.match(css, /\.soul-theme-grid/);
  assert.match(css, /\.soul-theme-choice-btn/);
  assert.match(css, /\.soul-theme-choice-btn\.active/);
  assert.match(css, /\.soul-swatch-orb/);
  assert.match(css, /\.amethyst-orb/);
  assert.match(css, /\.cyan-orb/);
});

test("app.js implements soul theme profile switching and persists palette selection", async () => {
  const app = await fs.readFile(new URL("app.js", publicDir), "utf8");

  assert.match(app, /SOUL_THEME_PROFILES/);
  assert.match(app, /setThemeProfile\(/);
  assert.match(app, /getThemeProfile\(/);
  assert.match(app, /data-soul-theme/);
  assert.match(app, /document\.documentElement\.style\.setProperty\(key,\s*val\)/);
  assert.match(app, /localStorage\.setItem\(SOUL_THEME_STORAGE_KEY/);
  assert.match(app, /data-soul-theme-set/);
});

