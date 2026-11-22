import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { registerModularConnectorTools } from "../src/integrations/modularConnectors.mjs";

test("notes.write refuses symlink targets and does not modify the linked file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-note-symlink-"));
  const userId = "test-user";
  const notesDir = path.join(root, "users", userId, "notes");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(outside, "outside-safe");
  await fs.symlink(outside, path.join(notesDir, "escape.txt"));

  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { dataDirectory: root });
  const tool = registry.tools.get("notes.write");

  await assert.rejects(
    tool.handler({ name: "escape.txt", content: "overwrite-attempt" }, { userId }),
    (error) => error.status === 403 || error.code === "ELOOP"
  );
  assert.equal(await fs.readFile(outside, "utf8"), "outside-safe");
  await fs.rm(root, { recursive: true, force: true });
});

test("notes.write creates confined notes with restrictive permissions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfie-note-write-"));
  const userId = "test-user";
  const registry = new ToolRegistry();
  registerModularConnectorTools(registry, { dataDirectory: root });
  const tool = registry.tools.get("notes.write");

  const result = await tool.handler({ name: "test-note", content: "hello" }, { userId });
  const file = path.join(root, "users", userId, "notes", "test-note.md");
  assert.equal(result.saved, true);
  assert.equal(await fs.readFile(file, "utf8"), "hello");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(root, { recursive: true, force: true });
});
