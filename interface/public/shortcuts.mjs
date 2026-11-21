/**
 * Pure global keyboard shortcut resolver, custom binding store helpers,
 * validation, conflict detection, and reference metadata for Alfie Workspace.
 */

export const SHORTCUT_ACTIONS = Object.freeze({
  FOCUS_COMPOSER: "focus_composer",
  CLOSE_MODALS: "close_modals",
  CYCLE_SOUL_MOOD: "cycle_soul_mood"
});

export const SHORTCUT_STORAGE_KEY = "alfie_keyboard_shortcuts_v1";

export const DEFAULT_SHORTCUT_BINDINGS = Object.freeze({
  [SHORTCUT_ACTIONS.FOCUS_COMPOSER]: Object.freeze({
    key: "k",
    ctrl: true,
    shift: false,
    alt: false
  }),
  [SHORTCUT_ACTIONS.CLOSE_MODALS]: Object.freeze({
    key: "Escape",
    ctrl: false,
    shift: false,
    alt: false
  }),
  [SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD]: Object.freeze({
    key: "l",
    ctrl: true,
    shift: true,
    alt: false
  })
});

export const GLOBAL_SHORTCUTS = Object.freeze([
  Object.freeze({
    action: SHORTCUT_ACTIONS.FOCUS_COMPOSER,
    label: "Focus chat composer",
    combo: "Ctrl+K",
    ariaKeyshortcuts: "Control+K Meta+K",
    description: "Jump straight to the message input from anywhere in the workspace."
  }),
  Object.freeze({
    action: SHORTCUT_ACTIONS.CLOSE_MODALS,
    label: "Close open modals",
    combo: "Esc",
    ariaKeyshortcuts: "Escape",
    description: "Dismiss open dialogs, image lightbox, drawers, or slash suggestions."
  }),
  Object.freeze({
    action: SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD,
    label: "Cycle Alfie Soul moods",
    combo: "Ctrl+Shift+L",
    ariaKeyshortcuts: "Control+Shift+L Meta+Shift+L",
    description: "Rotate Alfie's Soul between Work, Good, Alert, and Thinking."
  })
]);

export const BUILTIN_REFERENCE_SHORTCUTS = Object.freeze([
  Object.freeze({
    id: "open_help",
    label: "Open keyboard shortcuts help",
    keys: Object.freeze(["?"]),
    description: "Show this shortcut reference when not typing in an input."
  }),
  Object.freeze({
    id: "send_message",
    label: "Send message",
    keys: Object.freeze(["Enter"]),
    description: "Submit the current message from the chat composer."
  }),
  Object.freeze({
    id: "newline_composer",
    label: "Insert new line",
    keys: Object.freeze(["Shift", "Enter"]),
    description: "Add a line break without sending while in the composer."
  }),
  Object.freeze({
    id: "autocomplete_slash",
    label: "Autocomplete slash command (/idea, /image)",
    keys: Object.freeze(["Tab"]),
    description: "Accept the highlighted slash-command suggestion in the composer."
  }),
  Object.freeze({
    id: "lightbox_zoom",
    label: "Zoom or reset lightbox image",
    keys: Object.freeze(["+", "-", "0"]),
    description: "Zoom in, zoom out, or reset to 100% while previewing an image."
  })
]);

const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "OS",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified"
]);

const FUNCTION_KEY_PATTERN = /^F([1-9]|1[0-2])$/i;

const SPECIAL_KEY_DISPLAY = Object.freeze({
  Escape: "Esc",
  " ": "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown"
});

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
 * Normalize a single key name from a KeyboardEvent or stored value.
 * @param {string} rawKey
 * @param {string} [rawCode]
 * @returns {string | null}
 */
export function normalizeKeyName(rawKey, rawCode = "") {
  const key = typeof rawKey === "string" ? rawKey : "";
  const code = typeof rawCode === "string" ? rawCode : "";

  if (key === "Esc" || key === "Escape" || code === "Escape") return "Escape";
  if (key === "Spacebar" || key === "Space" || key === " " || code === "Space") return " ";

  if (FUNCTION_KEY_PATTERN.test(key)) return key.toUpperCase();
  if (FUNCTION_KEY_PATTERN.test(code)) return code.toUpperCase();

  // Map letter/digit physical codes if key is Dead/shifted symbol (e.g. Alt+letter on macOS)
  if (/^Key([A-Z])$/.test(code) && (MODIFIER_KEYS.has(key) || !key || key.length !== 1 || !/^[a-z]$/i.test(key))) {
    return code.slice(3).toLowerCase();
  }
  if (/^Digit([0-9])$/.test(code) && (MODIFIER_KEYS.has(key) || !key)) {
    return code.slice(5);
  }

  if (!key || MODIFIER_KEYS.has(key)) return null;

  if (key.length === 1) {
    return /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key;
  }

  // Named navigation/editing keys
  const knownNamed = [
    "Enter", "Tab", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Insert"
  ];
  const matched = knownNamed.find((item) => item.toLowerCase() === key.toLowerCase());
  return matched || null;
}

/**
 * Normalize and validate a binding object. Returns null if malformed.
 * @param {{ key?: string, ctrl?: boolean, shift?: boolean, alt?: boolean } | null | undefined} raw
 */
export function normalizeBinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = normalizeKeyName(raw.key, raw.code);
  if (!key) return null;
  return {
    key,
    ctrl: Boolean(raw.ctrl),
    shift: Boolean(raw.shift),
    alt: Boolean(raw.alt)
  };
}

/**
 * Compare two bindings for equality.
 */
export function bindingsEqual(a, b) {
  const normA = normalizeBinding(a);
  const normB = normalizeBinding(b);
  if (!normA || !normB) return false;
  return (
    normA.key === normB.key &&
    normA.ctrl === normB.ctrl &&
    normA.shift === normB.shift &&
    normA.alt === normB.alt
  );
}

/**
 * Validate whether a normalized binding is safe to assign to an action.
 * Prevents users from accidentally binding plain typing keys (like "a" or "Enter").
 */
export function validateBindingForAction(action, rawBinding) {
  const binding = normalizeBinding(rawBinding);
  if (!binding) {
    return { valid: false, error: "Press a non-modifier key (such as K, L, M, Esc, or F2)." };
  }

  const isEscape = binding.key === "Escape";
  const isFunctionKey = FUNCTION_KEY_PATTERN.test(binding.key);
  const hasAccelerator = binding.ctrl || binding.alt;

  if (!hasAccelerator && (binding.key === "Tab" || binding.key === "Enter" || binding.key === "Backspace" || binding.key === "Delete")) {
    return {
      valid: false,
      error: `Add Ctrl or Alt with ${binding.key} so normal navigation and editing still work.`
    };
  }

  if (isEscape) {
    if (binding.ctrl || binding.alt) {
      return { valid: false, error: "Use plain Esc (or a Ctrl/Alt + key combination)." };
    }
    if (action !== SHORTCUT_ACTIONS.CLOSE_MODALS && !binding.shift) {
      return { valid: false, error: "Esc is reserved for closing dialogs or canceling recording." };
    }
    return { valid: true, binding };
  }

  if (!hasAccelerator && !isFunctionKey) {
    return {
      valid: false,
      error: "Include Ctrl or Alt (or use a Function key F1–F12) so typing isn't interrupted."
    };
  }

  // Warn/prevent hijacking plain Ctrl+L (browser address bar) unless Shift/Alt is also held
  if (binding.ctrl && !binding.shift && !binding.alt && binding.key === "l") {
    return {
      valid: false,
      error: "Ctrl+L is used by the browser address bar. Add Shift or Alt (e.g. Ctrl+Shift+L)."
    };
  }

  return { valid: true, binding };
}

/**
 * Merge a partial/stored bindings map onto DEFAULT_SHORTCUT_BINDINGS safely.
 */
export function normalizeShortcutBindings(rawMap) {
  const resolved = {
    [SHORTCUT_ACTIONS.FOCUS_COMPOSER]: { ...DEFAULT_SHORTCUT_BINDINGS[SHORTCUT_ACTIONS.FOCUS_COMPOSER] },
    [SHORTCUT_ACTIONS.CLOSE_MODALS]: { ...DEFAULT_SHORTCUT_BINDINGS[SHORTCUT_ACTIONS.CLOSE_MODALS] },
    [SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD]: { ...DEFAULT_SHORTCUT_BINDINGS[SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD] }
  };

  if (!rawMap || typeof rawMap !== "object") return resolved;

  const actions = Object.values(SHORTCUT_ACTIONS);
  for (const action of actions) {
    if (!rawMap[action]) continue;
    const check = validateBindingForAction(action, rawMap[action]);
    if (check.valid && check.binding) {
      resolved[action] = check.binding;
    }
  }

  // Deduplicate any stored conflicts by keeping earlier action and falling back to default
  const seen = [];
  for (const action of actions) {
    if (seen.some((prev) => bindingsEqual(prev, resolved[action]))) {
      resolved[action] = { ...DEFAULT_SHORTCUT_BINDINGS[action] };
    }
    seen.push(resolved[action]);
  }

  return resolved;
}

/**
 * Find whether candidateBinding conflicts with another action in bindings.
 * Returns the conflicting action ID or null.
 */
export function findShortcutConflict(bindings, targetAction, candidateBinding) {
  const normalized = normalizeBinding(candidateBinding);
  if (!normalized) return null;
  const currentMap = normalizeShortcutBindings(bindings);
  for (const action of Object.values(SHORTCUT_ACTIONS)) {
    if (action === targetAction) continue;
    if (bindingsEqual(currentMap[action], normalized)) {
      return action;
    }
  }
  return null;
}

/**
 * Convert a live KeyboardEvent during rebinding capture into a binding object.
 * Returns null for modifier-only presses so the UI waits for the final key.
 */
export function bindingFromKeyboardEvent(eventLike) {
  if (!eventLike || typeof eventLike !== "object" || eventLike.isComposing) return null;
  const key = normalizeKeyName(eventLike.key, eventLike.code);
  if (!key) return null;
  return {
    key,
    ctrl: Boolean(eventLike.ctrlKey || eventLike.metaKey),
    shift: Boolean(eventLike.shiftKey),
    alt: Boolean(eventLike.altKey)
  };
}

/**
 * Return an array of individual display key tokens for rendering <kbd> caps.
 */
export function formatShortcutKeys(rawBinding) {
  const binding = normalizeBinding(rawBinding);
  if (!binding) return [];
  const parts = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  const keyLabel = SPECIAL_KEY_DISPLAY[binding.key]
    || (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  parts.push(keyLabel);
  return parts;
}

/**
 * Format a binding as a single human-readable shortcut string (e.g. "Ctrl+Shift+L").
 */
export function formatShortcutBinding(rawBinding) {
  return formatShortcutKeys(rawBinding).join("+");
}

/**
 * Format a binding into a standard aria-keyshortcuts attribute string.
 */
export function formatAriaKeyshortcuts(rawBinding) {
  const binding = normalizeBinding(rawBinding);
  if (!binding) return "";
  const keyToken = binding.key === " "
    ? "Space"
    : (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);

  const build = (primaryMod) => {
    const parts = [];
    if (binding.ctrl) parts.push(primaryMod);
    if (binding.alt) parts.push("Alt");
    if (binding.shift) parts.push("Shift");
    parts.push(keyToken);
    return parts.join("+");
  };

  if (binding.ctrl) {
    return `${build("Control")} ${build("Meta")}`;
  }
  return build("Control");
}

/**
 * Check if a KeyboardEvent matches a specific normalized binding.
 */
export function eventMatchesBinding(eventLike, rawBinding) {
  if (!eventLike || typeof eventLike !== "object") return false;
  if (eventLike.isComposing || eventLike.defaultPrevented) return false;
  const binding = normalizeBinding(rawBinding);
  if (!binding) return false;

  const hasPrimary = Boolean(eventLike.ctrlKey || eventLike.metaKey);
  const hasShift = Boolean(eventLike.shiftKey);
  const hasAlt = Boolean(eventLike.altKey);

  if (binding.ctrl !== hasPrimary) return false;
  if (binding.shift !== hasShift) return false;
  if (binding.alt !== hasAlt) return false;

  const eventKey = normalizeKeyName(eventLike.key, eventLike.code);
  return eventKey === binding.key;
}

/**
 * Resolve a DOM KeyboardEvent (or plain event-like object) to a global shortcut action
 * using the active shortcut bindings (defaults to DEFAULT_SHORTCUT_BINDINGS).
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
 * @param {Record<string, { key: string, ctrl: boolean, shift: boolean, alt: boolean }>} [bindings]
 * @returns {"focus_composer" | "close_modals" | "cycle_soul_mood" | null}
 */
export function resolveGlobalShortcut(eventLike, bindings = DEFAULT_SHORTCUT_BINDINGS) {
  if (!eventLike || typeof eventLike !== "object") return null;
  if (eventLike.isComposing || eventLike.defaultPrevented) return null;

  const activeMap = bindings === DEFAULT_SHORTCUT_BINDINGS
    ? DEFAULT_SHORTCUT_BINDINGS
    : normalizeShortcutBindings(bindings);

  // Check close_modals first so dismissing an overlay takes priority if ever overlapping
  const order = [
    SHORTCUT_ACTIONS.CLOSE_MODALS,
    SHORTCUT_ACTIONS.FOCUS_COMPOSER,
    SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD
  ];

  for (const action of order) {
    if (eventMatchesBinding(eventLike, activeMap[action])) {
      return action;
    }
  }
  return null;
}

/**
 * Determine whether a KeyboardEvent is the `?` shortcut help trigger
 * (only when the user is not typing inside an editable field).
 */
export function isShortcutHelpTrigger(eventLike, isEditableTarget = false) {
  if (!eventLike || typeof eventLike !== "object") return false;
  if (eventLike.isComposing || eventLike.defaultPrevented || isEditableTarget) return false;
  if (eventLike.ctrlKey || eventLike.metaKey || eventLike.altKey) return false;
  return eventLike.key === "?" || (eventLike.code === "Slash" && Boolean(eventLike.shiftKey));
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieShortcuts = Object.freeze({
    SHORTCUT_ACTIONS,
    SHORTCUT_STORAGE_KEY,
    DEFAULT_SHORTCUT_BINDINGS,
    GLOBAL_SHORTCUTS,
    BUILTIN_REFERENCE_SHORTCUTS,
    formatMoodLabel,
    normalizeKeyName,
    normalizeBinding,
    bindingsEqual,
    validateBindingForAction,
    normalizeShortcutBindings,
    findShortcutConflict,
    bindingFromKeyboardEvent,
    formatShortcutKeys,
    formatShortcutBinding,
    formatAriaKeyshortcuts,
    eventMatchesBinding,
    resolveGlobalShortcut,
    isShortcutHelpTrigger
  });
}
