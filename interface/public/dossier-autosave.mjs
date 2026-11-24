/**
 * Pure, race-safe debounced auto-save controller for the Project Dossier modal.
 * Serializes in-flight PATCH requests and coalesces rapid keystrokes so the
 * backend always converges on the user's latest edit without clobbering input focus.
 */

export function normalizeDossierDraft(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    name: String(src.name || "").trim(),
    status: String(src.status || "active").trim() || "active",
    vision: String(src.vision || "").trim(),
    description: String(src.description || "").trim(),
    architecture: String(src.architecture || "").trim(),
    nextActions: String(src.nextActions || "").replace(/\r\n/g, "\n"),
    blockers: String(src.blockers || "").replace(/\r\n/g, "\n"),
    decisions: String(src.decisions || "").replace(/\r\n/g, "\n"),
    postponed: String(src.postponed || "").replace(/\r\n/g, "\n"),
    color: String(src.color || "purple").trim() || "purple"
  };
}

export function fingerprintDossierDraft(raw = {}) {
  return JSON.stringify(normalizeDossierDraft(raw));
}

/**
 * Create a debounced, serialized auto-saver for an active Project Dossier editing session.
 *
 * @param {{
 *   debounceMs?: number,
 *   persist: (projectId: string, payload: Record<string, string>) => Promise<unknown>,
 *   onStateChange?: (snapshot: {
 *     state: "disabled" | "idle" | "pending" | "saving" | "saved" | "invalid" | "error",
 *     projectId: string,
 *     dirty: boolean,
 *     inFlight: boolean,
 *     savedAt: string | null,
 *     error: string
 *   }) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   now?: () => string
 * }} options
 */
export function createDossierAutoSaver({
  debounceMs = 650,
  persist,
  onStateChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  now = () => new Date().toISOString()
} = {}) {
  if (typeof persist !== "function") {
    throw new TypeError("createDossierAutoSaver requires a persist(projectId, payload) function.");
  }

  let sessionToken = 0;
  let projectId = "";
  let lastSavedFingerprint = "";
  let lastSavedAt = null;
  let state = "disabled";
  let lastError = "";
  let timerHandle = null;
  let pendingDraft = null;
  let pendingFingerprint = "";
  let inFlightPromise = null;
  let inFlightFingerprint = "";

  function clearPendingTimer() {
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  }

  function snapshot() {
    const dirty = Boolean(
      projectId &&
      ((pendingDraft && pendingFingerprint !== lastSavedFingerprint) ||
        (inFlightPromise && inFlightFingerprint !== lastSavedFingerprint))
    );
    return {
      state,
      projectId,
      dirty,
      inFlight: Boolean(inFlightPromise),
      savedAt: lastSavedAt,
      error: lastError
    };
  }

  function emit(nextState, errorMessage = "") {
    state = nextState;
    lastError = errorMessage;
    onStateChange(snapshot());
  }

  async function runSave(token) {
    if (token !== sessionToken || !projectId) return null;
    if (inFlightPromise) return inFlightPromise;
    if (!pendingDraft) return null;

    const draftToSave = pendingDraft;
    const fpToSave = pendingFingerprint;
    pendingDraft = null;
    pendingFingerprint = "";

    if (!draftToSave.name) {
      emit("invalid", "Project name is required to auto-save.");
      return null;
    }
    if (fpToSave === lastSavedFingerprint) {
      emit(lastSavedAt ? "saved" : "idle");
      return null;
    }

    inFlightFingerprint = fpToSave;
    emit("saving");

    const runPromise = (async () => {
      try {
        const result = await persist(projectId, draftToSave);
        if (token !== sessionToken) return result;
        lastSavedFingerprint = fpToSave;
        lastSavedAt = now();
        inFlightFingerprint = "";
        inFlightPromise = null;

        // If user edited again while the request was in flight, schedule or run the queued draft.
        if (pendingDraft && pendingFingerprint !== lastSavedFingerprint) {
          if (timerHandle === null) {
            return runSave(token);
          }
          emit("pending");
          return result;
        }
        pendingDraft = null;
        pendingFingerprint = "";
        emit("saved");
        return result;
      } catch (err) {
        if (token !== sessionToken) return null;
        inFlightFingerprint = "";
        inFlightPromise = null;
        const message = err instanceof Error ? err.message : String(err || "Auto-save failed.");
        emit("error", message);
        // If newer edits arrived during a failed request, let their timer persist them.
        return null;
      }
    })();

    inFlightPromise = runPromise;
    return runPromise;
  }

  function reset(nextProjectId = "", initialDraft = null) {
    sessionToken += 1;
    clearPendingTimer();
    pendingDraft = null;
    pendingFingerprint = "";
    inFlightPromise = null;
    inFlightFingerprint = "";
    lastSavedAt = null;
    lastError = "";
    projectId = String(nextProjectId || "").trim();
    lastSavedFingerprint = projectId && initialDraft ? fingerprintDossierDraft(initialDraft) : "";
    emit(projectId ? "idle" : "disabled");
  }

  function schedule(rawDraft) {
    if (!projectId) return false;
    const normalized = normalizeDossierDraft(rawDraft);
    const fp = JSON.stringify(normalized);

    if (!normalized.name) {
      clearPendingTimer();
      pendingDraft = null;
      pendingFingerprint = "";
      emit("invalid", "Project name is required to auto-save.");
      return false;
    }

    if (fp === lastSavedFingerprint && !inFlightPromise) {
      clearPendingTimer();
      pendingDraft = null;
      pendingFingerprint = "";
      emit(lastSavedAt ? "saved" : "idle");
      return false;
    }

    if (inFlightPromise && fp === inFlightFingerprint) {
      clearPendingTimer();
      pendingDraft = null;
      pendingFingerprint = "";
      return false;
    }

    pendingDraft = normalized;
    pendingFingerprint = fp;
    clearPendingTimer();
    const token = sessionToken;
    if (!inFlightPromise) {
      emit("pending");
    }
    timerHandle = setTimer(() => {
      timerHandle = null;
      void runSave(token);
    }, Math.max(0, Number(debounceMs) || 0));
    return true;
  }

  async function flush() {
    if (!projectId) return null;
    const token = sessionToken;
    clearPendingTimer();

    if (inFlightPromise) {
      try {
        await inFlightPromise;
      } catch {
        // Error state already emitted by runSave
      }
    }
    if (token !== sessionToken) return null;
    if (pendingDraft && pendingFingerprint !== lastSavedFingerprint) {
      return runSave(token);
    }
    return null;
  }

  function markSaved(rawDraft, savedAtOverride = null) {
    clearPendingTimer();
    pendingDraft = null;
    pendingFingerprint = "";
    if (projectId && rawDraft) {
      lastSavedFingerprint = fingerprintDossierDraft(rawDraft);
      lastSavedAt = savedAtOverride || now();
      emit("saved");
    }
  }

  function cancel() {
    sessionToken += 1;
    clearPendingTimer();
    pendingDraft = null;
    pendingFingerprint = "";
    inFlightPromise = null;
    inFlightFingerprint = "";
    lastError = "";
    state = projectId ? "idle" : "disabled";
  }

  return {
    reset,
    schedule,
    flush,
    markSaved,
    cancel,
    getStatus: snapshot
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieDossierAutoSave = Object.freeze({
    normalizeDossierDraft,
    fingerprintDossierDraft,
    createDossierAutoSaver
  });
}
