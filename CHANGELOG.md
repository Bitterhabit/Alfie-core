# Changelog

All notable changes to Alfie Core and the standalone Interface are recorded here.

## [1.0.0] — V1 release candidate

This release brings Alfie Core and the standalone Interface to a complete, self-hostable V1 ready for live LLM endpoints.

### Provider Setup & Model Management
- Configure Ollama and OpenAI-compatible endpoints directly from **Settings → AI Providers** (add, edit, remove, enable/disable, priority, and default routing mode) without manually editing environment variables.
- Built-in **Test connection** action and live installed-model discovery with clear latency, availability, and error feedback.
- API keys are encrypted at rest (`ALFIE_PROVIDER_SECRET_KEY`), redacted from logs/errors, and never returned to the browser after saving.
- Strict endpoint URL and DNS pinning protection blocks cloud metadata and link-local destinations, requiring explicit trusted-local opt-in for private/LAN hosts.
- All configuration changes require an authenticated session + CSRF/Origin verification, are audited, and cannot be modified by model-generated tool calls.
- Preserves existing environment-based provider configuration and migration compatibility.

### ChatGPT-Like Memory & Adaptive Response Learning
- Automatic durable memory capture extracts lasting preferences, profile facts, project decisions, and explicit "remember" requests while blocking secrets, credentials, API keys, tokens, and passwords.
- Always-on recall merges keyword/FTS5 search with durable preferences and high-importance memories across turns.
- Inline **✦ Memory updated** disclosure beneath assistant replies with quick links to **Garden** and one-click **Forget**.
- Cross-session response style learning adapts to **👍 Like** / **🚩 Flag** reactions (conciseness, structure, walkthroughs, directness, examples, warmth), transparently applied to future turns with Settings toggles and **Reset learned style**.

### Alfie Soul, Petrio Themes & UI Polish
- Smooth mood transition animations (`data-mood`) and mood-reactive `.ambient` atmospheric gradients using CSS custom properties.
- Petrio Workspace Background selector (`Soft Nebula`, `Pixel City`, `Moonlit River`, `Zen Sanctuary`).
- Unified centered `1000px` layout rail across Ideas, Garden, Tools & access, and Settings, balanced 2×2 Chat starter prompts, single-line Chat context bar, and non-overlapping composer footer at `1440×900` and `1280×800`.

### Security, Reliability & Timeouts
- Harden approval fingerprints, watcher validation, safe local-note writes, and recovery flows.
- Pin validated provider DNS addresses for each request and reject redirects.
- Fail closed when model providers are unavailable; remove scripted assistant fallbacks and image-generation bypasses.
- Isolate job cancellation by user and prevent late results overwriting terminal states.
- Serialize watcher checks, metric ingestion, edits, and deletion per watcher.
- Restore encrypted Sovereign Vault backups atomically in SQLite WAL (with compensating rollback for JSON storage).
- Reserve authentication rate-limit attempts before expensive password/recovery verification.
- Reject malformed peer-token expiry values and exclude expired tokens from active-token capacity.
- Reverse-proxy HTTPS session cookies (`SameSite=None; Secure; Partitioned` when configured) and `ALFIE_UI_TRUST_PROXY_HEADERS` support.
- 30-minute turn wall-clock and local/OpenAI-compatible provider chat budgets, 35-minute Interface↔Core stream timeout with 15-second NDJSON keepalive heartbeats, immediate stream header flush & disconnect cancellation propagation, and 5-minute Cloud OpenAI adapter timeout.

### Build, Docker & CI
- Reproducible `npm ci` lockfile builds, full syntax checks across Core and standalone browser scripts, hardened `.dockerignore`, and non-root read-only containers in `compose.yaml`.
- Added `.github/workflows/docker-publish.yml` to build and publish `alfie-core` and `alfie-interface` images to GHCR on `v*.*.*` release tags or manual dispatch.

### Release cutover checklist (target host)
- Push branch/tag and confirm GitHub Actions (`ci.yml` + `docker-publish.yml`) pass cleanly.
- Configure production `.env` on the Proxmox/Docker host and bring up `docker compose up -d --build` (or pull from GHCR).
- Connect live Ollama / OpenAI-compatible LLM endpoints in **Settings**, test chat + automatic memory + tool approval flow.
- Rehearse one encrypted Sovereign Vault export/restore cycle, then tag `v1.0.0`.

## Earlier development

See the Git history and pull-request descriptions for the pre-1.0 development milestones.
