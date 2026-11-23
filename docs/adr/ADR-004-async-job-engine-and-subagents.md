# ADR-004: Async Job Engine & Bounded Sub-Agent Delegation

- **Status:** Accepted & Shipped (`src/jobs/engine.mjs`, `src/agents/workshop.mjs`)
- **Target Phase:** Phase 4 (Complete)

## Context

Interactive chat must tolerate slow local inference and long provider responses; a fixed 30-second wall-clock deadline incorrectly turns slow-but-healthy model calls into failures. Interactive turns remain bounded by a maximum of four model/tool steps and a 30-minute wall-clock ceiling. The HTTP client allows 35 minutes, and the streaming server emits 15-second heartbeats so reverse proxies do not mistake a quiet model for a dead connection. Complex workflows that must survive a browser disconnect still belong in the durable job engine.

## Decision

Keep interactive turns bounded by step count and a generous wall-clock ceiling. Use the separate **Async Job Engine** for durable multi-step background work and bounded sub-agent delegation:

1. **Durable Job State Machine:** `queued -> running -> awaiting_approval -> completed | failed | cancelled`, persisted per user with explicit step, token, and wall-clock budgets.
2. **Sub-Agent Capability Ceilings:** Any delegated specialist role (Researcher, Auditor, Planner, Developer) receives a strict subset of the parent's granted scopes (typically `read`-only or `draft`-only via Capability Leases) and cannot approve its own actions.
3. **VRAM-Aware Scheduling:** Local-model jobs yield to interactive chat turns and consult `VramMonitor` before launching concurrent inference.
4. **Parent Review & Taint Propagation:** Sub-agent outputs return as structured artifacts tagged with the lowest trust level touched during execution (`ADR-003`), reviewed by Alfie before presenting to the user.

## Consequences

- **Positive:** Allows long-running interactive inference without a 30-second false timeout, while durable jobs can continue independently of a chat connection without bypassing Alfie's approval and audit guarantees.
- **Prerequisite:** Requires SQLite storage (`ADR-001`), Capability Leases, and Persistent Taint Provenance (`ADR-003`) to be in place first.


## Long-running chat transport

The interactive chat path now permits up to 30 minutes per turn (still capped at four agent-loop steps). Core-to-interface chat, agent-run, and stream requests use a 35-minute transport timeout. The Core stream emits a lightweight heartbeat every 15 seconds while waiting for the agent loop, keeping idle model inference visible to reverse proxies. Heartbeats are transport events only; they are not persisted as conversation messages.

This does **not** make an in-flight interactive turn durable across browser or process restarts. Work that must continue after a user disconnects must be submitted to the Async Job Engine and polled through its persisted job state. This change removes the premature timeout and preserves the existing durable-job boundary; it does not silently convert every chat prompt into a background job.
