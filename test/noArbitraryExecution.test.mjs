import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

test("Core source contains no arbitrary shell, eval, or dynamic Function execution", async () => {
  const files = await sourceFiles(sourceRoot);
  assert.ok(files.length > 0, "Core source files must be discovered");

  const forbidden = [
    [/\bchild_process\b/, "child_process access"],
    [/(?<![\w$.])(?:exec|execSync|spawn|spawnSync)\s*\(/, "shell/process execution"],
    [/\beval\s*\(/, "eval"],
    [/\bFunction\s*\(/, "dynamic Function construction"],
    [/from\s*["']node:vm["']|require\s*\(\s*["']node:vm["']\s*\)/, "Node VM execution"]
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, `${label} is forbidden in ${path.relative(sourceRoot, file)}`);
    }
  }
});
