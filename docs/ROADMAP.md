# Alfie — Phased Roadmap

This roadmap balances ambition with architectural discipline: Alfie's core harness remains lean, auditable, and self-hostable at every milestone.

---

## Phase 1: Foundation & Harness Hardening *(Complete — 100%)*

- **Pre-Release Hardening & Standalone Account Recovery *(Shipped)*:** Independent security audit hardening (DNS-pinned SSRF protection, tool-definition approval fingerprinting, accurate action receipt verification, project-isolated capability leases, strict watcher booleans, IANA timezone quiet hours) plus single-use `scrypt`-hashed account recovery codes.
- **Turn Provenance & Context Inspector *(Shipped)*:** Surface exact per-turn context (active mode, project dossier, memories injected, tools shortlisted/used, taint status, cloud privacy filtering) under assistant replies.
- **Composable Prompt Assembly *(Shipped)*:** Modularize `ContextAssembler` into identity, working mode, project dossier, learning posture, and privacy posture blocks.
- **Embedded SQLite (WAL Mode) Storage & FTS5 (`ADR-001`) *(Shipped)*:** Per-user isolated SQLite WAL databases via Node 22 built-in `node:sqlite`, versioned `schema_migrations`, parameterized FTS5 full-text indexing, graph edge table, and lossless automatic migration from legacy flat JSON files (with safe `ALFIE_STORAGE_BACKEND=json` rollback).

## Phase 2: Near-Term Continuity & Low-Context Leverage *(Complete — 100%)*

- **Living Project Dossiers *(Shipped)*:** Structured project records (status, vision, architecture, key decisions with rationale, blockers, next actions, postponed work) injected automatically into chat context, in-chat Dossier button, and conversation handoffs.
- **Adaptive Working Modes *(Shipped)*:** 8 selectable behavioural postures (`Companion`, `Engineer`, `Investigator`, `Researcher`, `Planner`, `Thinking Partner`, `Creator`, `Tutor`) that shape tone, depth, and rigour without escalating tool permissions.
- **Ideas Vault & Frictionless Capture *(Shipped)*:** Zero-friction idea parking (`/idea` in chat or dedicated Ideas Vault view) with automatic `#hashtag` extraction, clickable hashtag & project filters, inline editing, priority/status lifecycle (`inbox`, `active`, `parked`, `promoted`, `archived`), and one-click Explore in chat.
- **Capability Leases *(Shipped)*:** Optional time-bounded (`ttlMinutes` / `expiresAt`) and project-bounded (`projectId`) permission grants in `PermissionStore` and `ToolDispatcher` with automatic expiry enforcement and multi-project lease coexistence.
- **Hybrid Semantic Retrieval & Python Worker v1 *(Shipped)*:** Reciprocal Rank Fusion combining SQLite FTS5 lexical retrieval with local semantic vector scoring and an optional stateless Python embedding worker (`workers/embedding_worker.py` via `ALFIE_EMBEDDING_WORKER_URL`).

## Phase 3: Medium-Term Situational & Operational Power *(Complete — 100%)*

- **Typed Memory v2 & Persistent Trust Provenance (`ADR-003`) *(Shipped)*:** First-class schemas for `fact`, `decision`, `preference`, `temporary` (with TTL/expiry), `lesson`, and `note` memories, archiving/restoring, and persisted `trust` tiers (`user_authored`, `system_verified`, `external_untrusted`) preserved through `ContextAssembler` and Turn Provenance.
- **Deterministic Watcher Framework & 4-Tier Attention Budget (`ADR-002`) *(Shipped)*:** Per-user deterministic watchers (`project_stall`, `vram_threshold`, `push_metric`, DNS-pinned `http_probe`) with zero LLM calls, cooldown deduplication, IANA timezone-aware quiet-hours downgrading, and a 4-tier Attention Feed (`quiet_log`, `digest`, `notify`, `urgent`).
- **Context Capsules *(Shipped)*:** Switchable workspaces binding Project Dossier + Working Mode + Learning Posture + Privacy Posture + Capability Lease templates with atomic one-click activation.
- **Modular Integration Suite *(Shipped)*:** Schema-validated, scope-gated connectors with dry-run previews and action receipts for Local Notes (`notes.list`/`read`/`write` with strict path confinement), Petrio drafts & calendar (`petrio.mail.draft`, `petrio.calendar.create_event`, `petrio.journal.append`), GitHub (`github.repo.inspect`, `github.issue.draft`), and Proxmox homelab (`proxmox.cluster.status`).
- **Simulation, Dry-Run & Action Receipts *(Shipped)*:** Structured pre-execution impact previews (risk, affected resource, dependencies, backup flag, rollback plan, validation steps) and persisted post-execution verified Action Receipts on approval-gated tools.
- **Learning Companion & Inspectable Workflow Profile *(Shipped)*:** Transparent, user-editable working preferences (explanation depth, change style, interruption tolerance, chunk size, custom notes), qualitative non-graded learning topics, and study postures (`Solve it`, `Explain as you go`, `Tutor me`, `Challenge me`, `Attempt first`).

## Phase 4: Long-Term Ambitious Capabilities *(Complete — 100%)*

- **Async Job & Workflow Engine (`ADR-004`) *(Shipped)*:** Durable per-user job store (`queued -> running -> awaiting_approval -> completed | failed | cancelled`) with checkpoints, VRAM pre-checks, cancellation, and audit logging.
- **Split-Brain Privacy Broker *(Shipped)*:** Reversible sanitization airlock stripping API tokens, emails, RFC1918 IPs, local hosts, file paths, phone numbers, and custom private terms into `[CATEGORY_N]` placeholders before external cloud routing, with round-trip local rehydration and an interactive Settings previewer.
- **Bounded Multi-Agent Workshop (`ADR-004`) *(Shipped)*:** Specialist delegation roles (`researcher`, `auditor`, `planner`, `developer`) bound to `role.allowedScopes ∩ userGrantedScopes` capability ceilings and persistent `ADR-003` taint propagation.
- **Unified Knowledge Graph & Visual Explorer *(Shipped)*:** Deterministic cross-entity graph (`GET /v1/graph`) linking Projects, Decisions, Memories, Ideas, Hashtags, Capsules, Watchers, and Learning Topics with multi-hop neighborhood inspection, preserved trust provenance (`ADR-003`), and an interactive SVG explorer in The Garden.
- **Local/Hybrid Voice Loop *(Shipped)*:** Strictly push-to-talk (hotword permanently disabled) voice loop supporting optional local Whisper STT (`ALFIE_WHISPER_URL`) and local TTS (`ALFIE_TTS_URL`) with interruptible playback and seamless browser Web Speech API fallback.

## Phase 5: Experimental & Capstone Explorations *(Complete — 100%)*

- **Alfie's Optional Virtual Room *(Shipped)*:** Strictly opt-in `<details>` ambient SVG study diorama in The Garden reflecting live Core state (time of day, Soul mood, focal project, memory/idea bookshelves, homelab watcher/VRAM rack) with clickable navigation back to Core views.
- **Life Continuity & Periodic Reflections *(Shipped)*:** Local-only deterministic weekly & monthly continuity digests tracking active projects, decisions, blockers, ideas, and learning growth with SQLite WAL snapshot archiving.
- **Ambient Hardware Bridges *(Shipped)*:** Deterministic presence state projections (`GET /v1/ambient/state`, `POST /v1/ambient/push`) formatting Home Assistant entity states and MQTT JSON payloads driven purely by Core state.

## Phase 6: Sovereignty, Portability & Ecosystem Readiness *(Complete — 100%)*

- **Sovereign Encrypted Vault Backup & Restore *(Shipped)*:** Zero-dependency AES-256-GCM + `scrypt` encrypted portable archives (`POST /v1/vault/export`, `/v1/vault/verify`, `/v1/vault/restore`) with SHA-256 manifest checksums, owner-bound AAD, non-destructive verification previews, and `merge`/`replace` restore modes in Settings.
- **Deterministic Workspace Self-Audit & Integrity Diagnostics *(Shipped)*:** Zero-LLM governance & storage sweep (`GET /v1/diagnostics/audit`, `POST /v1/diagnostics/remediate`) scoring SQLite WAL integrity, capability lease hygiene, memory TTLs, approval freshness, and dossier readiness with one-click safe remediations.
- **Scoped Peer Client Tokens & Quick-Capture CLI *(Shipped)*:** Least-privilege revocable peer tokens stored strictly as SHA-256 hashes (`GET/POST/DELETE /v1/clients/tokens`), authenticated peer endpoints (`/v1/peer/status`, `/v1/peer/capture`, `/v1/peer/search`), and a standalone zero-dependency companion CLI (`bin/alfie-cli.mjs`).
- **Deterministic Automation Rules & Safe Playbooks *(Shipped)*:** Zero-shell, zero-autonomous-write playbooks (`GET/POST/PATCH/DELETE /v1/playbooks`, `POST /v1/playbooks/:id/run`) supporting dry-run previews, strict boolean toggles, specialist delegation inside user ceilings, reflection snapshotting, and structured idea parking.
- **Continuity Timeline & Portable Markdown Digest Export *(Shipped)*:** Filterable chronological workspace ledger (`GET /v1/timeline`) across projects, decisions, memories, ideas, jobs, and reflections plus one-click portable Markdown export (`GET /v1/export/markdown`) in The Garden.

---

## Explicit Non-Goals (Rejected or Avoided)

- **Silent autonomous memory scraping** without provenance, visibility, or user control.
- **Unrestricted shell or arbitrary code execution** inside Alfie Core.
- **LLM-in-the-loop polling** for infrastructure/homelab monitoring.
- **Always-on hotword microphone listening.**
- **Mandatory gamified virtual rooms**, streaks, or opaque psychological profiling.
- **Tight domain coupling to Petrio** or any single cloud model vendor.
