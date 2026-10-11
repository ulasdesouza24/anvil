import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateSpec, proseSte } from "../src/builder/evaluate.js";
import { EXAMPLE_SPEC, IR_GUIDE } from "../src/builder/guide.js";
import { validateAndRepair } from "../src/builder/repair.js";
import { CLASS_GUIDE } from "../src/core/customClass.js";
import { detectLanguage, STE_OUTPUT_RULES, STE_RULES, steFails, steLint } from "../src/core/ste.js";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { anvilWith, FakeClient } from "./helpers.js";

const BAD = "We should leverage the robust API in order to ensure that data has been obtained. It is being processed; the result was sent by the server. Don't utilize it.";
const BAD_PROMPT = "You should leverage the robust data in order to ensure that a comprehensive summary has been obtained; the summary is being written by you and it is sent to the user, and furthermore it should utilize numerous facts.";
const GOOD_PROMPT = "Write a summary of the text in three short sentences. Use only the facts in the text.";

const spec = (prompt: string, extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "s",
  name: "s",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "w", type: "llm", config: { prompt: `${prompt}\n\n{{input.text}}` } },
    { id: "output", type: "output", config: { value: "{{nodes.w.output.text}}" } },
  ],
  edges: [
    { from: "input", to: "w" },
    { from: "w", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...extra,
});

describe("STE linter (port of ste-lint.py, score v3)", () => {
  it("gives the same counts as the Python linter", () => {
    // The Python linter gives these counts for the same text.
    const r = steLint(BAD);
    expect(r.words).toBe(29);
    expect(r.violations).toEqual({
      "long_sentence(>20w)": 0,
      semicolon: 1,
      "long_paragraph(>6s)": 0,
      contraction: 1,
      passive_voice: 3,
      complex_tense: 1,
      ing_main_verb: 1,
      nominalization: 0,
      phrasal_verb: 0,
      banned_word: 4,
      marketing_adjective: 1,
      modal_hedge: 0,
    });
    expect(r.total).toBe(12);
    expect(r.per100w).toBe(41.38);
    expect(r.samples.banned).toEqual(["utilize", "leverage", "ensure", "in order to"]);
  });

  it("does not count code, quotes, or stative participles", () => {
    expect(steLint('Run the build. The `utilize; leverage` code and the "ensure; obtain" quote do not count.').total).toBe(0);
    expect(steLint("The valve is closed. The tool is installed.").violations.passive_voice).toBe(0);
    expect(steLint("The valve is closed by the operator.").violations.passive_voice).toBe(1);
  });

  it("applies only the language-neutral rules to text in another language", () => {
    const tr = "Bu bir test cümlesidir; ajan çıktısı kısa olmalı. Uzun cümleler okunması zor metinler yaratır ve kullanıcıyı yorar, bu yüzden her zaman kısa ve net yazmak gerekir çünkü okuyucu hızlı anlamak ister.";
    expect(detectLanguage(tr)).toBe("other");
    expect(detectLanguage(BAD)).toBe("en");
    const r = steLint(tr);
    expect(Object.keys(r.violations)).toEqual(["long_sentence(>20w)", "semicolon", "long_paragraph(>6s)"]);
    expect(r.total).toBe(2);
  });

  it("lets a short text have one violation", () => {
    const one = steLint("Use the tool to obtain the data from the page.");
    expect(one.total).toBe(1);
    expect(steFails(one, 4)).toBe(false);
    expect(steFails(steLint(BAD), 4)).toBe(true);
  });
});

describe("STE in the compiler", () => {
  it("reports prompt text that is not in STE, and ignores templates and good prompts", async () => {
    const anvil = await anvilWith(new FakeClient());
    const bad = validateSpec(spec(BAD_PROMPT), anvil.registry).diagnostics.filter((d) => d.code === "STE_PROMPT");
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: "warning", nodeId: "w", path: "/nodes/1/config/prompt" });
    expect(bad[0].message).toMatch(/^w: prompt is not in STE: .*words to replace: .*leverage/);
    expect(validateSpec(spec(BAD_PROMPT), anvil.registry, { ste: "error" }).errors).toBe(1);
    expect(validateSpec(spec(BAD_PROMPT), anvil.registry, { ste: "off" }).diagnostics.some((d) => d.code === "STE_PROMPT")).toBe(false);
    expect(validateSpec(spec(GOOD_PROMPT), anvil.registry, { ste: "error" }).valid).toBe(true);
    // A long template is data, not prompt text.
    const tpl = spec(`${GOOD_PROMPT} {{nodes.input.output.text ?? "a long default value that should leverage and utilize numerous words in order to ensure"}}`);
    expect(validateSpec(tpl, anvil.registry, { ste: "error" }).valid).toBe(true);
  });

  it("also checks test criteria and judge rules", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = spec(GOOD_PROMPT, {
      tests: [{ id: "t", name: "t", input: {}, criteria: [BAD_PROMPT], checks: [] }],
      acceptance: [{ id: "j", kind: "judge", criterion: BAD_PROMPT }],
    });
    const paths = validateSpec(s, anvil.registry, { ste: "error" }).diagnostics.filter((d) => d.code === "STE_PROMPT").map((d) => d.path);
    expect(paths).toEqual(["/tests/0/criteria", "/acceptance/0/criterion"]);
  });

  it("rewrites the prompt in the repair loop", async () => {
    const client = new FakeClient((req) => {
      expect(String(req.messages[0].content)).toContain("STE_PROMPT errors");
      return JSON.stringify({ operations: [{ op: "replace", path: "/nodes/1/config/prompt", value: `${GOOD_PROMPT}\n\n{{input.text}}` }] });
    });
    const anvil = await anvilWith(client);
    const out = await validateAndRepair(spec(BAD_PROMPT), { brain: anvil.runs.brain, registry: anvil.registry, maxAttempts: 2 });
    expect(out.spec?.nodes[1].config.prompt).toContain(GOOD_PROMPT);
    expect(out.attempts).toBe(1);
  });

  it("does not block the build when only STE errors remain", async () => {
    // The repairer cannot fix the text: the prompt stays the same.
    const client = new FakeClient(() => JSON.stringify({ operations: [{ op: "replace", path: "/name", value: "s2" }] }));
    const anvil = await anvilWith(client);
    const out = await validateAndRepair(spec(BAD_PROMPT), { brain: anvil.runs.brain, registry: anvil.registry, maxAttempts: 2 });
    expect(out.spec).not.toBeNull();
    expect(out.result.diagnostics.filter((d) => d.code === "STE_PROMPT").map((d) => d.severity)).toEqual(["warning"]);
  });
});

describe("STE in the builder", () => {
  it("the guides, the rules, and the example spec are in STE", async () => {
    for (const t of [IR_GUIDE, CLASS_GUIDE, STE_RULES, STE_OUTPUT_RULES]) expect(steFails(steLint(t), 4), steLint(t).samples.longSentences.join(" | ")).toBe(false);
    const anvil = await anvilWith(new FakeClient());
    expect(validateSpec(EXAMPLE_SPEC, anvil.registry, { ste: "error" }).diagnostics.filter((d) => d.code === "STE_PROMPT")).toEqual([]);
  });

  it("each meta prompt of the builder is in STE", () => {
    const files = ["src/builder/nodes.ts", "src/builder/repair.ts", "src/builder/sources.ts"];
    const failing: string[] = [];
    let count = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/(system|instructions):\s*\n?\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g)) {
        const text = m[2].slice(1, -1).replace(/\$\{[^}]*\}/g, "DATA").replace(/\\n/g, "\n");
        const r = steLint(text);
        if (r.words < 8) continue;
        count++;
        if (steFails(r, 4)) failing.push(`${f}:${src.slice(0, m.index).split("\n").length} (${r.per100w}/100w)`);
      }
    }
    expect(count).toBeGreaterThan(15);
    expect(failing).toEqual([]);
  });
});

describe("STE in agent output", () => {
  it("the llm node adds the STE rules by default, and not with the plain style", async () => {
    const client = new FakeClient(() => "Done.");
    const anvil = await anvilWith(client);
    await anvil.runs.run({ spec: spec(GOOD_PROMPT) }, { text: "x" });
    expect(String(client.chats[0].messages[0].content)).toContain(STE_OUTPUT_RULES);
    const plain = spec(GOOD_PROMPT);
    plain.nodes[1].config.style = "plain";
    plain.nodes[1].config.system = "You are a poet.";
    await anvil.runs.run({ spec: plain }, { text: "x" });
    expect(client.chats[1].messages[0].content).toBe("You are a poet.");
  });

  it("the refine node uses the STE score as one more criterion", async () => {
    let draft = 0;
    const client = new FakeClient(() => (++draft === 1 ? BAD_PROMPT : GOOD_PROMPT));
    const anvil = await anvilWith(client);
    const s = spec(GOOD_PROMPT);
    s.nodes[1] = { id: "w", type: "refine", config: { task: "Write a summary.", criteria: ["The text is a summary."] } };
    s.nodes[2] = { id: "output", type: "output", config: { value: "{{nodes.w.output}}" } };
    const r = await anvil.runs.run({ spec: s }, { text: "x" });
    const out = r.output as { text: string; passed: boolean; iterations: number; scores: Record<string, number> };
    expect(out).toMatchObject({ text: GOOD_PROMPT, passed: true, iterations: 2 });
    expect(out.scores["STE style"]).toBe(1);
    expect(String(client.chats[1].messages[1].content)).toMatch(/- STE style\n- The text is not in STE: /);
  });

  it("the evaluation report gives the STE score of the prose in the outputs", async () => {
    expect(proseSte({ id: "x_1", url: "https://example.com/a/long/path/with/many/parts/in/it", n: 3 })).toBeNull();
    expect(proseSte({ summary: BAD })).toMatchObject({ per100w: 41.38, words: 29, language: "en" });
    const anvil = await anvilWith(new FakeClient(() => BAD));
    const out = await evaluateSpec(spec(GOOD_PROMPT), [{ id: "t", name: "t", input: { text: "x" }, criteria: [], checks: [] }], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].ste?.per100w).toBe(41.38);
    expect(out.report.stePer100w).toBe(41.38);
  });
});
