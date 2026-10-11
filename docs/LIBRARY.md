# The library: classes, examples, and lessons

The library makes each new build better with the agents and the builds before it.
The code is in `src/builder/library.ts`.

## 1. Classes

Each agent has a class with four axes. The class is in `spec.meta.taxonomy`.

| Axis | Values |
|---|---|
| `pattern` | The 7 architecture patterns of the triage: `pipeline`, `classify_route`, `map_reduce`, `generate_refine`, `research_agent`, `rag_qa`, `human_in_loop`. |
| `domain` | The subject area, for example `currency_exchange`. The list is open. |
| `sourceKind` | `api`, `web_page`, `document`, `input_only`, or `mixed`. |
| `outputKind` | `table`, `report`, `decision`, `message`, or `data`. |

- One Jev call finds the class. When the triage gives the pattern, Jev does not select it again.
- Jev selects the domain from the known domains: the configured list (`ANVIL_LIBRARY_DOMAINS`) and the domains that library agents use.
- When no known domain fits, the model names a new domain in snake_case. The next builds know it.
- A build finds the class in the library step. The publish step finds it for an agent that has none.
- To give a class to the agents from before the library, run `anvil classify` or `POST /api/library/classify`. The class goes into the current version. No new version is made.

## 2. Examples

The library step runs after the analysis and before the source plan.

1. It finds the candidates: library agents with the same pattern or the same domain.
2. The quality gate removes weak candidates. An example must:
   - have the quality `passed`
   - have a score of at least `ANVIL_TH_EXAMPLE_MIN_SCORE` (0.85)
   - compile with the current rules of the compiler
3. Jev compares each candidate with the new task (at most `ANVIL_LIBRARY_MAX_CANDIDATES`).
4. The candidates with a similarity of at least `ANVIL_TH_EXAMPLE_MATCH` (0.6) are examples. The best `ANVIL_LIBRARY_MAX_EXAMPLES` (2) are used.

The person can select examples (`include`) or remove them (`exclude`) when the build starts. A selected example skips the similarity check, but it must compile.

An example is not inheritance. The new agent does not extend the example. The builder sees the example and copies only the parts that fit:

| Step | What it gets |
|---|---|
| Source plan | The tested sources of the examples are candidates after the URLs of the request. |
| Architect, compose | The graph of each example, its library classes, and its tested sources. |

So an error or a change in an old agent never goes into a new agent by itself.

## 3. Lessons

Each domain keeps the lessons of its builds:

| Kind | Who writes it | Who reads it |
|---|---|---|
| `agent_fix` | Evolve, for a critic change that improved the score | Architect, compose, critic |
| `test_problem` | Evolve, for a test item that the diagnosis gives to the test | Testgen |
| `source_ok` | The source plan, for the selected source of a need | Source plan, architect, compose |
| `source_blocked` | The source plan, for a blocked or rate-limited source | Source plan, architect, compose |

- The same lesson again counts one more time.
- A source lesson replaces the opposite lesson for the same source. A source can start to work or stop.
- A domain keeps its newest and most frequent `ANVIL_LIBRARY_MAX_LESSONS` (60) lessons.
- A domain is wide, so a lesson of one agent can be noise for another task. Jev asks for each candidate lesson (the newest and most frequent, the same pattern first) if it applies to the new task. Only the lessons above `ANVIL_TH_LESSON_MATCH` (0.5) are used, at most `ANVIL_LIBRARY_LESSONS_IN_PROMPT` (8). The build page shows the lessons that were left out. Lessons older than `ANVIL_LIBRARY_LESSON_MAX_AGE_DAYS` (120) are not used.
- The Classes page shows the lessons. A person can delete a wrong lesson.

## 4. Isolation

- A new agent gets its own steps. The examples are not in the list of subagents of the build, and the example text has no agent id.
- So a change in an example never changes the agents that a build made from it.

## 5. Where a person sees it

| Page | What it shows |
|---|---|
| Classes | The agents of each domain, their class, which of them can be examples (or why not), and the lessons. Buttons classify the agents without a class, and delete a wrong lesson. |
| Agents | The class of each agent, and filters for domain and pattern. |
| Build form | The "Use library" switch, and a picker: select an example, or remove one. |
| Build page | The Library match step: the class, the examples with their similarity and score, the other candidates and why, and the lessons. |

## 6. Measure the effect

- `ANVIL_LIBRARY_EXAMPLES=off` turns off the examples and the lessons for all builds. The build input `useLibrary: false` turns them off for one build. The class is still found.
- In the benchmark suite, a case can wait for an earlier case (`"after"`). Then the agent of the first case is in the library when the second case starts. The suite has 10 such pairs, in the category `library` (for example `meeting-notes` → `standup-notes`, `fx-history` → `fx-weekly`, `contract-risk` → `nda-review`).
- `npm run bench -- --no-library` builds without the library. Compare a report with the library and a report without it:

```bash
npm run bench -- --only meeting-notes,standup-notes,fx-history,fx-weekly
npm run bench -- --only meeting-notes,standup-notes,fx-history,fx-weekly --no-library
```

- The report shows the examples and the lessons that each build used.
- A fair comparison starts both sides from the same library: build the earlier cases once, copy the data directory, and run the `library` cases with and without the library on the two copies.
