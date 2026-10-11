import { describe, expect, it } from "vitest";
import { runCheck } from "../src/builder/evaluate.js";
import { IR_GUIDE } from "../src/builder/guide.js";
import { enumProblem } from "../src/builder/nodes.js";
import { checkAction } from "../src/core/actionGate.js";
import { anvilWith, FakeClient } from "./helpers.js";

describe("check values", () => {
  it("an empty expected value matches each empty actual value", () => {
    expect(runCheck({ dispute_id: null }, { path: "dispute_id", op: "equals", value: "" }).passed).toBe(true);
    expect(runCheck({}, { path: "dispute_id", op: "equals", value: null }).passed).toBe(true);
    expect(runCheck({ dispute_id: "" }, { path: "dispute_id", op: "equals", value: null }).passed).toBe(true);
    expect(runCheck({ dispute_id: "D-1" }, { path: "dispute_id", op: "equals", value: "" }).passed).toBe(false);
    expect(runCheck({ v: "Yes" }, { path: "v", op: "equals", value: "yes" }).passed).toBe(true);
    expect(runCheck({ v: { a: 1 } }, { path: "v", op: "equals", value: { a: 1 } }).passed).toBe(true);
  });

  it("an equals check with a text outside the enum of its field is a guess", () => {
    const shape = { type: "object", properties: { status: { type: "string", enum: ["verified", "failed"] }, note: { type: "string" } } };
    expect(enumProblem(shape, { path: "status", op: "equals", value: "not_verified" })).toBe(true);
    expect(enumProblem(shape, { path: "status", op: "equals", value: "Failed" })).toBe(false);
    expect(enumProblem(shape, { path: "note", op: "equals", value: "x" })).toBe(false);
    expect(enumProblem(shape, { path: "status", op: "contains", value: "x" })).toBe(false);
    expect(enumProblem(shape, { path: "a.status", op: "equals", value: "x" })).toBe(false);
    expect(enumProblem(undefined, { path: "status", op: "equals", value: "x" })).toBe(false);
  });
});

describe("an action without a confirmation", () => {
  it("the gate checks only the rules when the rules say to act at once", async () => {
    const client = new FakeClient();
    const anvil = await anvilWith(client);
    const turns = [
      { role: "user", content: "My card is stolen. Freeze it now." },
      { role: "assistant", content: "Give me your date of birth." },
      { role: "user", content: "1988-04-17" },
    ];
    const r = await checkAction(anvil.runs.brain, { action: "freeze C-4821", conversation: turns, rules: ["Freeze a lost card at once after the verification."], requireConfirmation: false }, 0.6);
    expect(r).toMatchObject({ allowed: true, confirmed: null });
    expect(Object.keys(client.decisions.at(-1)!.questions)).toEqual(["rule_0"]);
    expect(IR_GUIDE).toMatch(/set \\?`?"requireConfirmation": false\\?`? on its gate/);
    expect(IR_GUIDE).toMatch(/tell the user that the rule excludes it and why/);
  });
});
