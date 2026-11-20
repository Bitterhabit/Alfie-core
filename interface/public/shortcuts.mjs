/**
 * Pure global keyboard shortcut resolver and metadata for Alfie Workspace.
 *
 * Supported shortcuts:
 *  - Ctrl+K (or Cmd+K on macOS): Focus the chat composer
 *  - Esc: Close any open modal, lightbox, sheet, or drawer
 *  - Ctrl+Shift+L (or Cmd+Shift+L on macOS): Cycle Alfie Soul moods
 */

export const SHORTCUT_ACTIONS = Object.freeze({
  FOCUS_COMPOSER: "focus_composer",
  CLOSE_MODALS: "close_modals",
  CYCLE_SOUL_MOOD: "cycle_soul_mood"
});

export const GLOBAL_SHORTCUTS = Object.freeze([
  Object.freeze({
    action: SHORTCUT_ACTIONS.FOCUS_COMPOSER,
    combo: "Ctrl+K",
    ariaKeyshortcuts: "Control+K Meta+K",
    description: "Focus the chat composer"
  }),
  Object.freeze({
    action: SHORTCUT_ACTIONS.CLOSE_MODALS,
    combo: "Esc",
    ariaKeyshortcuts: "Escape",
    description: "Close any open modal or overlay"
  }),
  Object.freeze({
    action: SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD,
    combo: "Ctrl+Shift+L",
    ariaKeyshortcuts: "Control+Shift+L Meta+Shift+L",
    description: "Cycle Alfie Soul moods"
  })
]);

const SOUL_MOOD_LABELS = Object.freeze({
  purple: "Work",
  blue: "Good",
  red: "Alert",
  amber: "Thinking",
  cyan: "Working"
});

/**
 * Format a soul mood token into a human-readable label.
 * @param {string} mood
 * @returns {string}
 */
export function formatMoodLabel(mood) {
  const normalized = String(mood || "").trim().toLowerCase();
  if (!normalized) return "Work";
  return SOUL_MOOD_LABELS[normalized] || (normalized[0].toUpperCase() + normalized.slice(1));
}

/**
 * Resolve a DOM KeyboardEvent (or plain event-like object) to a global shortcut action.
 * Returns null if the event does not match a registered global shortcut.
 *
 * @param {{
 *   key?: string,
 *   code?: string,
 *   ctrlKey?: boolean,
 *   metaKey?: boolean,
 *   shiftKey?: boolean,
 *   altKey?: boolean,
 *   isComposing?: boolean,
 *   defaultPrevented?: boolean
 * } | null | undefined} eventLike
 * @returns {"focus_composer" | "close_modals" | "cycle_soul_mood" | null}
 */
export function resolveGlobalShortcut(eventLike) {
  if (!eventLike || typeof eventLike !== "object") return null;
  if (eventLike.isComposing || eventLike.defaultPrevented) return null;

  const key = typeof eventLike.key === "string" ? eventLike.key : "";
  const code = typeof eventLike.code === "string" ? eventLike.code : "";
  const lowerKey = key.toLowerCase();

  const hasPrimaryModifier = Boolean(eventLike.ctrlKey || eventLike.metaKey);
  const hasAlt = Boolean(eventLike.altKey);
  const hasShift = Boolean(eventLike.shiftKey);

  // Escape closes any open modal/drawer/overlay (plain Escape only, no Ctrl/Meta/Alt).
  if ((key === "Escape" || key === "Esc" || code === "Escape") && !hasPrimaryModifier && !hasAlt) {
    return SHORTCUT_ACTIONS.CLOSE_MODALS;
  }

  // Remaining global shortcuts require Ctrl (or Cmd on macOS) and never Alt.
  if (!hasPrimaryModifier || hasAlt) return null;

  // Ctrl+K / Cmd+K (without Shift): Focus composer
  if (!hasShift && (lowerKey === "k" || code === "KeyK")) {
    return SHORTCUT_ACTIONS.FOCUS_COMPOSER;
  }

  // Ctrl+Shift+L / Cmd+Shift+L (requires Shift so browser Ctrl+L address bar is untouched): Cycle Alfie Soul mood
  if (hasShift && (lowerKey === "l" || code === "KeyL")) {
    return SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD;
  }

  return null;
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieShortcuts = Object.freeze({
    SHORTCUT_ACTIONS,
    GLOBAL_SHORTCUTS,
    formatMoodLabel,
    resolveGlobalShortcut
  });
}
