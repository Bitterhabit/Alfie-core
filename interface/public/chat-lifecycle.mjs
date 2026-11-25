/**
 * Event-driven, promise-based request lifecycle manager for Alfie chat turns
 * and approval continuations.
 *
 * Replaces raw boolean polling and arbitrary wait timeouts with explicit turn
 * phases, deterministic settlement promises, per-action approval deduplication,
 * and serialized post-approval continuation handoff.
 */

export const CHAT_LIFECYCLE_PHASES = Object.freeze({
  IDLE: "idle",
  SENDING: "sending",
  STREAMING: "streaming",
  AWAITING_APPROVAL: "awaiting_approval",
  APPROVING: "approving",
  CONTINUING: "continuing",
  CANCELLING: "cancelling"
});

export function createChatTurnLifecycle({ onChange = () => {} } = {}) {
  let seq = 0;
  let activeTurn = null;
  let phase = CHAT_LIFECYCLE_PHASES.IDLE;
  const inFlightApprovals = new Map(); // actionId -> { actionId, controller, startedAt }
  let continuationChain = Promise.resolve();
  let queuedContinuations = 0;

  function getSnapshot() {
    return {
      phase,
      busy: Boolean(activeTurn),
      activeTurnId: activeTurn?.id || null,
      activeKind: activeTurn?.kind || null,
      activeConversationId: activeTurn?.conversationId || null,
      activeActionId: activeTurn?.actionId || null,
      inFlightApprovalCount: inFlightApprovals.size,
      queuedContinuations
    };
  }

  function emit() {
    try {
      onChange(getSnapshot());
    } catch {}
  }

  function recomputeIdlePhase(preferredOutcome = "completed") {
    if (activeTurn) {
      phase = activeTurn.phase;
    } else if (inFlightApprovals.size > 0) {
      phase = CHAT_LIFECYCLE_PHASES.APPROVING;
    } else if (preferredOutcome === "awaiting_approval") {
      phase = CHAT_LIFECYCLE_PHASES.AWAITING_APPROVAL;
    } else {
      phase = CHAT_LIFECYCLE_PHASES.IDLE;
    }
    emit();
  }

  /**
   * Wait deterministically until the currently active turn (if any) settles.
   * Uses the active turn's settlement promise directly — zero polling, zero timeout.
   */
  async function waitForActiveTurn() {
    while (activeTurn) {
      const current = activeTurn;
      await current.settled;
    }
  }

  /**
   * Cancel the active turn immediately, aborting its AbortController and resolving
   * its settlement promise so any waiting continuation or conversation switch can proceed.
   */
  function cancelActiveTurn({ silent = false, reason = "Request cancelled by user." } = {}) {
    const turn = activeTurn;
    if (!turn) return false;
    turn.abortedByUser = true;
    turn.silent = Boolean(silent);
    turn.phase = CHAT_LIFECYCLE_PHASES.CANCELLING;
    phase = CHAT_LIFECYCLE_PHASES.CANCELLING;
    activeTurn = null;
    emit();
    try {
      turn.controller.abort(new Error(reason));
    } catch {}
    if (!turn.isSettled) {
      turn.isSettled = true;
      turn.resolveSettled({ outcome: "cancelled", abortedByUser: true, silent: turn.silent });
    }
    recomputeIdlePhase("cancelled");
    return true;
  }

  /**
   * Begin a tracked chat turn lifecycle (normal chat, approval continuation, or image turn).
   */
  function beginTurn({ kind = "chat", conversationId = null, actionId = "" } = {}) {
    if (activeTurn) {
      cancelActiveTurn({ silent: true, reason: "Superseded by a newer chat turn." });
    }
    const id = ++seq;
    const initialPhase = kind === "approval_continuation"
      ? CHAT_LIFECYCLE_PHASES.CONTINUING
      : CHAT_LIFECYCLE_PHASES.SENDING;

    let resolveSettled;
    const settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });

    const controller = new AbortController();
    const turn = {
      id,
      kind,
      conversationId: conversationId || null,
      actionId: String(actionId || ""),
      phase: initialPhase,
      controller,
      signal: controller.signal,
      abortedByUser: false,
      silent: false,
      isSettled: false,
      settled,
      resolveSettled
    };

    activeTurn = turn;
    phase = initialPhase;
    emit();

    return {
      id,
      kind: turn.kind,
      conversationId: turn.conversationId,
      actionId: turn.actionId,
      controller,
      signal: controller.signal,
      settled,
      get abortedByUser() { return turn.abortedByUser; },
      get silent() { return turn.silent; },
      get phase() { return turn.phase; },
      isActive() {
        return activeTurn === turn;
      },
      transition(nextPhase) {
        if (activeTurn !== turn || turn.isSettled) return false;
        turn.phase = nextPhase;
        phase = nextPhase;
        emit();
        return true;
      },
      finish({ outcome = "completed" } = {}) {
        const wasActive = activeTurn === turn;
        if (wasActive) {
          activeTurn = null;
        }
        if (!turn.isSettled) {
          turn.isSettled = true;
          turn.resolveSettled({
            outcome,
            abortedByUser: turn.abortedByUser,
            silent: turn.silent
          });
        }
        if (wasActive) {
          recomputeIdlePhase(outcome);
        }
        return wasActive || !activeTurn;
      }
    };
  }

  /**
   * Track an in-flight /api/core/tools/approve execution by actionId so duplicate clicks
   * cannot double-execute the same approval and approval state is reflected in the lifecycle.
   */
  function beginApproval(actionId) {
    const key = String(actionId || "").trim();
    if (!key) return { accepted: false, reason: "Missing actionId." };
    if (inFlightApprovals.has(key)) {
      return { accepted: false, reason: "Approval is already in progress." };
    }
    const controller = new AbortController();
    const record = { actionId: key, controller, finished: false };
    inFlightApprovals.set(key, record);
    if (!activeTurn) {
      phase = CHAT_LIFECYCLE_PHASES.APPROVING;
      emit();
    } else {
      emit();
    }
    return {
      accepted: true,
      actionId: key,
      controller,
      signal: controller.signal,
      finish() {
        if (record.finished) return;
        record.finished = true;
        if (inFlightApprovals.get(key) === record) {
          inFlightApprovals.delete(key);
        }
        recomputeIdlePhase("completed");
      }
    };
  }

  /**
   * Enqueue a post-approval continuation task so it runs deterministically right after
   * any currently active turn and any earlier queued continuations settle — with zero
   * polling and zero arbitrary timeout.
   */
  function enqueueContinuation(task) {
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("enqueueContinuation requires a task function."));
    }
    queuedContinuations += 1;
    emit();

    const run = async () => {
      try {
        await waitForActiveTurn();
        return await task();
      } finally {
        queuedContinuations = Math.max(0, queuedContinuations - 1);
        emit();
      }
    };

    const next = continuationChain.then(run, run);
    // Keep the chain healthy even if one continuation rejects
    continuationChain = next.then(() => {}, () => {});
    return next;
  }

  function isApprovalInFlight(actionId) {
    return inFlightApprovals.has(String(actionId || "").trim());
  }

  return Object.freeze({
    beginTurn,
    cancelActiveTurn,
    waitForActiveTurn,
    beginApproval,
    isApprovalInFlight,
    enqueueContinuation,
    getSnapshot,
    get activeTurn() { return activeTurn; },
    get busy() { return Boolean(activeTurn); },
    get phase() { return phase; }
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieChatLifecycle = Object.freeze({
    CHAT_LIFECYCLE_PHASES,
    createChatTurnLifecycle
  });
}
