/**
 * The quality of an agent version, from its evaluation. The builder publishes
 * the best version that it finds, also when no test passes. This label tells
 * the person how much to trust that version.
 */
export type Quality = "passed" | "partial" | "failed" | "untested";

export function qualityOf(ev: { passRate?: number | null; results?: unknown[]; environmentTests?: number } | null | undefined): Quality {
  if (!ev || ev.passRate === null || ev.passRate === undefined || (Array.isArray(ev.results) && !ev.results.length)) return "untested";
  // When the environment (for example a rate limit) stopped every test, the evaluation shows nothing about the agent.
  if (Array.isArray(ev.results) && ev.environmentTests && ev.environmentTests >= ev.results.length) return "untested";
  if (ev.passRate >= 1) return "passed";
  return ev.passRate > 0 ? "partial" : "failed";
}

export const QUALITY_TEXT: Record<Quality, string> = {
  passed: "All tests pass.",
  partial: "Some tests fail. Examine the failed tests before you use this agent.",
  failed: "No test passes. Do not trust the output of this agent. Evolve or refine it first.",
  untested: "This version has no evaluation, or the environment (for example a rate limit of a source) stopped all its tests.",
};

/** The text for each blame: a short label, and what the person can do. */
export const BLAME_TEXT: Record<import("./types.js").FailureBlame, { label: string; meaning: string; action: string }> = {
  agent: { label: "Agent error", meaning: "The output of the agent is wrong or incomplete for this input.", action: "Use Evolve, or describe the fix in Edit & refine." },
  test_live_value: {
    label: "Test error: live value",
    meaning: "The test expects an exact value, count, or ranking from live data. A test cannot know it.",
    action: "Change the test in Edit & refine to check the shape and the consistency of the data.",
  },
  test_contradicts: { label: "Test error: contradiction", meaning: "The test contradicts the task or its own input.", action: "Correct or remove the test in Edit & refine." },
  test_outside: {
    label: "Test error: outside knowledge",
    meaning: "The test needs knowledge, exact wording, or data that the output does not show.",
    action: "Change the test in Edit & refine.",
  },
  test_unattended: {
    label: "Test error: unattended run",
    meaning: "The test expects a waiting or unapproved state. Tests approve all steps automatically.",
    action: "Change the test to expect the state after the approval.",
  },
  unclear: { label: "Unclear", meaning: "The diagnosis cannot tell if the agent or the test is wrong.", action: "Compare the output with the requirement yourself." },
};

export const isTestBlame = (b: import("./types.js").FailureBlame) => b.startsWith("test_");
