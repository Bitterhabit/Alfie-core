import test from "node:test";
import assert from "node:assert/strict";
import {
  SHORTCUT_ACTIONS,
  GLOBAL_SHORTCUTS,
  formatMoodLabel,
  resolveGlobalShortcut
} from "../public/shortcuts.mjs";

test("resolveGlobalShortcut matches Ctrl+K and Cmd+K to focus_composer", () => {
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "K", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "k", metaKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);
  assert.equal(resolveGlobalShortcut({ key: "Dead", code: "KeyK", ctrlKey: true }), SHORTCUT_ACTIONS.FOCUS_COMPOSER);

  // Rejects Shift or Alt combinations and plain K
  assert.equal(resolveGlobalShortcut({ key: "k" }), null);
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, shiftKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, altKey: true }), null);
});

test("resolveGlobalShortcut matches Escape to close_modals and rejects modified Escape", () => {
  assert.equal(resolveGlobalShortcut({ key: "Escape" }), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ key: "Esc" }), SHORTCUT_ACTIONS.CLOSE_MODALS);
  assert.equal(resolveGlobalShortcut({ code: "Escape" }), SHORTCUT_ACTIONS.CLOSE_MODALS);

  assert.equal(resolveGlobalShortcut({ key: "Escape", ctrlKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape", metaKey: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape", altKey: true }), null);
});

test("resolveGlobalShortcut matches Ctrl+Shift+L and Cmd+Shift+L without hijacking Ctrl+L", () => {
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

test("resolveGlobalShortcut ignores IME composition, prevented events, and invalid inputs", () => {
  assert.equal(resolveGlobalShortcut({ key: "k", ctrlKey: true, isComposing: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "Escape", defaultPrevented: true }), null);
  assert.equal(resolveGlobalShortcut({ key: "L", ctrlKey: true, shiftKey: true, defaultPrevented: true }), null);
  assert.equal(resolveGlobalShortcut(null), null);
  assert.equal(resolveGlobalShortcut(undefined), null);
});

test("formatMoodLabel returns human-readable labels for all Alfie Soul moods", () => {
  assert.equal(formatMoodLabel("purple"), "Work");
  assert.equal(formatMoodLabel("blue"), "Good");
  assert.equal(formatMoodLabel("red"), "Alert");
  assert.equal(formatMoodLabel("amber"), "Thinking");
  assert.equal(formatMoodLabel("PURPLE"), "Work");
  assert.equal(formatMoodLabel(""), "Work");
  assert.equal(formatMoodLabel("emerald"), "Emerald");
  assert.equal(GLOBAL_SHORTCUTS.length, 3);
});
