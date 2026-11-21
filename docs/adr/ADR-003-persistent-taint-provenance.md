# ADR-003: Persistent Trust & Taint Provenance Model

- **Status:** Proposed
- **Target Phase:** Phase 2 -> Phase 3

## Context

Today, `ToolDispatcher` detects untrusted content within a single synchronous turn via `containsUntrustedData(contextMessages)` and forces explicit user approval whenever untrusted data is present before any non-read or external-network tool runs.

As Alfie gains Watchers, Quick Capture Inbox links, external connectors (GitHub, Mail, Web), and future sub-agents, indirect prompt injection could otherwise be **laundered** across turns—e.g. an external email summarized into a memory or idea, then read later as "trusted" user data.

## Decision

Attach explicit, immutable **trust provenance metadata** (`trust: "user_authored" | "system_verified" | "external_untrusted"`, `origin`, `capturedAt`) to stored records (memories, ideas, watcher events, and sub-agent artifacts):

1. Any record derived from an external/untrusted source retains `trust: "external_untrusted"` unless explicitly promoted/edited by the user.
2. When `ContextAssembler` injects any `external_untrusted` record into a turn, it wraps it in `<untrusted_data>` envelopes so `ToolDispatcher`'s existing taint escalation automatically activates.
3. The Turn Provenance Inspector surfaces taint status to the user so step-up approval prompts are always transparent and explainable.

## Consequences

- **Positive:** Closes cross-turn prompt-injection laundering before proactive watchers and sub-agents ship; makes Alfie's safety guarantees visible and auditable in the UI.
- **Trade-offs:** Slightly stricter approval prompts when acting directly on imported external items—which is the intended safety posture.
