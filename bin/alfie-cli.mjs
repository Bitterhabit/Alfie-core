#!/usr/bin/env node
/**
 * Alfie Peer Quick-Capture CLI (Phase 6.3)
 *
 * Zero-dependency companion client communicating with Alfie Core / Interface
 * via a scoped personal Peer Token (`ALFIE_TOKEN` + `ALFIE_URL`).
 *
 * Usage:
 *   ALFIE_URL=http://localhost:3000 ALFIE_TOKEN=alf_... node bin/alfie-cli.mjs status
 *   ALFIE_URL=http://localhost:3000 ALFIE_TOKEN=alf_... node bin/alfie-cli.mjs capture idea "Explore local backup rotation"
 *   ALFIE_URL=http://localhost:3000 ALFIE_TOKEN=alf_... node bin/alfie-cli.mjs capture memory "Prefer WAL backups weekly"
 *   ALFIE_URL=http://localhost:3000 ALFIE_TOKEN=alf_... node bin/alfie-cli.mjs search "SQLite WAL"
 */

function printUsage() {
  console.log([
    "Alfie Peer Quick-Capture CLI",
    "",
    "Environment:",
    "  ALFIE_URL    Base URL of the Alfie Interface (default: http://127.0.0.1:3000)",
    "  ALFIE_TOKEN  Scoped personal Peer Token (alf_...)",
    "",
    "Commands:",
    "  status                       Check workspace status & peer token scopes",
    "  capture idea <text>          Park a quick idea in Ideas Vault (requires capture:write)",
    "  capture memory <text>        Plant a memory in The Garden (requires capture:write)",
    "  search <query>               Run hybrid FTS5 + semantic search (requires search:read)"
  ].join("\n"));
}

async function callPeer(baseUrl, token, pathName, options = {}) {
  const cleanBase = String(baseUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const endpoint = `${cleanBase}${pathName}`;
  const res = await fetch(endpoint, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }
  return payload;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printUsage();
    return 0;
  }

  const token = String(env.ALFIE_TOKEN || "").trim();
  const baseUrl = String(env.ALFIE_URL || "http://127.0.0.1:3000").trim();
  if (!token) {
    console.error("Error: Set ALFIE_TOKEN to a scoped personal Peer Token minted in Tools & Access.");
    return 1;
  }

  try {
    if (cmd === "status") {
      const data = await callPeer(baseUrl, token, "/api/peer/status");
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    if (cmd === "capture") {
      const kind = sub === "memory" ? "memory" : (sub === "idea" ? "idea" : "");
      const text = rest.join(" ").trim();
      if (!kind || !text) {
        console.error("Usage: alfie-cli capture <idea|memory> <text>");
        return 1;
      }
      const data = await callPeer(baseUrl, token, "/api/peer/capture", {
        method: "POST",
        body: { kind, text }
      });
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    if (cmd === "search") {
      const query = [sub, ...rest].filter(Boolean).join(" ").trim();
      if (!query) {
        console.error("Usage: alfie-cli search <query>");
        return 1;
      }
      const data = await callPeer(baseUrl, token, `/api/peer/search?q=${encodeURIComponent(query)}`);
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    console.error(`Unknown command "${cmd}". Run with --help for usage.`);
    return 1;
  } catch (error) {
    console.error(`Alfie CLI error: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
