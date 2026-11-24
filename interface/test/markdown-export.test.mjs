import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRoleHeading,
  formatExportTimestamp,
  sanitizeExportFilename,
  formatConversationMarkdown,
  parseDossierLines,
  parseDossierDecisions,
  sanitizeDossierExportFilename,
  buildProjectDossierSnapshot,
  formatProjectDossierJson,
  formatProjectDossierMarkdown
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

test("sanitizeDossierExportFilename creates safe .md and .json filenames", () => {
  const fixedDate = new Date("2026-11-24T14:20:00.000Z");
  assert.equal(
    sanitizeDossierExportFilename("Local Harness Refactor!", "json", fixedDate),
    "local-harness-refactor-dossier-2026-11-24.json"
  );
  assert.equal(
    sanitizeDossierExportFilename("Local Harness Refactor!", "md", fixedDate),
    "local-harness-refactor-dossier-2026-11-24.md"
  );
  assert.equal(
    sanitizeDossierExportFilename("../../secrets?raw=1", "json", fixedDate),
    "secrets-raw-1-dossier-2026-11-24.json"
  );
  assert.equal(
    sanitizeDossierExportFilename("   ", "md", fixedDate),
    "project-dossier-2026-11-24.md"
  );
});

test("parseDossierLines and parseDossierDecisions normalize textarea inputs cleanly", () => {
  assert.deepEqual(
    parseDossierLines("- Migrate to SQLite WAL\n* Verify adapters\nMigrate to SQLite WAL\n\n  • Add backup script  "),
    ["Migrate to SQLite WAL", "Verify adapters", "Add backup script"]
  );
  assert.deepEqual(
    parseDossierDecisions("Keep Core in Node.js — Single authoritative owner\nUse WAL mode | Better read concurrency\nSolo decision"),
    [
      { summary: "Keep Core in Node.js", rationale: "Single authoritative owner" },
      { summary: "Use WAL mode", rationale: "Better read concurrency" },
      { summary: "Solo decision", rationale: "" }
    ]
  );
});

test("formatProjectDossierJson and formatProjectDossierMarkdown export structured notes, architecture constraints, decisions, and action lists", () => {
  const exportedAt = new Date("2026-11-24T15:00:00.000Z");
  const sampleDossier = {
    id: "proj-1234",
    name: "Homelab Core",
    status: "active",
    color: "cyan",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-24T14:30:00.000Z",
    vision: "Zero-downtime local AI workspace with strict privacy boundaries.",
    description: "Primary notes carried across all homelab chats.",
    architecture: "Node.js Core on 127.0.0.1:8780; SQLite WAL storage; no external telemetry.",
    decisions: "Keep Core in Node.js — Single runtime for memory and approvals\nSQLite WAL | Local-first durability",
    nextActions: "Add automated snapshots\nVerify restore script",
    blockers: "Waiting on UPS battery replacement",
    postponed: "Cluster failover until single-node benchmarks finish"
  };

  const jsonText = formatProjectDossierJson(sampleDossier, { exportedAt });
  assert.ok(jsonText.endsWith("\n"));
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.schema, "alfie.project-dossier.v1");
  assert.equal(parsed.exportedAt, "2026-11-24T15:00:00.000Z");
  assert.equal(parsed.project.id, "proj-1234");
  assert.equal(parsed.project.name, "Homelab Core");
  assert.equal(parsed.project.notes, "Primary notes carried across all homelab chats.");
  assert.equal(parsed.project.architectureConstraints, "Node.js Core on 127.0.0.1:8780; SQLite WAL storage; no external telemetry.");
  assert.equal(parsed.project.decisions.length, 2);
  assert.deepEqual(parsed.project.decisions[0], {
    summary: "Keep Core in Node.js",
    rationale: "Single runtime for memory and approvals"
  });
  assert.deepEqual(parsed.project.nextActions, ["Add automated snapshots", "Verify restore script"]);
  assert.deepEqual(parsed.project.blockers, ["Waiting on UPS battery replacement"]);
  assert.deepEqual(parsed.project.postponed, ["Cluster failover until single-node benchmarks finish"]);

  const md = formatProjectDossierMarkdown(sampleDossier, { exportedAt });
  assert.match(md, /^# Homelab Core — Project Dossier\n/);
  assert.match(md, /- \*\*Status:\*\* active/);
  assert.match(md, /- \*\*Exported:\*\* 2026-11-24 15:00 UTC/);
  assert.match(md, /- \*\*Project ID:\*\* `proj-1234`/);
  assert.match(md, /## Vision & Objective\n\nZero-downtime local AI workspace/);
  assert.match(md, /## Project Notes\n\nPrimary notes carried across all homelab chats\./);
  assert.match(md, /## Architecture & Constraints\n\nNode\.js Core on 127\.0\.0\.1:8780/);
  assert.match(md, /## Key Decisions\n\n- \*\*Keep Core in Node\.js\*\* — Single runtime for memory and approvals/);
  assert.match(md, /## Next Actions\n\n- \[ \] Add automated snapshots\n- \[ \] Verify restore script/);
  assert.match(md, /## Blockers\n\n- Waiting on UPS battery replacement/);
  assert.match(md, /## Deliberately Postponed\n\n- Cluster failover until single-node benchmarks finish/);

  // Empty dossier renders a graceful placeholder instead of broken sections
  const emptySnapshot = buildProjectDossierSnapshot({ name: "Empty Project" }, { exportedAt });
  assert.equal(emptySnapshot.project.name, "Empty Project");
  const emptyMd = formatProjectDossierMarkdown({ name: "Empty Project" }, { exportedAt });
  assert.match(emptyMd, /No dossier notes, architecture constraints, or decisions recorded yet/);
});

