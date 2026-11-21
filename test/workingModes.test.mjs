import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKING_MODE,
  WORKING_MODES,
  listWorkingModes,
  resolveWorkingMode,
  isValidWorkingMode,
  buildWorkingModePrompt
} from "../src/agent/workingModes.mjs";

describe("Adaptive Working Modes", () => {
  it("exposes all eight expected behavioural modes", () => {
    const modes = listWorkingModes();
    assert.equal(modes.length, 8);
    assert.equal(WORKING_MODES.length, 8);
    const ids = modes.map((m) => m.id);
    for (const expected of [
      "companion",
      "engineer",
      "investigator",
      "researcher",
      "planner",
      "thinking-partner",
      "creator",
      "tutor"
    ]) {
      assert.ok(ids.includes(expected), `expected mode ${expected}`);
    }
  });

  it("falls back safely to companion when mode is unknown or empty", () => {
    assert.equal(DEFAULT_WORKING_MODE, "companion");
    assert.equal(resolveWorkingMode("engineer").id, "engineer");
    assert.equal(resolveWorkingMode("  TUTOR ").id, "tutor");
    assert.equal(resolveWorkingMode("nonexistent").id, "companion");
    assert.equal(resolveWorkingMode("").id, "companion");
    assert.equal(resolveWorkingMode(null).id, "companion");
    assert.equal(isValidWorkingMode("investigator"), true);
    assert.equal(isValidWorkingMode("superuser"), false);
  });

  it("includes explicit non-escalation security guarantee in the prompt block", () => {
    const prompt = buildWorkingModePrompt("engineer");
    assert.match(prompt, /Active working mode: Engineer/i);
    assert.match(prompt, /never expand tool permissions/i);
  });
});
