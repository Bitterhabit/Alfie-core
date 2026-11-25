import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_LIFECYCLE_PHASES, createChatTurnLifecycle } from "../public/chat-lifecycle.mjs";

test("ChatTurnLifecycle transitions through sending -> streaming -> awaiting_approval -> idle deterministically", () => {
  const seen = [];
  const lifecycle = createChatTurnLifecycle({
    onChange(snap) {
      seen.push({ phase: snap.phase, busy: snap.busy, activeKind: snap.activeKind });
    }
  });

  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.IDLE);
  assert.equal(lifecycle.busy, false);

  const turn = lifecycle.beginTurn({ kind: "chat", conversationId: "conv-1" });
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.SENDING);
  assert.equal(lifecycle.busy, true);

  assert.equal(turn.transition(CHAT_LIFECYCLE_PHASES.STREAMING), true);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.STREAMING);

  assert.equal(turn.finish({ outcome: "awaiting_approval" }), true);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.AWAITING_APPROVAL);
  assert.equal(lifecycle.busy, false);

  // Idempotent finish does not clobber subsequent state
  const turn2 = lifecycle.beginTurn({ kind: "approval_continuation", conversationId: "conv-1", actionId: "act-1" });
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.CONTINUING);
  assert.equal(turn.finish({ outcome: "completed" }), false, "Stale turn finish must not clobber active turn");
  assert.equal(lifecycle.busy, true);

  assert.equal(turn2.finish({ outcome: "completed" }), true);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.IDLE);
  assert.equal(lifecycle.busy, false);
  assert.ok(seen.length >= 5);
});

test("ChatTurnLifecycle waitForActiveTurn and enqueueContinuation hand off with zero polling and zero timeout", async () => {
  const lifecycle = createChatTurnLifecycle();
  const order = [];

  const initialTurn = lifecycle.beginTurn({ kind: "chat", conversationId: "conv-1" });
  order.push("turn1:started");

  // Enqueue two continuations while turn 1 is still active — no timer or timeout involved
  const c1 = lifecycle.enqueueContinuation(async () => {
    order.push("cont1:start");
    const handle = lifecycle.beginTurn({ kind: "approval_continuation", conversationId: "conv-1", actionId: "act-1" });
    await Promise.resolve();
    order.push("cont1:finish");
    handle.finish({ outcome: "completed" });
    return "first-done";
  });

  const c2 = lifecycle.enqueueContinuation(async () => {
    order.push("cont2:start");
    const handle = lifecycle.beginTurn({ kind: "approval_continuation", conversationId: "conv-1", actionId: "act-2" });
    order.push("cont2:finish");
    handle.finish({ outcome: "completed" });
    return "second-done";
  });

  // Neither continuation has started yet because turn 1 has not settled
  await Promise.resolve();
  assert.deepEqual(order, ["turn1:started"]);

  // Finishing turn 1 immediately wakes continuation 1, then continuation 2 in strict FIFO order
  initialTurn.finish({ outcome: "awaiting_approval" });
  const results = await Promise.all([c1, c2]);

  assert.deepEqual(results, ["first-done", "second-done"]);
  assert.deepEqual(order, [
    "turn1:started",
    "cont1:start",
    "cont1:finish",
    "cont2:start",
    "cont2:finish"
  ]);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.IDLE);
  assert.equal(lifecycle.getSnapshot().queuedContinuations, 0);
});

test("ChatTurnLifecycle deduplicates concurrent approvals per actionId and tracks approving phase", () => {
  const lifecycle = createChatTurnLifecycle();

  const first = lifecycle.beginApproval("action-42");
  assert.equal(first.accepted, true);
  assert.equal(lifecycle.isApprovalInFlight("action-42"), true);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.APPROVING);

  // Duplicate click for the same actionId is rejected deterministically
  const duplicate = lifecycle.beginApproval("action-42");
  assert.equal(duplicate.accepted, false);

  // Different actionId is allowed independently
  const other = lifecycle.beginApproval("action-99");
  assert.equal(other.accepted, true);
  assert.equal(lifecycle.getSnapshot().inFlightApprovalCount, 2);

  first.finish();
  assert.equal(lifecycle.isApprovalInFlight("action-42"), false);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.APPROVING);

  other.finish();
  assert.equal(lifecycle.getSnapshot().inFlightApprovalCount, 0);
  assert.equal(lifecycle.phase, CHAT_LIFECYCLE_PHASES.IDLE);
});

test("cancelActiveTurn aborts immediately but continuation waits for actual request settlement", async () => {
  const lifecycle = createChatTurnLifecycle();
  const turn = lifecycle.beginTurn({ kind: "chat", conversationId: "conv-1" });

  let continued = false;
  const contPromise = lifecycle.enqueueContinuation(async () => {
    continued = true;
    return "unblocked";
  });

  assert.equal(turn.signal.aborted, false);
  assert.equal(lifecycle.cancelActiveTurn({ silent: false }), true);
  assert.equal(turn.signal.aborted, true);
  assert.equal(turn.abortedByUser, true);
  assert.equal(lifecycle.busy, false);
  assert.equal(lifecycle.getSnapshot().unsettledTurnCount, 1);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(continued, false, "Abort must not release continuation before cleanup settles");

  turn.finish({ outcome: "cancelled" });
  const outcome = await contPromise;
  assert.equal(continued, true);
  assert.equal(outcome, "unblocked");
  assert.equal(lifecycle.getSnapshot().unsettledTurnCount, 0);
});
