# ADR-002: Deterministic Watcher Framework & Attention Budget

- **Status:** Accepted & Implemented
- **Target Phase:** Phase 3

## Context

`VramMonitor` (`src/system/vramMonitor.mjs`) proves a reliable pattern for external infrastructure awareness: bearer-authenticated push telemetry with TTL, pull probes blocking cloud metadata hosts, deterministic threshold evaluation, staleness tracking, and non-blocking UI alerts.

Extending monitoring to Proxmox, container health, backups, storage, GitHub repos, and personal events must not introduce LLM polling loops, GPU VRAM contention, or notification fatigue.

## Decision

Generalize `VramMonitor` into a **Deterministic Watcher Engine** paired with a **4-Tier Attention Budget Router**:

1. **Zero-LLM Probes:** Watchers execute scheduled or push-triggered deterministic checks (HTTP probes, project stall monitors, VRAM thresholds, webhook metric ingestors) and emit typed state-change events only on meaningful deltas.
2. **Untrusted by Default:** Every external watcher payload is stamped `trust: "external_untrusted"` and truncated/schema-validated before storage.
3. **4-Tier Routing Hierarchy & Timezone-Aware Quiet Hours:**
   - `quiet_log` — recorded in watcher history only; never interrupts.
   - `digest` — batched into the next session briefing or scheduled summary.
   - `notify` — non-blocking banner/toast or standard notification downgraded to `digest` during configured quiet hours.
   - `urgent` — immediate interruption reserved for critical outages, failed backups, or explicit user rules (always bypasses quiet hours).
   - Quiet hours evaluate wall-clock local time against an explicit validated IANA timezone (`quietHours.timezone`), defaulting deterministically to `"UTC"` for existing records and new watchers rather than guessing the server timezone.
4. **DNS-Validated, Connection-Pinned HTTP Probes:** HTTP watchers resolve all A/AAAA records before connecting, fail closed if any resolved IP is non-public (including private, loopback, link-local, metadata, multicast, or IPv4-mapped/transition IPv6), pin the socket connection directly to the validated IP via native `http.request`/`https.request` custom `lookup` (preventing DNS rebinding), preserve TLS SNI and certificate hostname verification, reject all 3xx redirects, and enforce strict timeouts and bounded response reading.
5. **On-Demand LLM Synthesis:** An LLM is invoked only when synthesizing a digest or when the user asks to investigate an alert—never inside the polling loop.

## Consequences

- **Positive:** Near-zero CPU/GPU overhead; predictable latency; prevents notification spam; DST-accurate local quiet hours; directly drives Alfie Soul status indicators from real environment health.
- **Security:** Pull watchers fail closed on DNS errors, mixed public/private DNS responses, DNS rebinding, redirects, invalid TLS certificates, and non-boolean config coercion.
