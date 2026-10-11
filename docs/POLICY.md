# Rules from a policy

A request or an attached file can give a policy: terms, limits, or things that the agent must not do. The builder makes each rule of the policy part of the agent, its tests, and its checks.

## What the builder does

| Step | What changes |
|---|---|
| Analysis | lists each rule in `rules` of the task spec: `id`, `rule` (one sentence in STE), `kind` (`must` or `must_not`), `important`, and `source` (the request or a file name). It does not invent rules. |
| Architect and compose | state the rules in the prompts of the steps that decide or act. An important rule gets a check before an action that changes data. When the input asks for a thing that a rule forbids, the agent refuses and gives the reason. |
| Acceptance | each important rule becomes a judge rule with the id `rule_<id>`. A model rule set gets the rule judges too. |
| Testgen | writes one extra test for each important rule. The test tries to break the rule, and its criteria expect a refusal with the reason. The name starts with `rule: <id>`. |
| Harness | an unmet `rule_` rule is the failure class `rule_violation` (no classifier call). The next attempt uses the `keep_rules` strategy with the deep model. A correct refusal is `rule_refusal`: the harness accepts it and does not try again. |
| Critic | sees the rules. A rule violation is its own failure. The critic fixes the prompt or adds a check, and never weakens a rule. |

## Config

| Variable | Default | Meaning |
|---|---|---|
| `ANVIL_RULES_MAX_ACCEPTANCE` | 6 | the most rule judges in the acceptance of one agent |
| `ANVIL_RULES_MAX_TESTS` | 3 | the most extra tests that try to break a rule |
