import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssetInterceptorMiddleware, detectBinaryFormat } from "../src/agent/assetMiddleware.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { PermissionStore } from "../src/permissions/store.mjs";
import { PendingActionStore } from "../src/agent/pendingActionStore.mjs";
import { ToolDispatcher } from "../src/agent/toolDispatcher.mjs";
import { AgentLoop } from "../src/agent/loop.mjs";
import { ContextAssembler } from "../src/agent/contextAssembler.mjs";

// Minimal valid 1x1 PNG buffer
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const TINY_PNG_B64 = TINY_PNG_BUFFER.toString("base64");
const TINY_JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const TINY_WEBP_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x14, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
]);
const TINY_SVG_BUFFER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#7c3aed"/></svg>', "utf8");

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-assets-"));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true })
  };
}

test("detectBinaryFormat identifies PNG, JPEG, WebP, SVG, and generic binary buffers", () => {
  assert.deepEqual(detectBinaryFormat(TINY_PNG_BUFFER), { mimeType: "image/png", ext: "png", isImage: true });
  assert.deepEqual(detectBinaryFormat(TINY_JPEG_BUFFER), { mimeType: "image/jpeg", ext: "jpg", isImage: true });
  assert.deepEqual(detectBinaryFormat(TINY_WEBP_BUFFER), { mimeType: "image/webp", ext: "webp", isImage: true });
  assert.deepEqual(detectBinaryFormat(TINY_SVG_BUFFER), { mimeType: "image/svg+xml", ext: "svg", isImage: true });
  assert.deepEqual(detectBinaryFormat(Buffer.from([0x01, 0x02, 0x03, 0x04])), {
    mimeType: "application/octet-stream",
    ext: "bin",
    isImage: false
  });
});

test("middleware intercepts raw Buffer/Uint8Array results, writes to assets directory, and returns compact JSON summary", async () => {
  const tmp = await makeTempDir();
  try {
    const mw = createAssetInterceptorMiddleware({
      assetsDirectory: tmp.dir,
      filePathPrefix: "./assets",
      now: () => 1731609000000
    });

    const result = await mw({ toolId: "pixellab.sprite" }, async () => TINY_PNG_BUFFER);
    assert.equal(result.assetSaved, true);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, TINY_PNG_BUFFER.length);
    assert.match(result.filePath, /^\.\/assets\/pixellab_sprite-1731609000000-[a-f0-9]{8}\.png$/);
    assert.equal(result.assets.length, 1);

    const diskPath = path.join(tmp.dir, path.basename(result.filePath));
    const written = await fs.readFile(diskPath);
    assert.deepEqual(written, TINY_PNG_BUFFER);

    // Also test Uint8Array
    const u8Result = await mw({ toolId: "pixellab.webp" }, async () => new Uint8Array(TINY_WEBP_BUFFER));
    assert.equal(u8Result.assetSaved, true);
    assert.equal(u8Result.mimeType, "image/webp");
    assert.match(u8Result.filePath, /\.webp$/);
  } finally {
    await tmp.cleanup();
  }
});

test("middleware intercepts MCP image content blocks, data URIs, and preserves non-binary metadata", async () => {
  const tmp = await makeTempDir();
  try {
    const mw = createAssetInterceptorMiddleware({
      assetsDirectory: tmp.dir,
      filePathPrefix: "./assets",
      now: () => 1731609001000
    });

    const mcpResponse = {
      status: "completed",
      jobId: "job-42",
      width: 64,
      height: 64,
      content: [
        { type: "text", text: "Generated knight sprite sheet" },
        { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
        { type: "image_url", image_url: { url: `data:image/svg+xml;base64,${TINY_SVG_BUFFER.toString("base64")}` } }
      ]
    };

    const intercepted = await mw({ toolId: "pixellab.character" }, async () => mcpResponse);
    assert.equal(intercepted.status, "completed");
    assert.equal(intercepted.jobId, "job-42");
    assert.equal(intercepted.width, 64);
    assert.equal(intercepted.content[0].text, "Generated knight sprite sheet");
    assert.equal(intercepted.content[1].assetSaved, true);
    assert.equal(intercepted.content[1].mimeType, "image/png");
    assert.match(intercepted.content[1].filePath, /^\.\/assets\/.*\.png$/);
    assert.equal(intercepted.content[2].assetSaved, true);
    assert.equal(intercepted.content[2].mimeType, "image/svg+xml");
    assert.match(intercepted.content[2].filePath, /^\.\/assets\/.*\.svg$/);
    assert.equal(intercepted.assetSummary.count, 2);

    const serialized = JSON.stringify(intercepted);
    assert.doesNotMatch(serialized, /iVBORw0KGgo/);
    assert.doesNotMatch(serialized, /data:image/);
  } finally {
    await tmp.cleanup();
  }
});

test("middleware handles inline data URIs in text without touching plain text strings", async () => {
  const tmp = await makeTempDir();
  try {
    const mw = createAssetInterceptorMiddleware({
      assetsDirectory: tmp.dir,
      filePathPrefix: "./assets",
      now: () => 1731609002000
    });

    const plainText = "x".repeat(2500);
    const untouched = await mw({ toolId: "logs.read" }, async () => plainText);
    assert.equal(untouched, plainText);

    const inlineText = `Sprite ready: ![knight](data:image/png;base64,${TINY_PNG_B64})`;
    const sanitized = await mw({ toolId: "sprite.text" }, async () => inlineText);
    assert.equal(sanitized.assetSaved, true);
    assert.equal(sanitized.assets.length, 1);
    assert.ok(sanitized.result.includes(sanitized.assets[0].filePath));
    assert.doesNotMatch(sanitized.result, /data:image/);
  } finally {
    await tmp.cleanup();
  }
});

test("ToolDispatcher runs asset middleware before capOutput and untrusted_data wrapping", async () => {
  const tmp = await makeTempDir();
  try {
    const registry = new ToolRegistry();
    const permissions = new PermissionStore({ dataDirectory: tmp.dir });
    const pending = new PendingActionStore({ dataDirectory: tmp.dir });
    const assetsDir = path.join(tmp.dir, "assets");
    const dispatcher = new ToolDispatcher({
      registry,
      permissionStore: permissions,
      pendingActionStore: pending,
      assetsDirectory: assetsDir,
      maxOutputChars: 2000
    });

    const largeFakePng = Buffer.concat([TINY_PNG_BUFFER, Buffer.alloc(3500, 0xaa)]);

    registry.register({
      id: "pixellab.render",
      name: "PixelLab Render",
      description: "Render pixel sprite",
      scope: "image:generate",
      risk: "read",
      trust: "external",
      network: true,
      externalAction: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({
        status: "completed",
        b64_json: largeFakePng.toString("base64")
      })
    });

    await permissions.grant("user-1", "image:generate");
    const dispatched = await dispatcher.dispatch({
      userId: "user-1",
      toolId: "pixellab.render",
      args: {},
      turnId: "turn-asset-1"
    });

    assert.equal(dispatched.status, "completed");
    assert.match(dispatched.result, /^<untrusted_data>/);
    assert.match(dispatched.result, /"assetSaved":true/);
    assert.match(dispatched.result, /\.\/assets\/pixellab_render-/);
    assert.doesNotMatch(dispatched.result, /"truncated":true/);

    const files = await fs.readdir(assetsDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".png"));
    const saved = await fs.readFile(path.join(assetsDir, files[0]));
    assert.deepEqual(saved, largeFakePng);
  } finally {
    await tmp.cleanup();
  }
});

test("AgentLoop stores compact JSON file references in chat history even when dispatcher returns raw base64", async () => {
  const tmp = await makeTempDir();
  try {
    const assetsDir = path.join(tmp.dir, "assets");
    const registry = new ToolRegistry();
    registry.register({
      id: "pixellab.tileset",
      name: "PixelLab Tileset",
      description: "Generate tileset",
      scope: "image:generate",
      risk: "read",
      trust: "internal",
      network: false,
      externalAction: false,
      handler: async () => ({ tileset: `data:image/png;base64,${TINY_PNG_B64}` })
    });

    const seenHistories = [];
    let turn = 0;
    const loop = new AgentLoop({
      providerRegistry: {
        complete: async (_config, messages) => {
          seenHistories.push(messages);
          turn += 1;
          if (turn === 1) {
            return {
              result: { content: JSON.stringify({ type: "tool_call", tool: "pixellab.tileset", arguments: {} }) },
              endpoint: { model: "qwen2.5-coder", provider: "ollama" }
            };
          }
          return {
            result: { content: JSON.stringify({ type: "final", message: "Tileset saved!" }) },
            endpoint: { model: "qwen2.5-coder", provider: "ollama" }
          };
        }
      },
      providerConfig: {},
      toolRegistry: registry,
      dispatcher: {
        permissionStore: { list: async () => ["image:generate"] },
        resetTurn() {},
        // Simulate raw un-intercepted base64 coming back from a custom bridge/dispatcher
        dispatch: async () => ({
          status: "completed",
          toolId: "pixellab.tileset",
          result: {
            jobId: "tile-99",
            tileset: `data:image/png;base64,${TINY_PNG_B64}`
          }
        })
      },
      contextAssembler: new ContextAssembler(),
      assetsDirectory: assetsDir
    });

    const result = await loop.run({
      userId: "user-1",
      messages: [{ role: "user", content: "Generate a dungeon tileset" }]
    });

    assert.equal(result.status, "completed");
    assert.equal(seenHistories.length, 2);

    const secondTurnMessages = seenHistories[1];
    const toolObsMsg = secondTurnMessages.find((m) => String(m.content).includes("tool_observation"));
    assert.ok(toolObsMsg, "Expected tool_observation message in second turn history");
    assert.doesNotMatch(toolObsMsg.content, /iVBORw0KGgo/);
    assert.doesNotMatch(toolObsMsg.content, /data:image/);

    const parsed = JSON.parse(toolObsMsg.content);
    assert.equal(parsed.tool_observation.result.jobId, "tile-99");
    assert.equal(parsed.tool_observation.result.tileset.assetSaved, true);
    assert.match(parsed.tool_observation.result.tileset.filePath, /^\.\/assets\/pixellab_tileset-.*\.png$/);
    assert.equal(parsed.tool_observation.result.assetSummary.count, 1);

    const files = await fs.readdir(assetsDir);
    assert.equal(files.length, 1);
  } finally {
    await tmp.cleanup();
  }
});

test("middleware defaults to local ./assets/ directory resolution", () => {
  const mw = createAssetInterceptorMiddleware();
  assert.equal(mw.assetsDirectory, path.resolve(process.cwd(), "assets"));
});
