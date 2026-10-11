import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TestCaseZ, type Check, type TestCase } from "./types.js";

/**
 * Tests from outside. A task or a benchmark can come with its own tests.
 * This module reads the common formats and makes Anvil test cases:
 * - Anvil tests: {name, input, criteria, checks, conversation}.
 * - Input and expected output: {input, expected_output | expected | output}.
 * - A user scenario with tool calls: {instruction | user_instruction | scenario, actions: [{name, arguments}], outputs: [...]}.
 *   It becomes a conversation test. The criteria check the tool calls and the answers in the transcript.
 * - A conversation: {messages: [{role, content}], expected}.
 * A file or a value can have a list, or {tests | cases | tasks: [...]}.
 */

type Raw = Record<string, unknown>;

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const firstOf = (o: Raw, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");

/** Exact checks for the simple fields of an expected object. Other fields go to the criteria. */
function expectedChecks(expected: unknown): Check[] {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return [];
  return Object.entries(expected as Raw)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => ({ path: k, op: "equals" as const, value: v }));
}

function one(raw: unknown, i: number): TestCase {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`test ${i + 1}: a test must be an object`);
  const o = raw as Raw;
  const id = `x${i + 1}`;
  const name = String(firstOf(o, ["name", "id", "title", "task_id"]) ?? `external test ${i + 1}`);
  const criteria = (Array.isArray(o.criteria) ? o.criteria.map(String) : []).filter((c) => c.trim());

  // An Anvil test.
  if (o.input && typeof o.input === "object" && (Array.isArray(o.criteria) || Array.isArray(o.checks) || o.conversation)) {
    return TestCaseZ.parse({ id, name, input: o.input, criteria, checks: o.checks ?? [], ...(o.conversation ? { conversation: o.conversation } : {}) });
  }

  // A user scenario with expected tool calls and answers (for example a tau-bench task).
  const scenario = firstOf(o, ["instruction", "user_instruction", "scenario", "user_scenario"]);
  if (scenario !== undefined) {
    const s = typeof scenario === "object" ? (scenario as Raw) : { instructions: scenario };
    const goal = text(firstOf(s, ["instructions", "task_instructions", "goal", "reason_for_call"]) ?? scenario);
    const actions = Array.isArray(o.actions) ? (o.actions as Raw[]) : [];
    const outputs = Array.isArray(o.outputs) ? o.outputs.map(text) : [];
    const known = firstOf(s, ["known_info", "facts"]);
    return TestCaseZ.parse({
      id,
      name,
      input: o.input && typeof o.input === "object" ? o.input : {},
      criteria: [
        ...criteria,
        ...actions.map((a) => `The agent calls the tool "${String(a.name ?? a.tool ?? "")}" with at least these argument values: ${JSON.stringify(a.arguments ?? a.kwargs ?? a.args ?? {})}. More arguments are correct.`),
        ...outputs.map((x) => `The agent tells the user: ${x}`),
        ...(actions.length || outputs.length || criteria.length ? [] : ["The agent does what the user asks, or explains why it cannot."]),
      ],
      checks: [],
      conversation: {
        persona: text(firstOf(s, ["persona", "domain", "user"]) ?? "A customer"),
        goal,
        // The instructions talk to the user ("You want to …"): they are not a message. Without a first message, the simulated user writes one.
        firstMessage: text(firstOf(s, ["first_message", "firstMessage"]) ?? ""),
        facts: known && typeof known === "object" ? known : known ? { known: known } : {},
        maxTurns: typeof o.max_turns === "number" ? o.max_turns : 10,
      },
    });
  }

  // A conversation with an expected answer.
  if (Array.isArray(o.messages)) {
    const turns = o.messages as { role?: string; content?: unknown }[];
    const users = turns.filter((m) => m.role === "user").map((m) => text(m.content ?? ""));
    const expected = firstOf(o, ["expected_output", "expected", "output", "answer"]);
    return TestCaseZ.parse({
      id,
      name,
      input: {},
      criteria: [...criteria, ...(expected !== undefined ? [`The answers of the agent agree with this expected result: ${text(expected)}`] : []), ...(criteria.length || expected !== undefined ? [] : ["The agent answers each message of the user."])],
      checks: [],
      conversation: { persona: "A user", goal: `Get answers to: ${users.join(" / ")}`, firstMessage: users[0] ?? "Hello", facts: {}, maxTurns: Math.max(1, users.length) },
    });
  }

  // An input and an expected output.
  const expected = firstOf(o, ["expected_output", "expected", "output", "answer", "target"]);
  const input = firstOf(o, ["input", "inputs", "args", "question", "prompt"]);
  if (input === undefined) throw new Error(`test ${i + 1} ("${name}"): give an input, a scenario, or messages`);
  return TestCaseZ.parse({
    id,
    name,
    input: typeof input === "object" && !Array.isArray(input) ? input : { text: input },
    criteria: [...criteria, ...(expected !== undefined ? [`The output agrees with this expected result: ${text(expected)}`] : []), ...(criteria.length || expected !== undefined ? [] : ["The output answers the input."])],
    checks: [...(Array.isArray(o.checks) ? (o.checks as Check[]) : []), ...expectedChecks(expected)],
  });
}

/**
 * Reads tests: a list, {tests | cases | tasks: [...]}, JSON or YAML text, or the path of a .json, .jsonl, or .yaml file.
 * baseDir null reads no files: the API gives values only, so a request cannot read a file of the server.
 */
export function parseExternalTests(input: unknown, baseDir: string | null = process.cwd()): TestCase[] {
  let v = input;
  if (typeof v === "string") {
    const s = v.trim();
    if (/\.(jsonl?|ya?ml)$/i.test(s) && !s.includes("\n")) {
      if (baseDir === null) throw new Error("give the tests as a value, not as a file path");
      const file = path.resolve(baseDir, s);
      const body = fs.readFileSync(file, "utf8");
      v = /\.jsonl$/i.test(file) ? body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : /\.ya?ml$/i.test(file) ? parseYaml(body) : JSON.parse(body);
    } else {
      try {
        v = JSON.parse(s);
      } catch {
        v = parseYaml(s);
      }
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Raw;
    const list = firstOf(o, ["tests", "cases", "tasks"]);
    v = Array.isArray(list) ? list : [o];
  }
  if (!Array.isArray(v)) throw new Error("Tests must be a list, {tests: [...]}, or a file with one of these");
  return v.map((x, i) => one(x, i));
}

/** Gives the tests ids that do not clash with the ids of other tests. */
export function withPrefix(tests: TestCase[], prefix: string): TestCase[] {
  return tests.map((t, i) => ({ ...t, id: `${prefix}${i + 1}` }));
}
