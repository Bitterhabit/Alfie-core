import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { AgentLoop } from "../../src/agent/loop.mjs";
import { ContextAssembler } from "../../src/agent/contextAssembler.mjs";
import { ToolRegistry } from "../../src/tools/registry.mjs";

test("index.html contains composer image button, suggestion items, and image lightbox modal", async () => {
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('id="image-cmd-btn"'), "composer should have #image-cmd-btn");
  assert.ok(html.includes('id="composer-suggestions"'), "composer should have #composer-suggestions");
  assert.ok(html.includes('data-cmd="/image "'), "composer should have data-cmd for /image");
  assert.ok(html.includes('data-prompt="/image'), "suggestion-grid should have /image prompt button");
  assert.ok(html.includes('id="image-lightbox"'), "index.html should define #image-lightbox dialog");
  assert.ok(html.includes('id="lightbox-zoom-in"'), "lightbox should have zoom-in button");
  assert.ok(html.includes('id="lightbox-zoom-out"'), "lightbox should have zoom-out button");
  assert.ok(html.includes('id="lightbox-zoom-reset"'), "lightbox should have zoom reset button");
  assert.ok(html.includes('id="lightbox-download"'), "lightbox should have download action");
  assert.ok(html.includes('id="lightbox-close"'), "lightbox should have close button");
});

test("styles.css defines chat-image-card, composer-suggestions, and image-lightbox modal", async () => {
  const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(css.includes(".chat-image-card"), "styles.css should style .chat-image-card");
  assert.ok(css.includes(".chat-image-img"), "styles.css should style .chat-image-img");
  assert.ok(css.includes(".composer-suggestions"), "styles.css should style .composer-suggestions");
  assert.ok(css.includes(".composer-cmd-btn"), "styles.css should style .composer-cmd-btn");
  assert.ok(css.includes(".image-lightbox"), "styles.css should style .image-lightbox");
  assert.ok(css.includes(".lightbox-stage"), "styles.css should style .lightbox-stage");
  assert.ok(css.includes(".lightbox-img"), "styles.css should style .lightbox-img");
});

test("app.js wires generated images to the lightbox modal with zoom and download helpers", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function openImageLightbox\(/);
  assert.match(app, /function closeImageLightbox\(/);
  assert.match(app, /function setLightboxZoom\(/);
  assert.match(app, /function clampLightboxZoom\(/);
  assert.match(app, /window\.alfieLightbox\s*=/);
  assert.match(app, /openImageLightbox\(\{\s*url,/);
});

test("AgentLoop autonomously provides core assistant fallback when no remote LLM endpoints exist", async () => {
  const registry = new ToolRegistry();
  const permissionStore = { list: async () => [] };
  const dispatcher = { permissionStore, resetTurn() {}, dispatch: async () => ({ status: "completed" }) };
  const providerRegistry = {
    complete: async () => { throw new Error("Add and enable at least one Alfie endpoint with a model name."); }
  };
  const mockImageGen = {
    generate: async ({ prompt, style }) => ({
      id: "img-test-1",
      filename: "img-test-1.svg",
      url: "/api/core/images/img-test-1.svg",
      prompt,
      style,
      provider: "alfie-pixel-studio"
    })
  };

  const loop = new AgentLoop({
    providerRegistry,
    providerConfig: { endpoints: [] },
    toolRegistry: registry,
    dispatcher,
    contextAssembler: new ContextAssembler(),
    imageGenerator: mockImageGen
  });

  // Test general chat / greeting
  const chatResult = await loop.run({
    userId: "test-user",
    messages: [{ role: "user", content: "Hello Alfie" }]
  });
  assert.equal(chatResult.status, "completed");
  assert.ok(chatResult.message.includes("Alfie"));

  // Test priorities / overview
  const overviewResult = await loop.run({
    userId: "test-user",
    messages: [{ role: "user", content: "Give me a concise overview of my current priorities." }]
  });
  assert.equal(overviewResult.status, "completed");
  assert.ok(overviewResult.message.includes("Priorities") || overviewResult.message.includes("Overview"));

  // Test /image generation
  const imageResult = await loop.run({
    userId: "test-user",
    messages: [{ role: "user", content: "/image A pixel art purple garden with glowing crystals" }]
  });
  assert.equal(imageResult.status, "completed");
  assert.ok(imageResult.message.includes("![A pixel art purple garden with glowing crystals](/api/core/images/img-test-1.svg)"));
});
