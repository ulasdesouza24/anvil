import type { AgentSpec } from "../core/types.js";

/**
 * The builder is itself a Anvil agent: a JSON workflow of node classes, executed
 * by the same engine that runs the agents it builds. The UI renders it like any
 * other agent, and its runs stream the same events.
 */

const systemPolicy = { maxCostUsd: 3, maxNodeExecutions: 500, timeoutMs: 1_800_000, requireApprovalForSideEffects: false };

export const BUILDER_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-builder",
  name: "Anvil Builder",
  description: "The meta-agent: turns a plain-language process description into a compiled, tested and evolved agent.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string", description: "What the agent should do, in plain language" },
      answers: { type: "object", description: "Optional answers to clarifying questions", default: {} },
      clarify: { type: "boolean", description: "Allow the builder to ask clarifying questions", default: true },
      evaluate: { type: "boolean", description: "Run the synthesized test suite", default: true },
      optimize: { type: "boolean", description: "Iteratively improve the agent from failing tests", default: true },
      testCount: { type: "integer", minimum: 1, maximum: 8, default: 3 },
      confirmAboveUsd: { type: "number", minimum: 0, description: "Ask before building when the high cost estimate is above this value (default: the config value)" },
      askOnCost: { type: "boolean", default: true, description: "false: never ask, stop the build when the estimate is above the limit" },
      allowUnresolved: { type: "boolean", default: false, description: "Continue when a required data need has no working source" },
      useLibrary: { type: "boolean", default: true, description: "Use tested library agents of the same class as examples, and the lessons of the domain" },
      examples: { type: "array", items: { type: "string" }, default: [], description: "Library agent ids to use as examples (they skip the similarity check)" },
      files: { type: "array", items: { type: "string" }, default: [], description: "Ids of attached files (POST /api/files): samples of the input, reference data, or context" },
      publish: { type: "boolean", default: true, description: "false: do not save the agent, give its spec and evaluation in the output (a best-of-N candidate, docs/SELECTION.md)" },
      builderModel: { type: "string", description: "The builder model of a best-of-N candidate. The run options set it: this field only records it." },
      tools: { description: "Given tools (docs/TOOLS.md): an OpenAPI 3 document, function definitions, or {tools: [...]}. With tools, the agent uses only them." },
      tests: { description: "Given tests (docs/TESTS.md): Anvil tests, {input, expected_output} pairs, or user scenarios. The evaluation uses them with the generated tests." },
      excludeExamples: { type: "array", items: { type: "string" }, default: [], description: "Library agent ids not to use as examples" },
    },
    required: ["request"],
  },
  nodes: [
    { id: "input", type: "input", name: "Request", config: {} },
    {
      id: "tools",
      type: "anvil_tools",
      name: "Given tools",
      description: "Read the given tools and save them as classes (a closed build)",
      config: { tools: "{{input.tools}}" },
    },
    {
      id: "triage",
      type: "anvil_triage",
      name: "Triage",
      description: "System 1 fan-out: clarity, pattern, complexity, capability flags",
      config: {
        request: "{{input.request}}",
        clarifications: "{{input.answers}}",
        evaluate: "{{input.evaluate}}",
        optimize: "{{input.optimize}}",
        confirmAboveUsd: "{{input.confirmAboveUsd}}",
        askOnCost: "{{input.askOnCost}}",
      },
    },
    {
      id: "cost_gate",
      type: "router",
      name: "Cost check",
      description: "Compare the cost estimate with the limit",
      config: {
        rules: [
          { port: "stop", when: { left: "{{nodes.triage.output.estimate.overLimit}}", op: "truthy" } },
          { port: "ask", when: { left: "{{nodes.triage.output.estimate.needsConfirmation}}", op: "truthy" } },
        ],
        default: "go",
      },
    },
    {
      id: "approve_cost",
      type: "human_approval",
      name: "Approve the cost",
      config: { title: "This build can cost more than the limit. Continue?", payload: "{{nodes.triage.output.estimate}}" },
    },
    {
      id: "cancelled",
      type: "transform",
      name: "Build stopped",
      config: { value: { cancelled: true, reason: "The cost estimate is above the limit.", estimate: "{{nodes.triage.output.estimate}}" } },
    },
    { id: "cancel_output", type: "output", name: "Stopped", config: { value: "{{nodes.cancelled.output}}" } },
    {
      id: "analyze",
      type: "anvil_analyze",
      name: "Analyze",
      description: "Task spec: inputs, outputs, steps, success criteria",
      config: {
        request: "{{input.request}}",
        triage: "{{nodes.triage.output}}",
        clarifications: "{{input.answers}}",
        allowClarification: "{{input.clarify}}",
        files: "{{input.files}}",
        tools: "{{nodes.tools.output}}",
        tests: "{{input.tests}}",
      },
    },
    {
      id: "need_info",
      type: "router",
      name: "Need clarification?",
      config: { rules: [{ port: "ask", when: { left: "{{nodes.analyze.output.needsClarification}}", op: "truthy" } }], default: "proceed" },
    },
    {
      id: "clarify",
      type: "human_input",
      name: "Ask the user",
      description: "Blocking questions only",
      config: { title: "The builder has a few questions", questions: "{{nodes.analyze.output.taskSpec.clarifyingQuestions}}" },
    },
    {
      id: "reanalyze",
      type: "anvil_analyze",
      name: "Re-analyze",
      description: "Fold the answers into the task spec",
      config: {
        request: "{{input.request}}",
        triage: "{{nodes.triage.output}}",
        clarifications: "{{nodes.clarify.output.answers}}",
        allowClarification: false,
        previous: "{{nodes.analyze.output.taskSpec}}",
        files: "{{input.files}}",
        tools: "{{nodes.tools.output}}",
        tests: "{{input.tests}}",
      },
    },
    {
      id: "library",
      type: "anvil_library",
      name: "Library match",
      description: "Find the class of the task, the tested examples of the same class, and the lessons of the domain",
      config: {
        request: "{{input.request}}",
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        triage: "{{nodes.triage.output}}",
        enabled: "{{input.useLibrary}}",
        include: "{{input.examples}}",
        exclude: "{{input.excludeExamples}}",
      },
    },
    {
      id: "sources",
      type: "anvil_sources",
      name: "Source plan",
      description: "Find and test a data source for each data need",
      config: {
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        approve: "{{input.clarify}}",
        allowUnresolved: "{{input.allowUnresolved}}",
        request: "{{input.request}}",
        library: "{{nodes.library.output}}",
        tools: "{{nodes.tools.output}}",
      },
    },
    {
      id: "architect",
      type: "anvil_architect",
      name: "Architect",
      description: "Pick node classes, design the graph, route model tiers",
      config: {
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        triage: "{{nodes.triage.output}}",
        sourcePlan: "{{nodes.sources.output.sourcePlan}}",
        library: "{{nodes.library.output}}",
        tools: "{{nodes.tools.output}}",
      },
    },
    {
      id: "classgen",
      type: "anvil_classgen",
      name: "Extend the library",
      description: "Generate, test and register custom classes for missing capabilities",
      config: { plan: "{{nodes.architect.output.plan}}", taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}" },
    },
    {
      id: "compose",
      type: "anvil_compose",
      name: "Compose + Compile",
      description: "Write the spec JSON, then auto-fix → validate → repair",
      config: {
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        plan: "{{nodes.classgen.output.plan ?? nodes.architect.output.plan}}",
        request: "{{input.request}}",
        library: "{{nodes.library.output}}",
        tools: "{{nodes.tools.output}}",
      },
    },
    {
      id: "testgen",
      type: "anvil_testgen",
      name: "Synthesize tests",
      config: {
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        spec: "{{nodes.compose.output.spec}}",
        count: "{{input.testCount}}",
        library: "{{nodes.library.output}}",
        tools: "{{nodes.tools.output}}",
        given: "{{input.tests}}",
      },
    },
    {
      id: "evolve",
      type: "anvil_evolve",
      name: "Evaluate + Evolve",
      description: "Jev-graded tests, critic patches, keep the best",
      config: {
        spec: "{{nodes.compose.output.spec}}",
        tests: "{{nodes.testgen.output.tests}}",
        taskSpec: "{{nodes.reanalyze.output.taskSpec ?? nodes.analyze.output.taskSpec}}",
        evaluate: "{{input.evaluate}}",
        optimize: "{{input.optimize}}",
        library: "{{nodes.library.output}}",
      },
    },
    {
      id: "publish",
      type: "anvil_publish",
      name: "Publish",
      config: { spec: "{{nodes.evolve.output.spec ?? nodes.compose.output.spec}}", evaluation: "{{nodes.evolve.output.evaluation}}", mode: "new", note: "built by Anvil", save: "{{input.publish}}" },
    },
    {
      id: "output",
      type: "output",
      name: "Result",
      config: {
        value: {
          agentId: "{{nodes.publish.output.agentId}}",
          version: "{{nodes.publish.output.version}}",
          name: "{{nodes.publish.output.name}}",
          score: "{{nodes.publish.output.score}}",
          passRate: "{{nodes.publish.output.passRate}}",
          repairs: "{{nodes.compose.output.repairs}}",
          evolution: "{{nodes.evolve.output.history}}",
          published: "{{nodes.publish.output.published}}",
          spec: "{{nodes.publish.output.spec}}",
          evaluation: "{{nodes.publish.output.evaluation}}",
        },
      },
    },
  ],
  edges: [
    { from: "input", to: "tools" },
    { from: "tools", to: "triage" },
    { from: "triage", to: "cost_gate" },
    { from: "cost_gate", to: "analyze", port: "go" },
    { from: "cost_gate", to: "approve_cost", port: "ask" },
    { from: "approve_cost", to: "analyze", port: "approved" },
    { from: "approve_cost", to: "cancelled", port: "rejected" },
    { from: "cost_gate", to: "cancelled", port: "stop" },
    { from: "cancelled", to: "cancel_output" },
    { from: "analyze", to: "need_info" },
    { from: "need_info", to: "clarify", port: "ask" },
    { from: "clarify", to: "reanalyze" },
    { from: "need_info", to: "library", port: "proceed" },
    { from: "reanalyze", to: "library" },
    { from: "library", to: "sources" },
    { from: "sources", to: "architect" },
    { from: "architect", to: "classgen" },
    { from: "classgen", to: "compose" },
    { from: "compose", to: "testgen" },
    { from: "testgen", to: "evolve" },
    { from: "evolve", to: "publish" },
    // If evaluation crashes outright, still publish the compiled agent (error port → fallback).
    { from: "evolve", to: "publish", port: "error" },
    { from: "publish", to: "output" },
  ],
  policy: systemPolicy,
  tests: [],
  meta: { system: true },
};

export const REFINER_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-refiner",
  name: "Anvil Refiner",
  description: "Changes an existing agent from a plain-language instruction, recompiles it, re-tests it and publishes a new version.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      instruction: { type: "string", description: "The change to make" },
      evaluate: { type: "boolean", default: true },
      optimize: { type: "boolean", default: false },
    },
    required: ["agentId", "instruction"],
  },
  nodes: [
    { id: "input", type: "input", name: "Change request", config: {} },
    { id: "load", type: "anvil_load", name: "Load agent", config: { agentId: "{{input.agentId}}" } },
    {
      id: "edit",
      type: "anvil_edit",
      name: "Edit + Compile",
      description: "JSON-patch the spec from the instruction, then recompile",
      config: { spec: "{{nodes.load.output.spec}}", instruction: "{{input.instruction}}" },
    },
    {
      id: "evolve",
      type: "anvil_evolve",
      name: "Evaluate + Evolve",
      config: {
        spec: "{{nodes.edit.output.spec}}",
        tests: "{{nodes.edit.output.tests}}",
        taskSpec: "{{nodes.load.output.taskSpec}}",
        evaluate: "{{input.evaluate}}",
        optimize: "{{input.optimize}}",
      },
    },
    {
      id: "publish",
      type: "anvil_publish",
      name: "Publish version",
      config: { spec: "{{nodes.evolve.output.spec}}", evaluation: "{{nodes.evolve.output.evaluation}}", mode: "version", note: "{{input.instruction}}" },
    },
    {
      id: "output",
      type: "output",
      name: "Result",
      config: {
        value: {
          agentId: "{{nodes.publish.output.agentId}}",
          version: "{{nodes.publish.output.version}}",
          summary: "{{nodes.edit.output.summary}}",
          score: "{{nodes.publish.output.score}}",
          passRate: "{{nodes.publish.output.passRate}}",
        },
      },
    },
  ],
  edges: [
    { from: "input", to: "load" },
    { from: "load", to: "edit" },
    { from: "edit", to: "evolve" },
    { from: "evolve", to: "publish" },
    { from: "publish", to: "output" },
  ],
  policy: systemPolicy,
  tests: [],
  meta: { system: true },
};

export const EVALUATOR_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-evaluator",
  name: "Anvil Evaluator",
  description: "Runs an agent's test suite, grades it with the decision model, and attaches the report to that version.",
  version: 1,
  inputSchema: { type: "object", properties: { agentId: { type: "string" }, version: { type: "integer" } }, required: ["agentId"] },
  nodes: [
    { id: "input", type: "input", name: "Agent", config: {} },
    { id: "load", type: "anvil_load", name: "Load agent", config: { agentId: "{{input.agentId}}", version: "{{input.version}}" } },
    { id: "evolve", type: "anvil_evolve", name: "Evaluate", config: { spec: "{{nodes.load.output.spec}}", tests: "{{nodes.load.output.tests}}", optimize: false } },
    {
      id: "publish",
      type: "anvil_publish",
      name: "Attach report",
      config: { spec: "{{nodes.load.output.spec}}", evaluation: "{{nodes.evolve.output.evaluation}}", mode: "attach" },
    },
    { id: "output", type: "output", name: "Report", config: { value: "{{nodes.evolve.output.evaluation}}" } },
  ],
  edges: [
    { from: "input", to: "load" },
    { from: "load", to: "evolve" },
    { from: "evolve", to: "publish" },
    { from: "publish", to: "output" },
  ],
  policy: systemPolicy,
  tests: [],
  meta: { system: true },
};

export const EVOLVER_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-evolver",
  name: "Anvil Evolver",
  description: "Self-improvement loop for an existing agent: evaluate, diagnose failures from traces, patch, re-test, publish the best version.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      rounds: { type: "integer", minimum: 1, maximum: 6, default: 2 },
      draft: { type: "boolean", description: "Save the result as a draft version. The current version stays until a person publishes the draft." },
    },
    required: ["agentId"],
  },
  nodes: [
    { id: "input", type: "input", name: "Agent", config: {} },
    { id: "load", type: "anvil_load", name: "Load agent", config: { agentId: "{{input.agentId}}" } },
    {
      id: "evolve",
      type: "anvil_evolve",
      name: "Evaluate + Evolve",
      config: { spec: "{{nodes.load.output.spec}}", tests: "{{nodes.load.output.tests}}", taskSpec: "{{nodes.load.output.taskSpec}}", maxRounds: "{{input.rounds}}", target: 1 },
    },
    {
      id: "publish",
      type: "anvil_publish",
      name: "Publish version",
      config: { spec: "{{nodes.evolve.output.spec}}", evaluation: "{{nodes.evolve.output.evaluation}}", mode: "version", note: "evolved by Anvil", draft: "{{input.draft}}" },
    },
    {
      id: "output",
      type: "output",
      name: "Result",
      config: {
        value: {
          agentId: "{{nodes.publish.output.agentId}}",
          version: "{{nodes.publish.output.version}}",
          score: "{{nodes.publish.output.score}}",
          passRate: "{{nodes.publish.output.passRate}}",
          history: "{{nodes.evolve.output.history}}",
        },
      },
    },
  ],
  edges: [
    { from: "input", to: "load" },
    { from: "load", to: "evolve" },
    { from: "evolve", to: "publish" },
    { from: "publish", to: "output" },
  ],
  policy: systemPolicy,
  tests: [],
  meta: { system: true },
};

export const CLASSSMITH_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-classsmith",
  name: "Anvil Classsmith",
  description: "Extends the node library itself: turns a plain-language capability description into a tested, registered custom class.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: { request: { type: "string", description: "The capability to add, e.g. 'convert currencies with live rates'" } },
    required: ["request"],
  },
  nodes: [
    { id: "input", type: "input", name: "Capability", config: {} },
    {
      id: "classgen",
      type: "anvil_classgen",
      name: "Generate + test class",
      description: "Write the class, run its tests for real, repair until they pass",
      config: { request: "{{input.request}}" },
    },
    { id: "output", type: "output", name: "Result", config: { value: "{{nodes.classgen.output.classes | first}}" } },
  ],
  edges: [
    { from: "input", to: "classgen" },
    { from: "classgen", to: "output" },
  ],
  policy: systemPolicy,
  tests: [],
  meta: { system: true },
};

/**
 * Best-of-N (docs/SELECTION.md): one candidate for each builder model, one shared test suite with pass^k,
 * and the best candidate is published. The input is the input of the builder, and "candidates".
 */
export const BEST_OF_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "anvil-best-of",
  name: "Anvil Best of N",
  description: "Builds one candidate agent with each builder model, tests all candidates on one shared suite with pass^k, and publishes the best. A judge model decides between close candidates.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: {
      ...(BUILDER_SPEC.inputSchema as { properties: Record<string, unknown> }).properties,
      candidates: { description: 'The number of candidates, or "auto" for one candidate for each builder model' },
      models: { type: "array", items: { type: "string" }, description: "The builder models. Without them, ANVIL_BUILD_MODELS applies." },
    },
    required: ["request"],
  },
  nodes: [
    { id: "input", type: "input", name: "Request", config: {} },
    { id: "best_of", type: "anvil_best_of", name: "Best of N", config: { build: "{{input}}", candidates: "{{input.candidates}}", models: "{{input.models}}" } },
    {
      id: "output",
      type: "output",
      name: "Result",
      config: {
        value: {
          agentId: "{{nodes.best_of.output.agentId}}",
          version: "{{nodes.best_of.output.version}}",
          name: "{{nodes.best_of.output.name}}",
          score: "{{nodes.best_of.output.score}}",
          passRate: "{{nodes.best_of.output.passRate}}",
          quality: "{{nodes.best_of.output.quality}}",
          model: "{{nodes.best_of.output.model}}",
          selection: "{{nodes.best_of.output.selection}}",
        },
      },
    },
  ],
  edges: [
    { from: "input", to: "best_of" },
    { from: "best_of", to: "output" },
  ],
  // Several builds and their tests: more time and money than one build.
  policy: { ...systemPolicy, timeoutMs: 3_600_000, maxCostUsd: Math.max(systemPolicy.maxCostUsd, 30) },
  tests: [],
  meta: { system: true },
};

export const SYSTEM_AGENTS = [BUILDER_SPEC, REFINER_SPEC, EVALUATOR_SPEC, EVOLVER_SPEC, CLASSSMITH_SPEC, BEST_OF_SPEC];
