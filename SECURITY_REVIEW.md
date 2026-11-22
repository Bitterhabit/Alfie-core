# Security Review & Hardening Notes

This document summarizes the security controls enforced across the standalone Alfie web interface (`interface/`) and local development runner (`server.mjs`).

## Applied Safeguards

1. **Authenticated & privately cached visual assets**
   - `GET /api/core/images/:filename` requires an active authenticated session (`requireSession`) and serves assets with `Cache-Control: private, max-age=86400, immutable` so generated images cannot be fetched anonymously or cached by shared proxies.
2. **Fail-secure session cookies**
   - `interface/src/server.mjs` defaults `ALFIE_UI_COOKIE_SECURE` to `true` (`!== "false"`).
   - Cookies use `HttpOnly`, `Path=/`, `Secure`, and `SameSite=Strict` by default (falling back to `SameSite=Lax` when `cookieSecure` is explicitly disabled for local HTTP development, and `SameSite=None; Secure; Partitioned` only when `ALFIE_UI_COOKIE_SAMESITE=none` is explicitly opted in).
3. **Strict origin & CSRF verification**
   - When `ALFIE_UI_PUBLIC_ORIGIN` is configured, state-changing requests must match it exactly.
   - When unset, `originAllowed` requires `https:` whenever `cookieSecure` is enabled, ignores `X-Forwarded-Host` unless `ALFIE_UI_TRUST_PROXY_HEADERS=true`, and rejects arbitrary localhost ports.
4. **Hardened HTTP response headers**
   - Defaults to `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none`, and a Content-Security-Policy with `script-src 'self'`, `frame-src 'none'`, `object-src 'none'`, and `frame-ancestors 'none'` (unless framing is explicitly opted in via `ALFIE_UI_ALLOW_IFRAME=true`).
5. **Password policy & credential hygiene**
   - New administrator accounts (`bootstrap`, `POST /api/auth/setup`, `changePassword`, `setPassword`, `ensureUser`) require 16–256 character passwords, while `login` retains compatibility with existing legacy accounts (`>= 6` characters) so users can sign in and rotate their password.
   - `server.mjs` generates ephemeral random 32-byte secrets when environment variables are absent, never seeds a hardcoded default password, and never prints plaintext passwords to logs.
   - `interface/public/index.html` no longer prefills a default username or displays default credentials.
   - Stale `cookies.txt` artifacts are removed.
6. **Static-shell-only service worker**
   - `interface/public/sw.js` caches static UI assets only and never caches or fabricates `/api/*` responses.

## Core Security & Reliability Hardening (`src/`)

1. **DNS-validated & connection-pinned HTTP watchers (`src/watchers/engine.mjs`)**
   - `http_probe` resolves target hostnames across all IPv4 and IPv6 records and fails closed if DNS fails, returns zero addresses, or if **any** resolved address is loopback, private (RFC 1918), CGNAT, link-local, metadata, multicast, unspecified, IPv4-mapped/transition IPv6, IANA special-purpose IPv6 (`2001::/23`), documentation, transition, or outside IANA Global Unicast (`2000::/3`).
   - Connections use native Node `http.request`/`https.request` with a pinned custom `lookup` callback returning only the already-validated `{ address, family }` — preventing DNS rebinding between validation and connect — while preserving `Host`, HTTPS SNI (`servername`), strict certificate/hostname verification (`rejectUnauthorized: true`), `agent: false`, strict 3xx redirect rejection, request timeouts, and bounded response draining (`64 KiB`).
2. **Accurate 4-state Action Receipt verification (`src/agent/toolDispatcher.mjs`, `src/agent/pendingActionStore.mjs`)**
   - Tools without a `verifyResult` hook default to `verified: false` (`verificationState: "unverified"`) with explicit copy stating execution succeeded without independent verification.
   - `verified: true` is recorded only when `verifyResult` runs and explicitly returns `{ verified: true }`, cleanly distinguishing `execution_failed`, `unverified`, `verification_failed`, and `verified`.
3. **Approval integrity via deterministic tool definition fingerprinting (`src/agent/toolDispatcher.mjs`, `src/agent/pendingActionStore.mjs`)**
   - Pending approvals persist a SHA-256 `toolFingerprint` over execution- and security-relevant tool metadata (`id`, `scope`, `risk`, `trust`, `network`, `externalAction`, `untrustedOutput`, `requiresApproval`, `approvalWhenUntrusted`, guard/verifier presence, and canonical `inputSchema`) including a SHA-256 hash of the handler source and explicit `implementationVersion`, while excluding cosmetic fields (`name`, `description`, `tags`).
   - Approval execution recomputes and compares the fingerprint and rejects mismatches with HTTP `409 STALE_APPROVAL` plus an audit log entry (`tool.approval_stale`).
4. **Per-project capability lease isolation (`src/permissions/store.mjs`)**
   - Capability leases are keyed by composite `(scope, projectId)` identity so global, Project A, and Project B grants coexist without silently clobbering one another.
   - Legacy `scopes`-only files migrate cleanly without widening modern project-scoped leases; `revoke(userId, scope)` revokes all grants for that scope while `revoke(userId, scope, { projectId })` revokes only the targeted project (or global when `projectId: null`).
5. **Strict watcher input validation & IANA timezone-aware quiet hours (`src/watchers/store.mjs`, `src/watchers/engine.mjs`)**
   - `enabled` and `quietHours.enabled` require strict JS booleans (rejecting `"false"`, `"true"`, `0`, `1`, `null`).
   - Quiet hours validate and persist canonical IANA timezone identifiers (defaulting explicitly to `"UTC"` for new and legacy records without guessing the host OS timezone) and evaluate wall-clock local time via native `Intl.DateTimeFormat`, handling DST transitions and overnight windows while keeping `urgent` alerts unblocked.


6. **Confined local-notes writes (`src/integrations/modularConnectors.mjs`)**
   - Note writes verify the parent directory remains inside the per-user workspace, reject symlink/non-file targets, open the final target with `O_NOFOLLOW`, and enforce `0600` permissions.
7. **Constant-work recovery-code checks (`interface/src/auth/store.mjs`)**
   - Recovery performs eight derivations/comparisons without early exit for known and unknown accounts; successful recovery consumes one code and revokes sessions.


8. **Explicit confirmation for destructive vault restores (`interface/public/app.js`, `interface/public/index.html`)**
   - Restore modes are described accurately. `replace` warns that local collections absent from the archive will be cleared, requires explicit confirmation, and applies the selected replace semantics; `merge` preserves local-only records.
9. **Hardened provider setup & model management (`src/providers/store.mjs`, `src/providers/registry.mjs`, `src/server.mjs`, `interface/src/server.mjs`)**
   - Provider endpoint mutations and connection tests require an authenticated session, signed Core identity, and CSRF/origin verification, and are never exposed as agent tools.
   - Endpoint URLs enforce strict `http:`/`https:` validation, reject embedded credentials, query/fragments, and redirects (`redirect: "error"`), permanently block cloud metadata/link-local/multicast destinations, and require explicit `trustedLocal: true` opt-in for localhost or private LAN endpoints (with DNS validation before outbound calls).
   - Optional endpoint API keys are encrypted at rest with AES-256-GCM + HKDF-SHA256 (bound to `(userId, endpointId)` AAD), redacted from upstream error messages and audit logs, and never returned to the browser. Every provider change and connection test is recorded in the user's audit log without invalidating or bypassing pending tool approvals.

## Forward-Looking Threat Model (Phase 4+)

1. **Persistent trust & taint provenance (`docs/adr/ADR-003-persistent-taint-provenance.md`)** — External payloads stored in memories, ideas, watcher events, or sub-agent artifacts carry durable `trust: "external_untrusted"` metadata so indirect prompt injection cannot be laundered across turns.
2. **Async job & multi-agent isolation (`docs/adr/ADR-004-async-job-engine-and-subagents.md`)** — Future background workers and specialist sub-agents must inherit per-role capability ceilings, token/time budgets, and persistent taint tracking.
