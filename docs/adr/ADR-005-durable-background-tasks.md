# ADR-005: Durable Background Tasks & Resumable Chat Work

- **Status:** Partially implemented — bounded workshop and chat-turn workers
- **Target Phase:** Phase 4 (durable execution)

## Context

A long-running task must not be coupled to the lifetime of the browser tab, chat HTTP request, or streaming connection. Raising request timeouts solves only slow interactive inference while the connection remains open. It does not allow a user to close Alfie, return later, inspect progress, or retrieve a completed result.

The `AsyncJobStore` persists job records and bounded typed payloads. Provider chat requests now use the same 30-minute ceiling as the agent loop (with the existing 35-minute client transport allowance), rather than a hidden 30-second provider timeout. The single in-process worker now dispatches allow-listed `subagent_delegation` and `chat_turn` tasks outside the HTTP request. Chat turns are linked to their original conversation and turn ID; user/assistant message writes are idempotent, results survive browser disconnects, and explicit tool approvals resolve the paused task. An authenticated conversation or jobs request after reconnect re-dispatches persisted queued tasks and marks tasks found running after a Core restart as `interrupted` rather than replaying them. This is not yet the completed durable execution architecture: atomic cross-process leases, autonomous startup scanning, persisted cancellation requests, and restart-safe resumable checkpoints remain outstanding.

## Decision

Build one durable task lifecycle around a persisted, typed task envelope and an allow-listed handler registry. The current implementation is a single-process worker and must not be described as multi-worker or exactly-once. Do not persist executable callbacks, model-generated code, arbitrary shell commands, or dynamically selected module paths.

### 1. Persisted task envelope

Each task must include:

- Opaque task ID, verified owner ID, task kind, schema version, and a typed/validated input payload.
- Optional conversation ID and turn ID so a completed chat task can be attached to its original conversation exactly once.
- Status, progress percentage, human-readable progress/checkpoints, created/started/updated/completed timestamps.
- Explicit step, duration, and token budgets; attempt count; cancellation request; and result/error fields.
- Worker lease metadata (owner, expiry, heartbeat) while executing.
- Approval state and pending action reference where applicable.

Task payloads must be bounded and validated at submission. Sensitive prompt content must remain in the user's protected storage boundary and must never be exposed through public job listings, logs, or provider configuration responses.

### 2. Worker lifecycle

- [x] Workshop and background chat submissions persist a `queued` task and return HTTP 202 without waiting for execution.
- [x] A Core-owned in-process worker dispatches allow-listed queued workshop and chat-turn work with a single execution slot.
- [ ] Add an atomic compare-and-set/transactional lease before supporting multiple Core worker processes.
- [x] Persist step progress/checkpoints and reconcile stale `running` tasks to `interrupted` on authenticated conversation/jobs reconnect.
- [ ] Add renewable worker leases and autonomous startup scanning.
- The worker resolves a handler only from a fixed registry keyed by the validated task kind.
- [x] Browser disconnects do not cancel in-process workshop or chat-turn execution; cancellation remains authenticated and owner-scoped.
- [x] Persist owner-scoped cancellation as a terminal job state and propagate AbortSignal to active provider/tool work; cancelling an approval-paused task also rejects its pending action.
- The worker propagates an AbortSignal to provider and tool work and stops at safe checkpoints.
- [x] Owner-scoped polling returns persisted status, checkpoints, and completed artifacts after reconnect.
- [x] Background chat tasks preserve the original conversation association and attach the assistant result exactly once by task ID.
- [x] The UI offers an explicit background-run toggle, polls job state while the chat remains open, and restores task status when a conversation is reopened. Streaming progress is an optional transport over the same persisted state, not the source of truth.

### 3. Restart recovery and execution safety

A lease expiring does not prove that replay is safe. Recovery must distinguish:
- **Queued / not started:** safe to claim.
- **Running with a resumable checkpoint:** resume only when the handler explicitly declares that checkpoint safe.
- **Running without a safe checkpoint:** mark interrupted/needs-review rather than blindly replaying model/tool work.
- **Awaiting approval:** restore the pending approval state; never infer approval from a restart or retry.
- **Terminal:** never execute again.

Tool side effects must continue to use the existing registered-tool, permission, approval, deduplication, and audit paths. A task retry must not bypass action idempotency or repeat an external write. Exactly-once execution is not assumed; side effects require idempotency keys and explicit recovery semantics.

### 4. Chat task behaviour

- Short interactive turns may continue to use the streaming chat path.
- When work is submitted as a background chat task, persist the original user turn and its conversation association before returning the task ID.
- Closing/reopening the UI must not cancel or duplicate the task.
- The UI must show queued/running/awaiting-approval/completed/failed/cancelled/interrupted states, progress, and cancellation where valid.
- On completion, append the assistant result to the original conversation idempotently using the task/turn ID. Do not create duplicate assistant messages on polling, reconnect, or worker recovery.
- A task that needs approval pauses and presents the existing approval flow; it cannot approve itself.

### 5. Scheduling and resource limits

- Keep the current interactive turn budget (30-minute wall-clock ceiling and four-step limit) independent from the background-task budget.
- Apply per-user concurrency limits, global worker concurrency limits, and explicit task budgets.
- Local inference scheduling must account for interactive work and VRAM pressure; background jobs must not starve interactive chat.
- Every task transition and terminal outcome must be auditable without logging secrets or full private prompts.

## Required tests / acceptance criteria

1. Submission returns a task ID while a deliberately blocked handler continues independently of the HTTP request.
2. A simulated browser disconnect leaves the task running.
3. A second worker cannot claim a task with an unexpired lease.
4. An expired lease is recovered according to the handler's safe-resume declaration.
5. Unsafe in-flight work is marked interrupted rather than replayed.
6. Cancellation is owner-scoped, persisted, propagated to the handler, and cannot be overwritten by a late completion.
7. Approval-required tasks remain paused across restart and cannot proceed without explicit approval.
8. Task results are isolated by owner and attached to the original conversation exactly once.
9. Retry/recovery tests prove that side-effecting tool calls are not duplicated.
10. Worker concurrency, per-user limits, wall-clock limits, and VRAM scheduling are covered by deterministic tests.

## Consequences

- Durable tasks become independent of the browser connection and can be observed after reconnect.
- A Core process restart is reconciled on the user's next authenticated jobs request: queued typed work can be dispatched, while in-flight work is marked interrupted and never replayed automatically. Autonomous startup recovery and safe checkpoint resume remain future work.
- The implementation is intentionally stricter than a generic in-memory queue: safety, provenance, approval, and per-user isolation remain properties of the harness.
- The existing job engine is a persistence/state-machine foundation only until the worker, leases, recovery, and chat integration meet these acceptance criteria.
