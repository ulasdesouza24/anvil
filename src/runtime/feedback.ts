import { nanoid } from "nanoid";
import { STE_RULES } from "../core/ste.js";
import type { KVStore } from "../core/registry.js";
import type { RunRecord, TestCase } from "../core/types.js";
import type { Brain } from "../llm/brain.js";
import type { FileStore } from "../store/fileStore.js";
import type { RunManager } from "./runManager.js";

/**
 * Feedback becomes a test (docs/FEEDBACK.md). A person marks a run output as
 * wrong and writes why. The reason becomes the criteria of a new test with the input of that run.
 * "Improve from feedback" starts evolve, which tries to pass the new tests.
 */

export interface Feedback {
  id: string;
  agentId: string;
  /** The version of the run. */
  version: number;
  runId: string;
  reason: string;
  expected?: string;
  /** The test that the feedback made. */
  testId: string;
  criteria: string[];
  at: number;
}

const NS = "feedback";

/** The id of a feedback test: "f" and a number. Evolve keeps it as it is, like a given test. */
export const FEEDBACK_TEST = /^f\d+$/;

export interface FeedbackDeps {
  store: FileStore;
  kv: KVStore;
  brain: Brain;
  runs: RunManager;
}

export class FeedbackService {
  constructor(private deps: FeedbackDeps) {}

  /** Changes the words of a person into criteria that a judge can check from the output. */
  private async criteriaOf(run: RunRecord, reason: string, expected: string | undefined, description: string): Promise<{ name: string; criteria: string[] }> {
    return this.deps.brain.json<{ name: string; criteria: string[] }>({
      purpose: "feedback to test",
      system: `A person says that an output of an AI agent is wrong. Change the words of the person into test criteria.
- Each criterion is a yes/no statement about a GOOD output for the same input. A judge must be able to check it from the output alone.
- Keep the meaning of the person. Do not add requirements that the person does not give.
- Write 1 to 3 criteria, and a short name for the test.
- Write in STE.

${STE_RULES}`,
      user: JSON.stringify({ agent: description, input: run.input, wrong_output: run.output, reason, ...(expected ? { expected_output: expected } : {}) }),
      schema: {
        type: "object",
        properties: { name: { type: "string" }, criteria: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } },
        required: ["name", "criteria"],
      },
      maxTokens: 800,
    });
  }

  /** Saves a feedback for a run, and adds its test to the version of the run. */
  async add(runId: string, body: { reason: string; expected?: string }): Promise<{ feedback: Feedback; test: TestCase }> {
    const reason = body.reason?.trim();
    if (!reason) throw new Error("Give the reason: what is wrong in the output");
    const run = await this.deps.runs.getRun(runId);
    if (!run) throw new Error(`Run "${runId}" does not exist`);
    const agent = this.deps.store.getAgent(run.agentId);
    if (!agent || agent.system) throw new Error("Feedback is for the runs of your agents only");
    if (run.status !== "completed" && run.output === undefined) throw new Error("The run has no output");
    // The test goes to the current version: evolve improves that version. The feedback keeps the version of the run.
    const version = agent.versions.find((v) => v.version === agent.currentVersion)!;
    const expected = body.expected?.trim() || undefined;
    const c = await this.criteriaOf(run, reason, expected, `${agent.name}: ${agent.description}`);
    const tests = version.spec.tests ?? [];
    const n = 1 + tests.filter((t) => FEEDBACK_TEST.test(t.id)).length;
    const test: TestCase = {
      id: `f${n}`,
      name: `feedback: ${c.name}`.slice(0, 120),
      input: (run.input && typeof run.input === "object" ? run.input : { input: run.input }) as Record<string, unknown>,
      criteria: [...c.criteria, ...(expected ? [`The output agrees with this expected result: ${expected}`] : [])],
      checks: [],
    };
    await this.deps.store.setTests(agent.id, version.version, [...tests, test]);
    const feedback: Feedback = { id: `fb_${nanoid(10)}`, agentId: agent.id, version: run.version, runId, reason, ...(expected ? { expected } : {}), testId: test.id, criteria: test.criteria, at: Date.now() };
    await this.deps.kv.set(NS, feedback.id, feedback);
    return { feedback, test };
  }

  async list(agentId?: string): Promise<Feedback[]> {
    const all = Object.values((await this.deps.kv.list(NS)) as Record<string, Feedback>);
    return all.filter((f) => !agentId || f.agentId === agentId).sort((a, b) => b.at - a.at);
  }

  /** Starts evolve on the current version: it runs all tests, also the feedback tests, and tries to pass them. */
  improve(agentId: string, rounds = 2): RunRecord {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent || agent.system) throw new Error(`Agent "${agentId}" does not exist`);
    const tests = this.deps.store.getSpec(agentId)?.tests ?? [];
    if (!tests.some((t) => FEEDBACK_TEST.test(t.id))) throw new Error("The current version has no feedback test. Give feedback on a run first.");
    return this.deps.runs.start({ agentId: "anvil-evolver" }, { agentId, rounds }, { kind: "refine" });
  }
}
