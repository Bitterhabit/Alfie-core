# Alfie — Phased Roadmap

This roadmap balances ambition with architectural discipline: Alfie's core harness remains lean, auditable, and self-hostable at every milestone.

---

## Phase 1: Foundation & Harness Hardening *(In Progress)*

- Complete remaining pre-release extraction gates (`EXTRACTION_STATUS.md`): live Petrio end-to-end verification, standalone account recovery, and security review of untrusted-data/approval flows.
- **Turn Provenance & Context Inspector:** Surface exact per-turn context (active mode, project dossier, memories injected, tools shortlisted/used, taint status, cloud privacy filtering) under assistant replies.
- **Composable Prompt Assembly:** Modularize `ContextAssembler` into identity, working mode, project dossier, and privacy posture blocks.
- **Storage Migration Readiness (`ADR-001`):** Prepare embedded SQLite (WAL mode) migration path to replace flat JSON files before high-volume graph/watcher workloads land.

## Phase 2: Near-Term Continuity & Low-Context Leverage *(Core Complete)*

- **Living Project Dossiers *(Shipped)*:** Structured project records (status, vision, architecture, key decisions with rationale, blockers, next actions, postponed work) injected automatically into chat context, in-chat Dossier button, and conversation handoffs.
- **Adaptive Working Modes *(Shipped)*:** 8 selectable behavioural postures (`Companion`, `Engineer`, `Investigator`, `Researcher`, `Planner`, `Thinking Partner`, `Creator`, `Tutor`) that shape tone, depth, and rigour without escalating tool permissions.
- **Ideas Vault & Frictionless Capture *(Shipped)*:** Zero-friction idea parking (`/idea` in chat or dedicated Ideas Vault view) with automatic `#hashtag` extraction, clickable hashtag & project filters, inline editing, priority/status lifecycle (`inbox`, `active`, `parked`, `promoted`, `archived`), and one-click Explore in chat.
- **Capability Leases *(Shipped)*:** Optional time-bounded (`ttlMinutes` / `expiresAt`) and project-bounded (`projectId`) permission grants in `PermissionStore` and `ToolDispatcher` with automatic expiry enforcement during dispatch and approval.
- **Hybrid Semantic Retrieval (Python Worker v1):** Stateless internal Python embedding/reranking worker behind Node Core adapters to complement lexical retrieval.

## Phase 3: Medium-Term Situational & Operational Power *(In Progress)*

- **Typed Memory v2 & Persistent Trust Provenance (`ADR-003`) *(Shipped)*:** First-class schemas for `fact`, `decision`, `preference`, `temporary` (with TTL/expiry), `lesson`, and `note` memories, archiving/restoring, and persisted `trust` tiers (`user_authored`, `system_verified`, `external_untrusted`) preserved through `ContextAssembler` and Turn Provenance.
- **Deterministic Watcher Framework & 4-Tier Attention Budget (`ADR-002`) *(Shipped)*:** Per-user deterministic watchers (`project_stall`, `vram_threshold`, `push_metric`, SSRF-hardened `http_probe`) with zero LLM calls, cooldown deduplication, quiet-hours downgrading, and a 4-tier Attention Feed (`quiet_log`, `digest`, `notify`, `urgent`).
- **Context Capsules *(Shipped)*:** Switchable workspaces binding Project Dossier + Working Mode + Learning Posture + Privacy Posture + Capability Lease templates with atomic one-click activation.
- **Modular Integration Suite:** Complete Petrio write adapters (mail, calendar, journal) and introduce permissioned read/draft connectors for GitHub, Proxmox/homelab, and local notes/files.
- **Simulation, Dry-Run & Action Receipts *(Shipped)*:** Structured pre-execution impact previews (risk, affected resource, dependencies, backup flag, rollback plan, validation steps) and persisted post-execution verified Action Receipts on approval-gated tools.
- **Learning Companion & Inspectable Workflow Profile *(Shipped)*:** Transparent, user-editable working preferences (explanation depth, change style, interruption tolerance, chunk size, custom notes), qualitative non-graded learning topics, and study postures (`Solve it`, `Explain as you go`, `Tutor me`, `Challenge me`, `Attempt first`).

## Phase 4: Long-Term Ambitious Capabilities

- **Async Job & Workflow Engine (`ADR-004`):** Decouple long-running tasks from the synchronous 4-step / 30s interactive loop with checkpoints, progress streaming, cancellation, and pause-for-approval queues.
- **Split-Brain Privacy Broker:** Local-model sanitization airlock allowing external cloud models to assist on tasks adjacent to private context without leaking personal details.
- **Bounded Multi-Agent Workshop (`ADR-004`):** Alfie coordinates strictly isolated specialist roles (Researcher, Auditor, Planner, Developer) under per-role capability ceilings, token/time budgets, and persistent taint tracking (`ADR-003`).
- **Unified Knowledge Graph & Visual Explorer:** Cross-entity graph linking Projects, Decisions, Memories, Ideas, Systems, and Events with multi-hop contextual reasoning and an interactive map.
- **Local/Hybrid Voice Loop:** Push-to-talk conversational loop adding local STT/TTS (Whisper + Piper/Kokoro) with interruptible playback.

## Phase 5: Experimental & Capstone Explorations

- **Alfie's Optional Virtual Room:** Opt-in ambient UI projecting live Core state (active projects, knowledge shelves, time/weather, homelab health, Soul mood) without gating normal workflows.
- **Life Continuity & Periodic Reflections:** Opt-in weekly/monthly continuity digests across projects, learning growth, and parked ideas under strict local-only controls.
- **Ambient Hardware Bridges:** Lightweight MQTT / Home Assistant / desk-display presence projections driven purely by deterministic Core state.

---

## Explicit Non-Goals (Rejected or Avoided)

- **Silent autonomous memory scraping** without provenance, visibility, or user control.
- **Unrestricted shell or arbitrary code execution** inside Alfie Core.
- **LLM-in-the-loop polling** for infrastructure/homelab monitoring.
- **Always-on hotword microphone listening.**
- **Mandatory gamified virtual rooms**, streaks, or opaque psychological profiling.
- **Tight domain coupling to Petrio** or any single cloud model vendor.
