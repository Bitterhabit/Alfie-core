import test from "node:test";
import assert from "node:assert/strict";
import {
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUT_BINDINGS,
  GLOBAL_SHORTCUTS,
  BUILTIN_REFERENCE_SHORTCUTS,
  formatMoodLabel,
  normalizeShortcutBindings,
  validateBindingForAction,
  findShortcutConflict,
  bindingFromKeyboardEvent,
  formatShortcutKeys,
  formatShortcutBinding,
  formatAriaKeyshortcuts,
  resolveGlobalShortcut,
  isShortcutHelpTrigger
} from "../public/shortcuts.mjs";

test("resolveGlobalShortcut matches default Ctrl+K, Esc, and Ctrl+Shift+L accurately", () => {
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "K", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "k", metaKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "Dead", code: "KeyK", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);

  assert.equal(resolveGlobalShortcut({ key: "k" }), null);
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, shiftKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, altKey: true }), null);

  assert.equal(resolveGlobalShortcut({ key: "Escape" }), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ key: "Esc" }), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ code: "Escape" }), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ key: "Escape", ctrlKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape", altKey: true }), null);

  assert.equal(resolveGlobalShortcut({ key: "L", ctrlKey: true, shiftKey: true }), SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD);
  assert.equal(resolveGlobalShortcut({ key: "l", ctrlKey: true, shiftKey: true }), SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD);
  assert.equal(resolveGlobalShortcut({ key: "L", metaKey: true, shiftKey: true }), SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD);
  assert.equal(resolveGlobalShortcut({ key: "Dead", code: "KeyL", ctrlKey: true, shiftKey: true }), SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD);

  // Must not hijack browser address bar Ctrl+L or plain L
  assert.equal(resolveGlobalShortcut({ key: "l", ctrlKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "l", metaKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "L", shiftKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "L", ctrlKey: true, shiftKey: true, altKey: true }), null);
});

test("resolveGlobalShortcut honors custom rebound shortcuts", () => {
  const custom = normalizeShortcutBindings({
    [SHORTCUT_ACTIONS.FOCUS_COMPOSER]: { key: "j", ctrl: true, shift: false, alt: false },
    [SHORTCUT_ACTIONS.CLOSE_MODALS]: { key: "x", ctrl: false, shift: false, alt: true },
    [SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD]: { key: "m", ctrl: false, shift: false, alt: true }
  });

  // New custom bindings work
  assert.equal(resolveGlobalShortcut({ key: "j", ctrlKey: true }, custom), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "x", altKey: true }, custom), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ key: "m", altKey: true }, custom), SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD);

  // Old defaults no longer fire when rebound
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true }, custom), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape" }, custom), null);
  assert.equal(resolveGlobalShortcut({ key: "L", ctrlKey: true, shiftKey: true }, custom), null);
});

test("validateBindingForAction rejects unsafe bindings and accepts valid combos", () => {
  // Plain printable keys rejected so typing is never interrupted
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.FOCUS_COMPOSER, { key: "a", ctrl: false, shift: false, alt: false }).valid, false);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.FOCUS_COMPOSER, { key: "Enter", ctrl: false, shift: false, alt: false }).valid, false);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.FOCUS_COMPOSER, { key: "Tab", ctrl: false, shift: false, alt: false }).valid, false);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD, { key: "l", ctrl: true, shift: false, alt: false }).valid, false);

  // Valid custom bindings
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.FOCUS_COMPOSER, { key: "j", ctrl: true, shift: false, alt: false }).valid, true);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD, { key: "F4", ctrl: false, shift: false, alt: false }).valid, true);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.CLOSE_MODALS, { key: "Escape", ctrl: false, shift: false, alt: false }).valid, true);
  assert.equal(validateBindingForAction(SHORTCUT_ACTIONS.CLOSE_MODALS, { key: "w", ctrl: false, shift: false, alt: true }).valid, true);
});

test("findShortcutConflict detects collisions against other actions only", () => {
  const bindings = normalizeShortcutBindings(DEFAULT_SHORTCUT_BINDINGS);
  assert.equal(
    findShortcutConflict(bindings, SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD, { key: "k", ctrl: true, shift: false, alt: false }),
    SHORTCUT_ACTIONS.FOCUS_COMPOSER
  );
  // Same binding on the same action is not a conflict
  assert.equal(
    findShortcutConflict(bindings, SHORTCUT_ACTIONS.FOCUS_COMPOSER, { key: "k", ctrl: true, shift: false, alt: false }),
    null
  );
  // Unused binding has no conflict
  assert.equal(
    findShortcutConflict(bindings, SHORTCUT_ACTIONS.CYCLE_SOUL_MOOD, { key: "m", ctrl: false, shift: false, alt: true }),
    null
  );
});

test("bindingFromKeyboardEvent ignores modifier-only presses and extracts combos cleanly", () => {
  assert.equal(bindingFromKeyboardEvent({ key: "Control", ctrlKey: true }), null);
  assert.equal(bindingFromKeyboardEvent({ key: "Shift", shiftKey: true }), null);
  assert.equal(bindingFromKeyboardEvent({ key: "Alt", altKey: true }), null);
  assert.deepEqual(
    bindingFromKeyboardEvent({ key: "M", code: "KeyM", altKey: true, shiftKey: true }),
    { key: "m", ctrl: false, shift: true, alt: true }
  );
  assert.deepEqual(
    bindingFromKeyboardEvent({ key: "µ", code: "KeyM", altKey: true }),
    { key: "m", ctrl: false, shift: false, alt: true }
  );
});

test("formatting helpers produce clean key caps, labels, and aria-keyshortcuts", () => {
  assert.deepEqual(formatShortcutKeys(DEFAULT_SHORTCUT_BINDINGS.focus_composer), ["Ctrl", "K"]);
  assert.equal(formatShortcutBinding(DEFAULT_SHORTCUT_BINDINGS.focus_composer), "Ctrl+K");
  assert.equal(formatAriaKeyshortcuts(DEFAULT_SHORTCUT_BINDINGS.focus_composer), "Control+K Meta+K");

  assert.deepEqual(formatShortcutKeys(DEFAULT_SHORTCUT_BINDINGS.close_modals), ["Esc"]);
  assert.equal(formatShortcutBinding(DEFAULT_SHORTCUT_BINDINGS.close_modals), "Esc");
  assert.equal(formatAriaKeyshortcuts(DEFAULT_SHORTCUT_BINDINGS.close_modals), "Escape");

  assert.deepEqual(formatShortcutKeys(DEFAULT_SHORTCUT_BINDINGS.cycle_soul_mood), ["Ctrl", "Shift", "L"]);
  assert.equal(formatShortcutBinding(DEFAULT_SHORTCUT_BINDINGS.cycle_soul_mood), "Ctrl+Shift+L");
  assert.equal(formatAriaKeyshortcuts(DEFAULT_SHORTCUT_BINDINGS.cycle_soul_mood), "Control+Shift+L Meta+Shift+L");
});

test("isShortcutHelpTrigger detects ? only outside editable fields", () => {
  assert.equal(isShortcutHelpTrigger({ key: "?", shiftKey: true }, false), true);
  assert.equal(isShortcutHelpTrigger({ key: "?", shiftKey: true }, true), false);
  assert.equal(isShortcutHelpTrigger({ key: "?", ctrlKey: true }, false), false);
  assert.equal(isShortcutHelpTrigger({ key: "/", shiftKey: false }, false), false);
});

test("resolveGlobalShortcut ignores IME composition, prevented events, and invalid inputs", () => {
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, isComposing: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape", defaultPrevented: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "L", ctrlKey: true, shiftKey: true, defaultPrevented: true }), null);
  assert.equal(resolveGlobalShortcut(null), null);
  assert.equal(resolveGlobalShortcut(undefined), null);
});

test("formatMoodLabel and shortcut metadata tables are populated", () => {
  assert.equal(formatMoodLabel("purple"), "Work");
  assert.equal(formatMoodLabel("blue"), "Good");
  assert.equal(formatMoodLabel("red"), "Alert");
  assert.equal(formatMoodLabel("amber"), "Thinking");
  assert.equal(formatMoodLabel("PURPLE"), "Work");
  assert.equal(formatMoodLabel(""), "Work");
  assert.equal(formatMoodLabel("emerald"), "Emerald");
  assert.equal(GLOBAL_SHORTCUTS.length, 3);
  assert.ok(BUILTIN_REFERENCE_SHORTCUTS.length >= 4);
});
