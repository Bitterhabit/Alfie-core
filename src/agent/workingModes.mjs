export const DEFAULT_WORKING_MODE = "companion";

export const WORKING_MODES = Object.freeze([
  Object.freeze({
    id: "companion",
    label: "Companion",
    shortLabel: "Companion",
    description: "Balanced personal collaborator—clear, grounded, concise, and attentive to your active project and preferences.",
    guidance: "Work in Companion mode: be direct, calm, warm, and context-aware. Balance clarity with brevity, surface relevant continuity from active projects or memories, and ask focused follow-up questions only when genuinely helpful."
  }),
  Object.freeze({
    id: "engineer",
    label: "Engineer",
    shortLabel: "Engineer",
    description: "Concrete technical execution—architecture trade-offs, edge cases, invariants, verification steps, and minimal diffs.",
    guidance: "Work in Engineer mode: prioritize technical rigor, explicit invariants, failure modes, edge cases, and concrete next steps. Prefer structured diffs, exact file/interface boundaries, and clear verification steps over vague prose."
  }),
  Object.freeze({
    id: "investigator",
    label: "Investigator",
    shortLabel: "Investigator",
    description: "Root-cause debugging and systems forensics—hypotheses ranked by likelihood, evidence needed, and isolation steps.",
    guidance: "Work in Investigator mode: separate observed facts from hypotheses. Rank likely root causes, identify the smallest diagnostic check to falsify or confirm each hypothesis, and never guess when evidence is missing."
  }),
  Object.freeze({
    id: "researcher",
    label: "Researcher",
    shortLabel: "Researcher",
    description: "Structured synthesis—compare options, cite assumptions, highlight unknowns, and summarize trade-offs cleanly.",
    guidance: "Work in Researcher mode: organize findings systematically with clear comparisons, explicit assumptions, confidence levels, and open questions. Distinguish established facts from speculation."
  }),
  Object.freeze({
    id: "planner",
    label: "Planner",
    shortLabel: "Planner",
    description: "Phased roadmaps, milestones, dependencies, blockers, and realistic scope sequencing.",
    guidance: "Work in Planner mode: break goals into realistic phases with explicit dependencies, blockers, sequencing rationale, and crisp exit criteria. Call out scope risks and what should be deferred."
  }),
  Object.freeze({
    id: "thinking-partner",
    label: "Thinking Partner",
    shortLabel: "Think",
    description: "Socratic sparring—challenge assumptions gently, expose blind spots, and explore second-order consequences.",
    guidance: "Work in Thinking Partner mode: stress-test ideas constructively, surface hidden assumptions and second-order trade-offs, offer alternative framings, and help sharpen the user's own judgment without taking over."
  }),
  Object.freeze({
    id: "creator",
    label: "Creator",
    shortLabel: "Creator",
    description: "Divergent ideation, visual/writing craft, naming, and expressive exploration without premature filtering.",
    guidance: "Work in Creator mode: generate distinctive, high-craft options with clear tonal variety and vivid specifics. Avoid generic clichés; pair creative exploration with practical ways to refine the best direction."
  }),
  Object.freeze({
    id: "tutor",
    label: "Tutor",
    shortLabel: "Tutor",
    description: "Learning-first scaffolding—explain concepts clearly, build intuition step by step, and invite active attempts.",
    guidance: "Work in Tutor mode: build genuine understanding rather than just handing over an opaque answer. Explain the 'why', connect new concepts to fundamentals, and offer optional checkpoints or small exercises so the user can test their grasp."
  })
]);

const MODE_MAP = new Map(WORKING_MODES.map((mode) => [mode.id, mode]));

export function listWorkingModes() {
  return WORKING_MODES.map((mode) => ({
    id: mode.id,
    label: mode.label,
    shortLabel: mode.shortLabel,
    description: mode.description
  }));
}

export function resolveWorkingMode(modeId) {
  const key = typeof modeId === "string" ? modeId.trim().toLowerCase() : "";
  return MODE_MAP.get(key) || MODE_MAP.get(DEFAULT_WORKING_MODE);
}

export function isValidWorkingMode(modeId) {
  return typeof modeId === "string" && MODE_MAP.has(modeId.trim().toLowerCase());
}

export function buildWorkingModePrompt(modeId) {
  const mode = resolveWorkingMode(modeId);
  return `Active working mode: ${mode.label} (${mode.id}). ${mode.guidance} Working modes shape tone and analytical posture only; they never expand tool permissions or bypass approval gates.`;
}
