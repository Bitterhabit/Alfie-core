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
    [/(?<![\w$.])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/, "shell/process execution"],
    [/\beval\s*\(/, "eval"],
    [/\bFunction\s*\(/, "dynamic Function construction"],
    [/from\s*["']node:vm["']|require\s*\(\s*["']node:vm["']\s*\)/, "Node VM execution"]
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relativePath = path.relative(sourceRoot, file);

    // The VRAM monitor has one narrowly scoped hardware probe: execFile runs
    // a fixed nvidia-smi binary with fixed read-only arguments and no shell.
    if (relativePath === path.join("system", "vramMonitor.mjs")) {
      assert.match(source, /import\s*\{\s*execFile\s*\}\s*from\s*["']node:child_process["']/);
      assert.match(source, /this\.execFileImpl\(\s*"nvidia-smi",\s*\[\s*"--query-gpu:name,memory\.used,memory\.total",\s*"--format=csv,noheader,nounits"/);
      assert.equal((source.match(/this\.execFileImpl\s*\(/g) || []).length, 1, "Only one fixed hardware probe is permitted.");
      assert.match(source, /timeout:\s*2500/);
      assert.match(source, /maxBuffer:\s*64\s*\*\s*1024/);
      assert.doesNotMatch(source, /shell:\s*true/);
      assert.doesNotMatch(source, /(?<![\w$.])(?:exec|execSync|execFileSync|spawn|spawnSync)\s*\(/);
      assert.doesNotMatch(source, /\beval\s*\(/);
      assert.doesNotMatch(source, /\bFunction\s*\(/);
      assert.doesNotMatch(source, /from\s*["']node:vm["']|require\s*\(\s*["']node:vm["']\s*\)/);
      continue;
    }

    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, label + " is forbidden in " + relativePath);
    }
  }
});
