# ADR-004: Async Job Engine & Bounded Sub-Agent Delegation

- **Status:** Partially implemented. The job record/state store and bounded workshop executor exist. A single-process background worker now dispatches workshop tasks outside the HTTP request, and reconnect reconciliation requeues persisted queued work while marking stale running work interrupted. Atomic cross-process leases, autonomous startup scanning, and durable chat submission are not yet implemented.
- **Target Phase:** Phase 4 (in progress)

## Context

Interactive chat must tolerate slow local inference and long provider responses; a fixed 30-second wall-clock deadline incorrectly turns slow-but-healthy model calls into failures. Interactive turns remain bounded by a maximum of four model/tool steps and a 30-minute wall-clock ceiling. The HTTP client allows 35 minutes, and the streaming server emits 15-second heartbeats so reverse proxies do not mistake a quiet model for a dead connection.

The job implementation persists per-user job records and checkpoints. Workshop submission now returns HTTP 202 after queueing an allow-listed `subagent_delegation` task; a single in-process worker executes it independently of the browser connection. On the next authenticated jobs request after a Core restart, queued typed jobs are dispatched and stale running jobs are marked `interrupted` rather than replayed. Cancellation controllers remain process-local, and recovery is reconnect-triggered rather than autonomous. This is a first background-worker slice, not yet a multi-process lease-based or generic chat-task system.

## Decision

Keep interactive turns bounded by step count and a generous wall-clock ceiling. Complete the separate **Async Job Engine** as a true background execution system under ADR-005:

1. **Durable Job State Machine:** `queued -> running -> awaiting_approval -> completed | failed | cancelled`, persisted per user with explicit step, token, and wall-clock budgets. Add a safe interrupted/recovery state where automatic replay cannot be proven safe.
2. **Sub-Agent Capability Ceilings:** Any delegated specialist role (Researcher, Auditor, Planner, Developer) receives a strict subset of the parent's granted scopes (typically `read`-only or `draft`-only via Capability Leases) and cannot approve its own actions.
3. **VRAM-Aware Scheduling:** Local-model jobs yield to interactive chat turns and consult `VramMonitor` before launching concurrent inference.
4. **Parent Review & Taint Propagation:** Sub-agent outputs return as structured artifacts tagged with the lowest trust level touched during execution (ADR-003), reviewed by Alfie before presenting to the user.

## Long-running chat transport

The interactive chat path permits up to 30 minutes per turn (still capped at four model/tool steps). Core-to-interface chat, agent-run, and stream requests use a 35-minute transport timeout. The Core stream emits a lightweight heartbeat every 15 seconds while waiting for the agent loop. Heartbeats are transport events only; they are not persisted as conversation messages.

This transport change does **not** make an in-flight interactive chat turn durable across browser or process restarts. The workshop worker is a separate, bounded task path; do not imply that arbitrary chat requests are automatically converted into background tasks. See ADR-005 for remaining acceptance criteria.
