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

## Forward-Looking Threat Model (Phases 2–4)

Before enabling proactive watchers, external connectors, or background sub-agents, enforce these tracked controls:

1. **Persistent trust & taint provenance (`docs/adr/ADR-003-persistent-taint-provenance.md`)** — External payloads stored in memories, ideas, watcher events, or sub-agent artifacts must carry durable `trust: "external_untrusted"` metadata so indirect prompt injection cannot be laundered across turns.
2. **Connector SSRF & secret isolation (`docs/adr/ADR-002-deterministic-watchers-attention-budget.md`)** — Pull watchers and external connectors must reuse strict URL validation, private/metadata IP blocking, and server-side credential isolation completely inaccessible to LLM prompts.
3. **Capability leases & turn provenance** — Time- and task-bounded permission scopes plus per-turn context provenance inspection ensure standing privileges stay minimal and privacy redactions remain auditable.

