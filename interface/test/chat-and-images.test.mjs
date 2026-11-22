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

test("AgentLoop fails closed when no model provider is configured and never bypasses image tools", async () => {
  let imageGenerationCalls = 0;
  const loop = new AgentLoop({
    providerRegistry: {
      complete: async () => { throw new Error("Add and enable at least one Alfie endpoint with a model name."); }
    },
    providerConfig: { endpoints: [] },
    toolRegistry: new ToolRegistry(),
    dispatcher: { permissionStore: { list: async () => [] }, resetTurn() {}, dispatch: async () => ({ status: "completed" }) },
    contextAssembler: new ContextAssembler(),
    imageGenerator: {
      generate: async () => {
        imageGenerationCalls += 1;
        throw new Error("Image generation must be proposed through a registered tool.");
      }
    }
  });

  const chatResult = await loop.run({
    userId: "test-user",
    messages: [{ role: "user", content: "Hello Alfie" }]
  });
  assert.equal(chatResult.status, "provider_unavailable");
  assert.match(chatResult.message, /haven't generated a response or taken any action/i);

  const imageResult = await loop.run({
    userId: "test-user",
    messages: [{ role: "user", content: "/image A pixel art purple garden with glowing crystals" }]
  });
  assert.equal(imageResult.status, "provider_unavailable");
  assert.equal(imageGenerationCalls, 0);
});
