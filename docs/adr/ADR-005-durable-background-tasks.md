# ADR-005: Durable Background Tasks & Resumable Chat Work

- **Status:** Accepted — implementation pending
- **Target Phase:** Phase 4 (durable execution)

## Context

A long-running task must not be coupled to the lifetime of the browser tab, chat HTTP request, or streaming connection. Raising request timeouts solves only slow interactive inference while the connection remains open. It does not allow a user to close Alfie, return later, inspect progress, or retrieve a completed result.

The current `AsyncJobStore` persists job records, but `AsyncJobEngine.execute()` is called inline by the workshop route. Its cancellation controllers are process-local, and no worker claims queued jobs or reconciles jobs left running after a restart. The generic `POST /v1/jobs` endpoint creates a record but does not schedule work. This ADR defines the required execution contract before the implementation is expanded.

## Decision

Build one durable task lifecycle around a persisted, typed task envelope and an allow-listed handler registry. Do not persist executable callbacks, model-generated code, arbitrary shell commands, or dynamically selected module paths.

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

- Submission persists a `queued` task and returns its ID promptly; it does not wait for execution.
- A Core-owned worker claims queued work using an atomic compare-and-set/transactional lease. Only one worker may own a live lease for a task.
- The worker periodically renews its lease and writes progress/checkpoints. Lease expiry is detectable after process loss.
- The worker resolves a handler only from a fixed registry keyed by the validated task kind.
- Browser disconnects do not cancel a task. Only an authenticated, owner-scoped cancellation request does.
- The worker propagates an AbortSignal to provider and tool work and stops at safe checkpoints.
- Polling by task ID returns status and progress; completed output is retrievable after reconnect. Streaming progress is an optional transport over the same persisted state, not the source of truth.

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
- A Core process restart can recover queued work and safely reconcile interrupted work without pretending that arbitrary in-flight execution is exactly-once.
- The implementation is intentionally stricter than a generic in-memory queue: safety, provenance, approval, and per-user isolation remain properties of the harness.
- The existing job engine is a persistence/state-machine foundation only until the worker, leases, recovery, and chat integration meet these acceptance criteria.
