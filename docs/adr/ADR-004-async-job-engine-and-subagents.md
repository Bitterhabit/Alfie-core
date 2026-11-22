# ADR-004: Async Job Engine & Bounded Sub-Agent Delegation

- **Status:** Accepted & Shipped (`src/jobs/engine.mjs`, `src/agents/workshop.mjs`)
- **Target Phase:** Phase 4 (Complete)

## Context

`AgentLoop` intentionally enforces hard interactive bounds (`MAX_STEPS = 4`, `WALL_CLOCK_TIMEOUT = 30_000ms`) so chat stays responsive and runaway loops cannot occur. Complex multi-step workflows (deep research, dry-run impact analysis across multiple systems, multi-agent delegation) cannot and should not loosen interactive turn limits.

## Decision

Keep `AgentLoop` strictly bounded for interactive turns and introduce a separate **Async Job Engine** for multi-step background work and bounded sub-agent delegation:

1. **Durable Job State Machine:** `queued -> running -> awaiting_approval -> completed | failed | cancelled`, persisted per user with explicit step, token, and wall-clock budgets.
2. **Sub-Agent Capability Ceilings:** Any delegated specialist role (Researcher, Auditor, Planner, Developer) receives a strict subset of the parent's granted scopes (typically `read`-only or `draft`-only via Capability Leases) and cannot approve its own actions.
3. **VRAM-Aware Scheduling:** Local-model jobs yield to interactive chat turns and consult `VramMonitor` before launching concurrent inference.
4. **Parent Review & Taint Propagation:** Sub-agent outputs return as structured artifacts tagged with the lowest trust level touched during execution (`ADR-003`), reviewed by Alfie before presenting to the user.

## Consequences

- **Positive:** Unlocks deep autonomous workflows without degrading interactive chat latency or bypassing Alfie's approval and audit guarantees.
- **Prerequisite:** Requires SQLite storage (`ADR-001`), Capability Leases, and Persistent Taint Provenance (`ADR-003`) to be in place first.
