import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRoleHeading,
  formatExportTimestamp,
  sanitizeExportFilename,
  formatConversationMarkdown
} from "../public/markdown-export.mjs";

test("sanitizeExportFilename creates safe .md filenames from arbitrary conversation titles", () => {
  const fixedDate = new Date("2026-11-21T10:30:00.000Z");
  assert.equal(
    sanitizeExportFilename("Local Harness Refactor!", fixedDate),
    "local-harness-refactor-2026-11-21.md"
  );
  assert.equal(
    sanitizeExportFilename("../../etc/passwd?foo=bar", fixedDate),
    "etc-passwd-foo-bar-2026-11-21.md"
  );
  assert.equal(
    sanitizeExportFilename("   ", fixedDate),
    "alfie-conversation-2026-11-21.md"
  );
  assert.equal(
    sanitizeExportFilename("Café Résumé — Plan", fixedDate),
    "cafe-resume-plan-2026-11-21.md"
  );
  const longFilename = sanitizeExportFilename("a".repeat(120), fixedDate);
  assert.ok(longFilename.endsWith("-2026-11-21.md"));
  assert.ok(longFilename.length <= 75);
});

test("formatRoleHeading and formatExportTimestamp normalize labels and timestamps", () => {
  assert.equal(formatRoleHeading("user"), "You");
  assert.equal(formatRoleHeading("assistant"), "Alfie");
  assert.equal(formatRoleHeading("system"), "System");
  assert.equal(formatRoleHeading("reviewer"), "Reviewer");
  assert.equal(formatRoleHeading(""), "Message");

  assert.equal(formatExportTimestamp("2026-11-21T09:05:12.000Z"), "2026-11-21 09:05 UTC");
  assert.equal(formatExportTimestamp("not-a-date"), "");
  assert.equal(formatExportTimestamp(null), "");
});

test("formatConversationMarkdown exports full structured Markdown preserving code fences, metrics, project, and handoff context", () => {
  const exportedAt = new Date("2026-11-21T11:00:00.000Z");
  const md = formatConversationMarkdown({
    conversation: {
      title: "API Caching Architecture",
      handoffContext: "Continue migrating read-only routes to stale-while-revalidate."
    },
    project: { name: "Core Backend" },
    exportedAt,
    messages: [
      {
        role: "user",
        content: "Show me a minimal cache helper in JS.",
        createdAt: "2026-11-21T10:50:00.000Z"
      },
      {
        role: "assistant",
        content: "Here is a compact TTL cache:\n\n```js\nconst cache = new Map();\n```",
        createdAt: "2026-11-21T10:51:00.000Z",
        metrics: { model: "gemini-2.5-flash", latencyMs: 412.6, totalTokens: 148 },
        reaction: "up"
      }
    ]
  });

  assert.match(md, /^# API Caching Architecture\n/);
  assert.match(md, /- \*\*Exported:\*\* 2026-11-21 11:00 UTC/);
  assert.match(md, /- \*\*Project:\*\* Core Backend/);
  assert.match(md, /- \*\*Messages:\*\* 2/);
  assert.match(md, /## Carried-Over Context\n\nContinue migrating read-only routes/);
  assert.match(md, /## You — 2026-11-21 10:50 UTC\n\nShow me a minimal cache helper in JS\./);
  assert.match(md, /## Alfie — 2026-11-21 10:51 UTC/);
  assert.match(md, /> _Model: gemini-2\.5-flash · 413 ms · 148 tokens · Reaction: Helpful_/);
  assert.match(md, /```js\nconst cache = new Map\(\);\n```/);
  assert.ok(md.endsWith("\n"));
});

test("formatConversationMarkdown handles empty conversations safely", () => {
  const md = formatConversationMarkdown({
    conversation: null,
    messages: [],
    exportedAt: new Date("2026-11-21T11:00:00.000Z")
  });
  assert.match(md, /^# Alfie Conversation\n/);
  assert.match(md, /- \*\*Messages:\*\* 0/);
  assert.doesNotMatch(md, /## Carried-Over Context/);
});

test("formatConversationMarkdown exports UI like/flag reactions, working mode provenance, and project status", () => {
  const md = formatConversationMarkdown({
    conversation: { title: "Homelab Review" },
    project: { name: "Proxmox Core", status: "planning" },
    exportedAt: new Date("2026-11-21T12:00:00.000Z"),
    messages: [
      {
        role: "assistant",
        content: "Here is the backup architecture.",
        provenance: { workingMode: { id: "engineer", label: "Engineer" } },
        reaction: "like"
      },
      {
        role: "assistant",
        content: "Let us double-check the retention policy.",
        provenance: { workingMode: { id: "investigator", label: "Investigator" } },
        reaction: "flag"
      }
    ]
  });

  assert.match(md, /- \*\*Project:\*\* Proxmox Core \(planning\)/);
  assert.match(md, /> _Mode: Engineer · Reaction: Helpful_/);
  assert.match(md, /> _Mode: Investigator · Reaction: Flagged_/);
});
