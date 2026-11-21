# ADR-002: Deterministic Watcher Framework & Attention Budget

- **Status:** Proposed
- **Target Phase:** Phase 3

## Context

`VramMonitor` (`src/system/vramMonitor.mjs`) proves a reliable pattern for external infrastructure awareness: bearer-authenticated push telemetry with TTL, SSRF-hardened pull probes blocking cloud metadata hosts, deterministic threshold evaluation, staleness tracking, and non-blocking UI alerts.

Extending monitoring to Proxmox, container health, backups, storage, GitHub repos, and personal events must not introduce LLM polling loops, GPU VRAM contention, or notification fatigue.

## Decision

Generalize `VramMonitor` into a **Deterministic Watcher Engine** paired with a **4-Tier Attention Budget Router**:

1. **Zero-LLM Probes:** Watchers execute scheduled or push-triggered deterministic checks (HTTP JSON/CSV, webhook ingestors, bounded status collectors) and emit typed state-change events only on meaningful deltas.
2. **Untrusted by Default:** Every external watcher payload is stamped `trust: "untrusted"` and truncated/schema-validated before storage.
3. **4-Tier Routing Hierarchy:**
   - `quiet_log` — recorded in watcher history only; never interrupts.
   - `digest` — batched into the next session briefing or scheduled summary.
   - `notify` — non-blocking banner/toast or standard notification respecting quiet hours.
   - `urgent` — immediate interruption reserved for critical outages, failed backups, or explicit user rules.
4. **On-Demand LLM Synthesis:** An LLM is invoked only when synthesizing a digest or when the user asks to investigate an alert—never inside the polling loop.

## Consequences

- **Positive:** Near-zero CPU/GPU overhead; predictable latency; prevents notification spam; directly drives Alfie Soul status indicators from real environment health.
- **Security:** Every pull watcher inherits strict URL/host allowlisting and private/metadata IP blocking.
