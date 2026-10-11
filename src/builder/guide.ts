import type { AgentSpec } from "../core/types.js";

/** The language reference given to the composer/editor models. */
export const IR_GUIDE = `ANVIL AGENT IR (anvil/v1): authoring rules

SHAPE
\`{ "specVersion": "anvil/v1", "id": "kebab-case-id", "name": "Title", "description": "one sentence",
  "inputSchema": { "type": "object", "properties": { "<field>": { "type": "...", "description": "..." } }, "required": [...] },
  "outputSchema": { optional JSON schema of the final output },
  "nodes": [ { "id": "snake_case", "type": "<node class>", "name": "Human title", "description": "one-line purpose", "config": { ... } } ],
  "edges": [ { "from": "<node id>", "to": "<node id>", "port": "<only for branching nodes>" } ] }\`

GRAPH RULES
1. Use exactly one node with type "input" (id "input", config {}). Use one "output" node (id "output") or more.
2. The edges set the order of execution. The graph must be a DAG. Each node must have a path from "input" and a path to an "output".
3. A node runs when all its incoming edges are resolved and one of them is active. Anvil skips the nodes on a branch that did not run. Thus branches can join again at one downstream node (often the output node or a merge node).
4. A branching node has named ports. EACH edge that leaves a branching node MUST set "port":
   - decision with "route": a choice question gives one port for each option key (and "uncertain" when minConfidence is set). A noul question gives \`"yes"\` and \`"no"\` (and "uncertain").
   - router: the "port" of each rule, and its "default" port.
   - human_approval: \`"approved"\` and \`"rejected"\`.
   Each port must have an outgoing edge.
5. Each node can also use the "error" port to handle its failure (for example, to go to a fallback step).

DATA RULES
6. Pass data with templates in config strings: \`{{input.<field>}}\` and \`{{nodes.<id>.output.<field>}}\`.
   - Refer only to UPSTREAM nodes (nodes with a path of edges to the current node).
   - Refer only to fields that exist. The output fields of each class are:
     - llm: text
     - llm_structured: the properties of its schema
     - decision: each question id (and \`answers.<id>.confidence\` or \`probabilities\`)
     - agent: answer (an object when outputSchema is set, else text), steps
     - refine: text, passed, scores
     - map: results, count
     - web_fetch: text, title, url
     - web_search: results
     - knowledge_search: context, results
     - http: body, status, ok
     - human_approval: approved, comment, payload
     - human_input: answers
     - memory: value
     - code and transform: the value that they return (declare "schema" to make the fields available)
     - subagent: the output of that agent
     - merge: the output of the branch that ran
     - custom x_ classes: the properties of their output schema (see NODE REFERENCE)
   - Declare each \`{{input.x}}\` in inputSchema.properties.
6b. In code nodes, read data as \`nodes.<id>.output.<field>\`. A node on a branch that did not run has the output null. Thus use \`nodes.x.output?.field ?? fallback\`.
6c. A template only reads a value. It does not compute: no ==, !=, <, +, &&, or "? :" inside {{ }}. Compute a value (a flag, a sum, a choice) in a "code" or "transform" node, and read its output with a template.
7. A config string that is only one template keeps the type of the value. For example, \`"items": "{{nodes.extract.output.items}}"\` gives the array itself.
8. Fallbacks across branches: \`{{nodes.a.output.text ?? nodes.b.output.text ?? "none"}}\`. Filters: \`| json\`, \`| length\`, \`| join:", "\`, \`| upper\`, \`| lower\`, \`| first\`, \`| last\`, \`| trim\`, \`| keys\`, \`| number\`, \`| string\`.
9. In a map node, the fields for each item (prompt, system, agentInput, code, nodeConfig) can use \`{{item}}\`, \`{{item.field}}\`, and \`{{index}}\`.
   - A map with mode "node" runs a library class for each item: \`{"mode":"node","nodeType":"x_some_class","nodeConfig":{"field":"{{item.x}}"}}\`.
   - Then \`results[i]\` is the output of that class.

TRIGGERS (an optional top-level "triggers" array: how the agent runs without a person)
- \`{"id":"every_morning","type":"schedule","cron":"0 8 * * 1-5","timezone":"Europe/Istanbul","input":{"topic":"AI"}}\`. You can use \`"every":"30m"\` instead of cron.
- \`{"id":"on_order","type":"webhook","input":{"order":"{{payload}}"},"respond":false}\`. Templates: \`{{payload.*}}\`, \`{{headers.*}}\`, \`{{query.*}}\`.
- \`{"id":"new_posts","type":"poll","source":{"kind":"rss","url":"https://…/feed"},"every":"15m","input":{"url":"{{item.link}}","title":"{{item.title}}"}}\`.
  Source kinds: rss (items: id, title, link, published, summary), json (url, itemsPath, idPath), page (item: url, title, text when the page changes).
- \`{"id":"after_research","type":"agent","agentId":"other-agent","on":"completed","input":{"brief":"{{output.brief}}"}}\`.
- "input" maps the event into the agent input. It must give each required input field. A schedule has no event, so use fixed values. Each trigger can also use \`{{trigger.firedAt}}\`.

CONVERSATION AGENTS (the task spec has "interaction": "conversation")
- The agent talks with a user over many turns. Each turn is one run with ALL turns so far: \`{"messages":[{"role":"user"|"assistant","content":"…"}],"session_id":"…"}\`.
- Answer with an "agent" node: \`{"type":"agent","config":{"task":"<the role and the rules of the agent>","conversation":"{{input.messages}}","tools":[…],"classes":[…]}}\`. The answer of the node is the next reply.
- The output node gives \`{"reply":"<the next message to the user>","done":<true when the conversation is finished>}\`. Get "done" with a "decision" node or a structured answer, not with a fixed value.
- Ask for one missing fact at a time. Do not do an action that changes data before the user confirms it in the conversation.
- Act on the LAST user message. A message that only thanks or says goodbye, with no request, needs no tool call and no new action: reply in one short sentence, and set "done" to true. A request to stop, cancel, opt out, or "do not call me again" is NOT a closing: it asks for an action, so the agent step handles it with its tools.
- Call a tool only when the turn has the facts that it needs. When a fact is missing (an order id), ask for it: do not call the tool with an empty value.
- Ask the user only for a fact that a tool parameter or a rule needs. Do not ask for other data (an account number, a card number, a password) before an action: when the tool has what it needs and the user confirmed, do the action.
- Do each action at most one time in a turn. A closing record (for example a call outcome) is one call with one value.
- A tool result with "error" (for example {"error": "no order with this id"}) gives no data. Say that the tool did not find it. Do not read other fields as facts: an error is not "not delivered".
- When a rule excludes an item that the user asks about (a transaction older than 60 days, a booking that is cancelled), tell the user that the rule excludes it and why. Do not hide the item without a word.
- Each turn that needs data (an amount, a status, a date) calls the tool that gives it, before the reply. Do not put the tool calls only behind a branch such as "the user confirmed": the turn that asks for the confirmation must state the facts too.
- The same session_id comes back in each turn. Tools with state (for example a booking) keep their state for the session.
- A step that writes the reply gets the results of the tools of this turn. Its prompt says: "Do not say that you found, checked, changed, or refunded a thing that the TOOL RESULTS do not show. Do not promise an action that no step does." When a needed fact is missing, the reply asks for it.

ACTION GATE (a conversation agent, or an agent with rules)
- Put an "action_gate" step before each step that changes something (a given tool with side effects, send_slack, send_email, send_webhook, an http POST): \`{"type":"action_gate","config":{"action":"refund {{nodes.policy.output.amount_usd}} USD for the order {{nodes.extract.output.order_id}}","args":{"order_id":"{{nodes.extract.output.order_id}}","amount_usd":"{{nodes.policy.output.amount_usd}}"},"facts":"{{nodes.get_order.output}}"}}\`.
- Connect its "pass" port to the action step. Connect its "block" port to a reply step that reads \`{{nodes.<gate>.output.reason}}\`: it states the values and asks for the confirmation, or gives the rule.
- When the rules say to do an action at once or without a confirmation (for example "freeze a lost card at once after the verification"), set \`"requireConfirmation": false\` on its gate: the gate then checks only the rules. A request of the user in an earlier turn is enough for such an action. In an "agent" step, put such a class in \`"noConfirmation"\` (it must also be in "classes").
- The gate checks the confirmation of the user (in a conversation, the last user message must confirm the action with the values that the agent stated) and the important rules of the task. The compiler rejects an action step without a gate (UNGATED_ACTION).
- In an "agent" step, a given tool with side effects goes through the same gate when the agent calls it.

SEND THE RESULT (only when the request asks to send, post, email, or notify)
- \`{"type":"send_slack","config":{"text":"*Report*\\n{{nodes.summary.output.text}}"}}\`: the webhook URL is the secret SLACK_WEBHOOK_URL.
- \`{"type":"send_email","config":{"to":"{{input.email}}","subject":"…","text":"{{nodes.summary.output.text}}"}}\`: the SMTP settings are the secrets SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM.
- \`{"type":"send_webhook","config":{"urlSecret":"REPORT_WEBHOOK_URL","body":{"report":"{{nodes.summary.output}}"}}}\`.
- Never write a webhook URL, a server address, or a password in a config: name the secret. Put the send step after the step that makes the result, and give its output ("sent", "dryRun") in the output node. In tests, a send step does not send: it gives "dryRun": true.

QUALITY RULES
10. Use "decision" (a fast, calibrated classifier) to classify, to route, to gate, and for yes/no checks. Do not use an llm for these steps.
11. Use "code" or "transform" for exact calculations and to change the shape of data. Use "llm_structured" when later steps need specific fields. Use "refine" when the output has an explicit quality bar. Use "agent" only for open-ended tool use.
12. Write good prompts: a clear role in "system", the data from templates, and explicit output requirements (format, length, language, what to avoid). Tell the model to use only the given information when the facts must come from the input.
13. Write every prompt field in STE (Simplified Technical English): system, prompt, task, criteria, and the instructions of decision questions. The compiler checks these fields.
14. The "value" of the output node must be an object with clear field names. The fields must answer the full task.
15. Give each input field its valid range in inputSchema: "minimum" and "maximum" for numbers, "enum" for a fixed set of values. Then the engine rejects an invalid input before the run.
16. In code nodes, compare dates as numbers (\`Date.parse(a) - Date.parse(b)\`), not as strings. Two sources can write the same time in different formats.
17. Keep the graph as simple as the task permits. Do not add nodes that do no work.
17b. In code that sorts free text into a kind (an expense line, a ticket, a product), look for the words inside the text with includes() or a regular expression, in lower case. Do not compare the whole value with ===: people write "Hotel, 1 night" and "Flight SFO-JFK, business class", not "hotel" and "flight".
18. Use "code_agent" for a step with many tool calls, loops, or data processing (read many pages or API responses and combine them, parse, join, count, compute). Its program runs in a Python sandbox without internet. It reaches the web only through the tools that you list in "tools". An "agent" node can also get the "run_code" tool. Do not write a custom class for one task that a program can do. Give the program its data with templates in "task", for example "the rates: {{nodes.fetch.output.rates}}". A path without braces gives the program no data.
19. Files (docs/FILES.md). An input field for a file that a person attaches at run time has type "object" and "format": "anvil-file". The run gets the content in it: {{input.<field>.text}} is the text, {{input.<field>.sheets}} is the list of sheets of a table ({name, columns, rows, totalRows}), {{input.<field>.name}} is the file name. A reference file that the agent reads in each run is a "file" step with its fileId: {{nodes.<id>.output.text}} or {{nodes.<id>.output.sheets}}. For many rows, process the rows in a code or code_agent step, not in a prompt.`;

/** A complete, valid example used as a few-shot reference (validated in tests). */
export const EXAMPLE_SPEC: AgentSpec = {
  specVersion: "anvil/v1",
  id: "support-triage-example",
  name: "Support Triage & Reply",
  description: "Classifies a support message, drafts a policy-grounded reply for refund requests, answers how-to questions, and hands everything else to a human.",
  version: 1,
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The customer's message" },
      policy: {
        type: "string",
        description: "Refund policy text to ground replies in",
        default: "Refunds are available within 30 days of purchase for unused subscriptions. Refunds are issued to the original payment method within 5-7 business days.",
      },
    },
    required: ["message"],
  },
  outputSchema: {
    type: "object",
    properties: { intent: { type: "string" }, anger: { type: "number" }, reply: { type: "string" } },
  },
  nodes: [
    { id: "input", type: "input", name: "Input", config: {} },
    {
      id: "classify",
      type: "decision",
      name: "Classify intent",
      description: "Route by what the customer wants; also rate how upset they are",
      config: {
        state: { message: "{{input.message}}" },
        questions: {
          intent: {
            type: "choice",
            instructions: "What does the customer want?",
            criteria: { refund: "Asks for money back or to cancel a charge", how_to: "Asks how to do something with the product", other: "Anything else" },
          },
          anger: { type: "score", instructions: "How upset is the customer?", criteria: ["Calm", "Annoyed", "Furious"] },
        },
        route: "intent",
        minConfidence: 0.4,
      },
    },
    {
      id: "refund_reply",
      type: "refine",
      name: "Draft refund reply",
      description: "Policy-grounded reply that is checked against quality criteria",
      config: {
        system: "You are a precise, empathetic support agent. Only promise what the policy allows.",
        task: "Write a reply to this customer who is asking for a refund.\n\nPOLICY:\n{{input.policy}}\n\nCUSTOMER MESSAGE:\n{{input.message}}",
        criteria: ["The reply only promises what the policy allows", "The reply is under 120 words", "The reply states a concrete next step for the customer"],
        maxIterations: 3,
        model: "fast",
      },
    },
    {
      id: "howto_reply",
      type: "llm",
      name: "Answer how-to question",
      config: { system: "You are a friendly support agent.", prompt: "Answer the customer's question in at most 5 short numbered steps.\n\n{{input.message}}", model: "fast" },
    },
    {
      id: "handoff_reply",
      type: "llm",
      name: "Acknowledge & hand off",
      config: { prompt: "Politely acknowledge this message in 2 sentences and say a human teammate will follow up within 24 hours.\n\n{{input.message}}", model: "fast" },
    },
    {
      id: "output",
      type: "output",
      name: "Output",
      config: {
        value: {
          intent: "{{nodes.classify.output.intent}}",
          anger: "{{nodes.classify.output.anger}}",
          reply: "{{nodes.refund_reply.output.text ?? nodes.howto_reply.output.text ?? nodes.handoff_reply.output.text}}",
        },
      },
    },
  ],
  edges: [
    { from: "input", to: "classify" },
    { from: "classify", to: "refund_reply", port: "refund" },
    { from: "classify", to: "howto_reply", port: "how_to" },
    { from: "classify", to: "handoff_reply", port: "other" },
    { from: "classify", to: "handoff_reply", port: "uncertain" },
    { from: "refund_reply", to: "output" },
    { from: "howto_reply", to: "output" },
    { from: "handoff_reply", to: "output" },
  ],
  policy: { maxCostUsd: 0.25, maxNodeExecutions: 100, timeoutMs: 300_000, requireApprovalForSideEffects: false },
  tests: [
    {
      id: "t1",
      name: "Refund within window",
      input: { message: "Hi, I bought the annual plan 10 days ago and never used it. Can I get my money back?" },
      criteria: ["The reply says a refund is possible", "The reply mentions the original payment method or the 5-7 business day timeline"],
      checks: [{ path: "intent", op: "equals", value: "refund" }],
    },
    {
      id: "t2",
      name: "How-to question",
      input: { message: "How do I export my data to CSV?" },
      criteria: ["The reply gives step-by-step instructions"],
      checks: [{ path: "reply", op: "minLength", value: 20 }],
    },
  ],
  meta: { example: true },
};
