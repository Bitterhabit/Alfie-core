import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { safeUserKey } from "../storage/userJsonStore.mjs";
import { registerWebResearchTools } from "./webResearch.mjs";

/**
 * Modular Integration Suite (Phase 3)
 *
 * Permissioned, schema-validated, dry-run-previewable connectors:
 *  1. Local Notes / Workspace Files connector: notes.list, notes.read, notes.write
 *     (strict path.resolve + path.sep + symlink confinement per user)
 *  2. Petrio write/draft adapters: petrio.mail.draft, petrio.calendar.create_event, petrio.journal.append
 *  3. GitHub read/draft connector: github.repo.inspect, github.issue.draft (pinned to api.github.com)
 *  4. Proxmox / Homelab read connector: proxmox.cluster.status
 */

const REPO_PATTERN = /^[a-zA-Z0-9_.-]{1,64}\/[a-zA-Z0-9_.-]{1,100}$/;
const NOTE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/;
const CONNECTOR_TIMEOUT_MS = 8000;

export function resolveConfinedNotePath(baseDir, relativeName) {
  const cleanRel = String(relativeName || "").trim().replace(/^\/+/, "");
  if (!cleanRel || !NOTE_NAME_PATTERN.test(cleanRel) || cleanRel.includes("..")) {
    throw Object.assign(new Error("Invalid note filename. Use letters, numbers, hyphens, underscores, or subfolders without '..'."), {
      status: 400,
      code: "INVALID_NOTE_PATH"
    });
  }
  const normalizedName = /\.(md|txt|json)$/i.test(cleanRel) ? cleanRel : `${cleanRel}.md`;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, normalizedName);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw Object.assign(new Error("Note path escaped workspace boundary."), {
      status: 403,
      code: "PATH_TRAVERSAL_BLOCKED"
    });
  }
  return { resolvedBase, resolvedTarget, normalizedName };
}

function notesDirectoryForUser(dataDirectory, userId) {
  const customRoot = String(process.env.ALFIE_LOCAL_NOTES_DIR || "").trim();
  return customRoot
    ? path.join(path.resolve(customRoot), safeUserKey(userId))
    : path.join(path.resolve(dataDirectory), "users", safeUserKey(userId), "notes");
}

export function getModularIntegrationsStatus({ petrioHarnessClient = null, env = process.env } = {}) {
  return [
    {
      id: "local_notes",
      name: "Local Notes & Workspace Files",
      category: "notes",
      configured: true,
      mode: "confined-per-user",
      scopes: ["notes:read", "notes:write"],
      tools: ["notes.list", "notes.read", "notes.write"],
      description: "Read and draft/write Markdown notes strictly confined to your per-user Alfie notes directory."
    },
    {
      id: "petrio_write",
      name: "Petrio Write & Draft Adapters",
      category: "petrio",
      configured: Boolean(petrioHarnessClient?.enabled),
      mode: petrioHarnessClient?.enabled ? "connected" : "awaiting-env",
      requiredEnv: ["ALFIE_PETRIO_ADAPTER_URL", "ALFIE_CORE_SERVICE_TOKEN"],
      scopes: ["mail:draft", "calendar:write", "journal:write"],
      tools: ["petrio.mail.draft", "petrio.calendar.create_event", "petrio.journal.append"],
      description: "Approval-gated mail drafting, calendar event creation, and journal entry appending via Petrio."
    },
    {
      id: "github",
      name: "GitHub Repositories & Issues",
      category: "developer",
      configured: Boolean(env.ALFIE_GITHUB_TOKEN),
      mode: env.ALFIE_GITHUB_TOKEN ? "token-configured" : "public-read-only",
      requiredEnv: ["ALFIE_GITHUB_TOKEN"],
      scopes: ["github:read", "github:draft"],
      tools: ["github.repo.inspect", "github.issue.draft"],
      description: "Inspect repository health/open issues and prepare approval-gated issue drafts (pinned to api.github.com)."
    },
    {
      id: "proxmox",
      name: "Proxmox / Homelab Cluster",
      category: "homelab",
      configured: Boolean(env.ALFIE_PROXMOX_API_URL && env.ALFIE_PROXMOX_API_TOKEN),
      mode: (env.ALFIE_PROXMOX_API_URL && env.ALFIE_PROXMOX_API_TOKEN) ? "connected" : "awaiting-env",
      requiredEnv: ["ALFIE_PROXMOX_API_URL", "ALFIE_PROXMOX_API_TOKEN"],
      scopes: ["homelab:read"],
      tools: ["proxmox.cluster.status"],
      description: "Read-only Proxmox VE cluster node and VM/LXC resource snapshot via scoped API token."
    },
    {
      id: "web_research",
      name: "Web Search & Research",
      category: "research",
      configured: Boolean(String(env.ALFIE_SEARXNG_URL || "").trim() || String(env.ALFIE_BRAVE_SEARCH_API_KEY || "").trim()),
      mode: (() => {
        const hasSearxng = Boolean(String(env.ALFIE_SEARXNG_URL || "").trim());
        const hasBrave = Boolean(String(env.ALFIE_BRAVE_SEARCH_API_KEY || "").trim());
        if (hasSearxng && hasBrave) return "searxng+brave";
        if (hasSearxng) return "searxng";
        if (hasBrave) return "configured";
        return "awaiting-api-key";
      })(),
      requiredEnv: ["ALFIE_SEARXNG_URL", "ALFIE_BRAVE_SEARCH_API_KEY"],
      scopes: ["web:read"],
      tools: ["web.search", "web.open", "web.research", "web.weather"],
      description: "Fast direct live weather via Open-Meteo plus public web search via private SearXNG or Brave Search with private-network protections and untrusted-source handling."
    }
  ];
}

export function registerModularConnectorTools(
  registry,
  {
    dataDirectory = process.env.ALFIE_CORE_DATA_DIR || "/data",
    petrioHarnessClient = null,
    fetchImpl = globalThis.fetch,
    profileStore = null
  } = {}
) {
  // ── 1. Local Notes & Workspace Files (Always Available, Strictly Confined) ──
  registry.register({
    id: "notes.list",
    name: "List local notes",
    description: "List Markdown and text notes inside the user's confined Alfie notes workspace.",
    scope: "notes:read",
    risk: "read",
    trust: "internal",
    network: false,
    externalAction: false,
    tags: ["notes", "files", "markdown", "list", "workspace"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 100 }
      },
      additionalProperties: false
    },
    async handler(args = {}, { userId } = {}) {
      const dir = notesDirectoryForUser(dataDirectory, userId);
      const q = String(args.query || "").trim().toLowerCase();
      const entries = [];
      try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (!item.isFile() || item.isSymbolicLink()) continue;
          if (!/\.(md|txt|json)$/i.test(item.name)) continue;
          if (q && !item.name.toLowerCase().includes(q)) continue;
          const st = await fs.stat(path.join(dir, item.name));
          entries.push({ name: item.name, sizeBytes: st.size, updatedAt: st.mtime.toISOString() });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { notes: entries.slice(0, 100), total: entries.length };
    }
  });

  registry.register({
    id: "notes.read",
    name: "Read local note",
    description: "Read a single Markdown or text note inside the user's confined Alfie notes workspace.",
    scope: "notes:read",
    risk: "read",
    trust: "internal",
    network: false,
    externalAction: false,
    tags: ["notes", "files", "read", "markdown"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 }
      },
      required: ["name"],
      additionalProperties: false
    },
    async handler(args, { userId }) {
      const dir = notesDirectoryForUser(dataDirectory, userId);
      const { resolvedBase, resolvedTarget, normalizedName } = resolveConfinedNotePath(dir, args.name);
      const lstat = await fs.lstat(resolvedTarget).catch((err) => {
        if (err.code === "ENOENT") throw Object.assign(new Error("Note not found."), { status: 404 });
        throw err;
      });
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw Object.assign(new Error("Symlinks and directories cannot be read as notes."), { status: 403 });
      }
      const realBase = await fs.realpath(resolvedBase);
      const realTarget = await fs.realpath(resolvedTarget);
      if (!realTarget.startsWith(realBase + path.sep)) {
        throw Object.assign(new Error("Resolved note path escaped workspace boundary."), { status: 403 });
      }
      const content = await fs.readFile(realTarget, "utf8");
      return { name: normalizedName, content: content.slice(0, 16000), truncated: content.length > 16000 };
    }
  });

  registry.register({
    id: "notes.write",
    name: "Write local note",
    description: "Create or update a Markdown note inside the user's confined Alfie notes workspace (approval-gated).",
    scope: "notes:write",
    risk: "write",
    trust: "internal",
    network: false,
    externalAction: false,
    tags: ["notes", "files", "write", "markdown", "save"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        content: { type: "string", minLength: 1, maxLength: 20000 }
      },
      required: ["name", "content"],
      additionalProperties: false
    },
    approvalPreview(args) {
      return `Write note "${args.name}" (${String(args.content || "").length} chars)`;
    },
    dryRun(args) {
      return {
        risk: "write",
        affectedResource: `local_note:${args.name}`,
        reversible: true,
        backupAvailable: true,
        rollbackPlan: `Overwrite or remove ${args.name} in the confined per-user notes directory.`,
        validationSteps: ["Confirm file exists inside confined user notes directory with 0o600 permissions", "Verify written byte length matches input"]
      };
    },
    async handler(args, { userId }) {
      const dir = notesDirectoryForUser(dataDirectory, userId);
      const { resolvedBase, resolvedTarget, normalizedName } = resolveConfinedNotePath(dir, args.name);
      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
      const realBase = await fs.realpath(resolvedBase);
      const realParent = await fs.realpath(path.dirname(resolvedTarget));
      if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
        throw Object.assign(new Error("Note target directory escaped workspace boundary."), { status: 403 });
      }
      const content = String(args.content || "");
      // Reject existing symlinks and use O_NOFOLLOW so the final path component
      // cannot be swapped to a symlink between validation and open.
      const existing = await fs.lstat(resolvedTarget).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw Object.assign(new Error("Note target must be a regular file, not a symlink or directory."), { status: 403 });
      }
      let handle;
      try {
        handle = await fs.open(
          resolvedTarget,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
          0o600
        );
        await handle.writeFile(content, "utf8");
        await handle.chmod(0o600);
      } catch (error) {
        if (error.code === "ELOOP") {
          throw Object.assign(new Error("Symlink note targets are blocked."), { status: 403 });
        }
        throw error;
      } finally {
        await handle?.close();
      }
      return { saved: true, name: normalizedName, bytes: Buffer.byteLength(content, "utf8") };
    },
    async verifyResult(args, result, { userId }) {
      const dir = notesDirectoryForUser(dataDirectory, userId);
      const { resolvedTarget } = resolveConfinedNotePath(dir, args.name);
      const st = await fs.stat(resolvedTarget);
      const ok = st.isFile() && st.size === result.bytes;
      return { verified: ok, detail: ok ? `Confirmed ${result.name} persisted (${st.size} bytes).` : "Persisted file size mismatch." };
    }
  });

  // ── 2. Petrio Write & Draft Adapters (Approval-Gated) ──
  registry.register({
    id: "petrio.mail.draft",
    name: "Draft Petrio email",
    description: "Create a reviewable email draft in Petrio Mail (never sends directly without explicit review).",
    scope: "mail:draft",
    risk: "draft",
    trust: "external",
    network: false,
    externalAction: true,
    tags: ["petrio", "mail", "email", "draft"],
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", minLength: 3, maxLength: 160 },
        subject: { type: "string", minLength: 1, maxLength: 180 },
        body: { type: "string", minLength: 1, maxLength: 8000 }
      },
      required: ["to", "subject", "body"],
      additionalProperties: false
    },
    approvalPreview(args) {
      return `Draft email to ${args.to}: "${args.subject}"`;
    },
    dryRun(args) {
      return {
        risk: "draft",
        affectedResource: `petrio:mail:draft:${args.to}`,
        reversible: true,
        rollbackPlan: "Delete the unsent draft in Petrio Mail.",
        validationSteps: ["Confirm draft saved in Petrio Mail without sending"]
      };
    },
    async handler(args, { userId }) {
      if (!petrioHarnessClient?.enabled) {
        return {
          status: "local_draft_staged",
          note: "Petrio adapter URL is not configured; draft prepared locally for copy/paste.",
          draft: { to: args.to, subject: args.subject, body: args.body }
        };
      }
      return petrioHarnessClient.runTool(userId, "petrio.mail.draft", args);
    }
  });

  registry.register({
    id: "petrio.calendar.create_event",
    name: "Create Petrio calendar event",
    description: "Create an approval-gated calendar event in Petrio Calendar.",
    scope: "calendar:write",
    risk: "write",
    trust: "external",
    network: false,
    externalAction: true,
    tags: ["petrio", "calendar", "event", "schedule", "write"],
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        startTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
        durationMinutes: { type: "integer", minimum: 5, maximum: 480 },
        notes: { type: "string", maxLength: 1000 }
      },
      required: ["title", "date"],
      additionalProperties: false
    },
    approvalPreview(args) {
      return `Create calendar event "${args.title}" on ${args.date}${args.startTime ? ` at ${args.startTime}` : ""}`;
    },
    dryRun(args) {
      return {
        risk: "write",
        affectedResource: `petrio:calendar:${args.date}`,
        reversible: true,
        rollbackPlan: "Delete the created event in Petrio Calendar.",
        validationSteps: ["Confirm event appears on target date"]
      };
    },
    async handler(args, { userId }) {
      if (!petrioHarnessClient?.enabled) {
        throw Object.assign(new Error("Petrio adapter is not configured (set ALFIE_PETRIO_ADAPTER_URL)."), { status: 503 });
      }
      return petrioHarnessClient.runTool(userId, "petrio.calendar.create_event", args);
    }
  });

  registry.register({
    id: "petrio.journal.append",
    name: "Append Petrio journal entry",
    description: "Append a timestamped reflection or note to Petrio Journal (approval-gated).",
    scope: "journal:write",
    risk: "write",
    trust: "external",
    network: false,
    externalAction: true,
    tags: ["petrio", "journal", "write", "reflection"],
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        body: { type: "string", minLength: 1, maxLength: 8000 }
      },
      required: ["title", "body"],
      additionalProperties: false
    },
    approvalPreview(args) {
      return `Append journal entry "${args.title}"`;
    },
    dryRun(args) {
      return {
        risk: "write",
        affectedResource: `petrio:journal:${args.title}`,
        reversible: true,
        rollbackPlan: "Edit or remove the appended journal entry in Petrio.",
        validationSteps: ["Confirm journal entry ID returned by Petrio"]
      };
    },
    async handler(args, { userId }) {
      if (!petrioHarnessClient?.enabled) {
        throw Object.assign(new Error("Petrio adapter is not configured (set ALFIE_PETRIO_ADAPTER_URL)."), { status: 503 });
      }
      return petrioHarnessClient.runTool(userId, "petrio.journal.append", args);
    }
  });

  // ── 3. GitHub Read/Draft Connector (Pinned to https://api.github.com) ──
  registry.register({
    id: "github.repo.inspect",
    name: "Inspect GitHub repository",
    description: "Read repository status, stars, open issues count, and recent issues from api.github.com.",
    scope: "github:read",
    risk: "read",
    trust: "external",
    network: true,
    externalAction: false,
    untrustedOutput: true,
    tags: ["github", "repo", "issues", "code", "git"],
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", minLength: 3, maxLength: 165 }
      },
      required: ["repo"],
      additionalProperties: false
    },
    async handler(args) {
      const repo = String(args.repo || "").trim();
      if (!REPO_PATTERN.test(repo)) {
        throw Object.assign(new Error("Repository must match owner/repo format."), { status: 400 });
      }
      const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "alfie-core/0.3"
      };
      if (process.env.ALFIE_GITHUB_TOKEN) {
        headers.authorization = `Bearer ${process.env.ALFIE_GITHUB_TOKEN}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
      try {
        const url = new URL(`/repos/${repo}`, "https://api.github.com");
        const res = await fetchImpl(url, { headers, redirect: "error", signal: controller.signal });
        if (!res.ok) throw Object.assign(new Error(`GitHub API returned ${res.status}.`), { status: 502 });
        const data = await res.json();
        return {
          trust: "external_untrusted",
          fullName: data.full_name,
          description: String(data.description || "").slice(0, 300),
          defaultBranch: data.default_branch,
          openIssues: Number(data.open_issues_count || 0),
          pushedAt: data.pushed_at,
          private: Boolean(data.private)
        };
      } finally {
        clearTimeout(timer);
      }
    }
  });

  registry.register({
    id: "github.issue.draft",
    name: "Draft GitHub issue",
    description: "Prepare an approval-gated GitHub issue draft (creates issue only when ALFIE_GITHUB_TOKEN is configured and approved).",
    scope: "github:draft",
    risk: "draft",
    trust: "external",
    network: true,
    externalAction: true,
    tags: ["github", "issue", "draft", "bug", "feature"],
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", minLength: 3, maxLength: 165 },
        title: { type: "string", minLength: 1, maxLength: 180 },
        body: { type: "string", minLength: 1, maxLength: 8000 }
      },
      required: ["repo", "title", "body"],
      additionalProperties: false
    },
    approvalPreview(args) {
      return `Draft GitHub issue on ${args.repo}: "${args.title}"`;
    },
    dryRun(args) {
      return {
        risk: "draft",
        affectedResource: `github:${args.repo}:issue`,
        reversible: true,
        rollbackPlan: "Close or edit the issue on GitHub.",
        validationSteps: ["Confirm issue title and repo match owner/repo pattern"]
      };
    },
    async handler(args) {
      const repo = String(args.repo || "").trim();
      if (!REPO_PATTERN.test(repo)) {
        throw Object.assign(new Error("Repository must match owner/repo format."), { status: 400 });
      }
      if (!process.env.ALFIE_GITHUB_TOKEN) {
        return {
          status: "local_draft_staged",
          repo,
          title: args.title,
          body: args.body,
          note: "Set ALFIE_GITHUB_TOKEN on the server to publish approved drafts directly to GitHub."
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
      try {
        const url = new URL(`/repos/${repo}/issues`, "https://api.github.com");
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            authorization: `Bearer ${process.env.ALFIE_GITHUB_TOKEN}`,
            "user-agent": "alfie-core/0.3"
          },
          body: JSON.stringify({ title: args.title, body: args.body }),
          redirect: "error",
          signal: controller.signal
        });
        if (!res.ok) throw Object.assign(new Error(`GitHub issue creation failed (${res.status}).`), { status: 502 });
        const created = await res.json();
        return { created: true, number: created.number, htmlUrl: created.html_url };
      } finally {
        clearTimeout(timer);
      }
    }
  });

  registerWebResearchTools(registry, { fetchImpl, profileStore });

  // ── 4. Proxmox / Homelab Read Connector ──
  registry.register({
    id: "proxmox.cluster.status",
    name: "Proxmox cluster status",
    description: "Read-only Proxmox VE cluster nodes and VM/LXC health snapshot via server-configured token.",
    scope: "homelab:read",
    risk: "read",
    trust: "external",
    network: true,
    externalAction: false,
    tags: ["proxmox", "homelab", "cluster", "vm", "lxc", "nodes", "storage"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async handler() {
      const baseUrl = String(process.env.ALFIE_PROXMOX_API_URL || "").trim();
      const token = String(process.env.ALFIE_PROXMOX_API_TOKEN || "").trim();
      if (!baseUrl || !token) {
        throw Object.assign(
          new Error("Proxmox connector is not configured (set ALFIE_PROXMOX_API_URL and ALFIE_PROXMOX_API_TOKEN on the server)."),
          { status: 503 }
        );
      }
      const target = new URL("/api2/json/cluster/resources", baseUrl);
      const targetHost = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
        throw Object.assign(new Error("Invalid Proxmox API URL scheme or embedded credentials."), { status: 400 });
      }
      if (["169.254.169.254", "100.100.100.200", "metadata.google.internal", "metadata.goog"].includes(targetHost)) {
        throw Object.assign(new Error("Proxmox API URL cannot target cloud metadata endpoints."), { status: 400 });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
      try {
        const res = await fetchImpl(target, {
          headers: { authorization: `PVEAPIToken=${token}` },
          redirect: "error",
          signal: controller.signal
        });
        if (!res.ok) throw Object.assign(new Error(`Proxmox API returned ${res.status}.`), { status: 502 });
        const payload = await res.json();
        const items = Array.isArray(payload?.data) ? payload.data : [];
        return {
          trust: "system_verified",
          nodes: items.filter((i) => i.type === "node").map((n) => ({
            node: n.node, status: n.status, cpu: n.cpu, mem: n.mem, maxmem: n.maxmem
          })),
          guests: items.filter((i) => i.type === "qemu" || i.type === "lxc").slice(0, 40).map((g) => ({
            vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status
          }))
        };
      } finally {
        clearTimeout(timer);
      }
    }
  });
}
