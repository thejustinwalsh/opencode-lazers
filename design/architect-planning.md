# Architect planning flow

Status: design approved by the owner in conversation on 2026-11-20. Built (Tasks 1 to 24 of `.agents/plans/architect-planning.md`); the live walkthrough (Task 25) is not yet recorded. Measurements: `bun scripts/planning-report.ts`.
Related: [project profile and init](project-profile.md), [runtime state machines](runtime-state-machines.md).
Research behind it: `.agents/research/elephant-goldfish-review.md`, `rediscovery-measurements.md`.

## Intent

Exhaust the plan before work starts. A wrong plan costs far more than its review: work built on a
misunderstanding gets redone (the panel UI refactor is the reference case). The Architect keeps
planning with the owner; cheap, fresh-context planning agents then challenge the plan and raise
questions the owner answers. Nothing here is a gate: the owner can say "just task it" at any step.

Not goals: a README per folder or any hand-maintained document; human approval gates per stage;
round caps; running the flow on simple asks.

## Flow

```
1. ask arrives
2. runtime: decision model scores the ask (pieces) -> size pick + planning-agent ranking
3. simple ask            -> task (one question first if unclear). No planning flow.
   complex and unclear   -> Architect recommends a brainstorm; the owner decides
   complex and clear     -> steps 4 to 11
4. Architect drafts the plan
5. Architect hardens its own draft and asks the owner its own questions, in one batch
6. owner answers
7. Architect stores the plan and shows the chat breakdown with a link to the full plan
8. owner steers, or says LGTM
9. the pre-selected planning agents review the stored plan in fresh context:
   typed findings plus questions
10. Architect sorts the questions (answers only what the conversation states, with a citation;
    merges duplicates; orders by weight); every other question goes to the owner; owner answers
11. one final planning agent pass; the Architect updates the plan once; the Architect makes tasks
    with the existing task tools
```

The Architect is the only author of the plan. Planning agents find; the Architect edits.
The Architect goes first because it is the strongest model and knows the conversation.

## Decision step (runtime code, not a tool, not an agent)

The runtime already observes every prompt that reaches the Architect. On an ask it:

1. Splits the ask into pieces: a paragraph; a long paragraph splits at about four sentences with a
   one-sentence overlap. A short ask is one piece.
2. Runs the decision model on each piece, forced choice, twice:
   - size: `one task` / `a few tasks` / `a large effort`;
   - planning agents: a score or ordered ranking over the fixed list of planning agents and
     question skills.
3. Combines across pieces into one ranked list; each entry keeps its score and the text behind it.
4. Applies a threshold.

Rules the owner set:

- **No "none" choice.** A cheap model takes the exit every time. The model always ranks the real
  choices.
- **"None" is derived.** If the scores do not clear the threshold, the quick decision is not
  trusted: the Architect is told so and decides for itself. The weak scores are context, not advice.
- **If the scores clear,** the runtime routes the selected planning agents deterministically after
  the plan is built.
- The threshold is measured, never guessed: a backtest on recorded asks sets it, and the
  measurement is written beside the constant. The backtest also reports how often asks fall below
  the bar, how often each choice is picked (a choice picked for nearly every piece is the same trap
  as "none"), whether a score-spread measure beats the top score, and decision time per piece.
- Size has ground truth: recorded asks and the number of tasks each became.
- The Architect never recommends a brainstorm for an ask in the simple row, whatever the scores.

Decision model: the built-in local D1, or an external model on OpenRouter, chosen in Settings.
With local inference off and no external model set, the Architect picks from the same list itself.

## Planning agents

Registered in the plugin beside Implementor and Auditor; hidden from the agent picker; read, grep
and glob only; no edit, shell, web, delegation or submit tools. Each gets the stored plan, the
repository map and read access. It never gets the Architect's conversation. Default model route: a
mid-price model (about half the cost of the Architect's), set in Settings. Prompts are written
fresh; no text is copied from the reviewed project, and its names are not used in the product.

| Agent         | Job                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comprehension | Restates each task first. A task it cannot restate is a finding.                                                                                            |
| Readiness     | Choices that change behaviour and are left open; an acceptance check that a broken result would still pass. Routine choices stay with the worker by design. |
| Grounding     | Plan claims the code contradicts; files a check needs that the write scope leaves out; hidden dependencies.                                                 |
| Critic        | Assumptions with no backing; risks with no answer.                                                                                                          |
| Zoom out      | Work that already exists (must search the code); detail too early; a fix for a symptom.                                                                     |

Also, with no model: an overlap check (two tasks writing the same files with no dependency; a path
not in the repository map). It always runs. One deterministic rule on the draft may add one agent
the ask did not reveal (for example the plan writes a migration, so add Critic).

Findings are typed: severity, confidence, the task and field concerned, what is wrong, a failure
scenario, evidence as `path:line`, a suggestion, and optionally a question for the owner. A
reviewer that fails is recorded as `not run`, never as clean.

The Architect answers each finding: revised; contested with evidence the reviewer could read; or
passed to the owner. The Architect is not conservative with questions: it answers one itself only
when the conversation states the answer.

## What the owner sees

Two forms of one plan. The stored full plan is for the Architect and the planning agents. The chat
breakdown is generated from it, never written separately: tasks first, one line each with
dependencies, then open decisions, then a link to the full plan, in the owner's attention-control
style. Reply LGTM to continue, a change to revise, or "just task it" to skip the agents.

## Structure

| Layer           | Change                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Decision step; `planning` machine in `lifecycleMachines` (drafted, in review, questions open, final review, ready, tasked; "just task it" exits from every state); two tables (plan draft, findings) |
| Plugin agents   | Five planning agents, read-only                                                                                                                                                                      |
| Architect file  | A short intro flow; brainstorm, hardening and show-the-plan runbooks under `src/guidance/` delivered when their step starts                                                                          |
| Architect tools | Store the plan draft; review the plan; resolve a finding. Tasks use the existing task tools.                                                                                                         |
| Settings        | Decision model; planning-agent route; per-project auto-dispatch of planning agents                                                                                                                   |

The self-review tool's limits on checks, evidence and rounds are deliberate: too many means the
item is a plan, not a task. They stay; the refusal message should say to split it.

## Build order

1. Decision model setting and the decision step, with the backtest script.
2. Plan draft tool, the chat breakdown and the plan link.
3. Overlap check, then Grounding and Comprehension.
4. Readiness, Critic, Zoom out; the final pass; the brainstorm runbook.

Each part works alone. Before building: confirm in OpenCode that one tool call can start an agent
session and wait for it, and what the plan link opens (an artifact or a LAZERS panel).

## How it is judged

Per plan, before and after: repairs, scope amendments, scope stops, takeovers, failed combined
verification (baseline over 219 plans: 23% repaired, 20% scope-amended). Per finding: whether the
thing it predicted happened. How many agent findings remain after the Architect hardens first.

## Review outcomes, 2026-11-20

The five planning agents were written first and run on this design and on the project profile
design, ten fresh-context runs on a mid-price model (about 95,000 tokens and under 80 seconds
each). Results are in `.agents/reviews/2026-11-20-planning/`. Decisions taken from them:

- **Terms.** "Simple" is a size pick of `one task`; "complex" is `a few tasks` or `a large effort`.
  "Unclear" is derived: no planning-agent score clears the threshold. Clarity is not a separate
  score.
- **Selection is built, permissive, and measured from day one** (owner). The decision model picks
  simple or complex, then ranks the planning agents. The threshold sits just above "unsure", so in
  practice all five run and only an agent that clearly cannot help is cut. Every decision is
  recorded (pieces, scores, which agents ran, what each found, cost) so the threshold can be moved
  on evidence. Below the threshold the Architect chooses the agents; whether the flow runs at all
  is decided by size.
- **The overlap check is dropped.** The runtime already runs tasks with overlapping scopes in
  sequence. The path-not-in-map check stays as a deterministic check.
- **No spend ceiling.** Cost per plan is shown; nothing is refused.
- **A stalled plan stays open** (lead's default, unanswered by the owner): it waits until the owner
  answers or says "just task it". A failed agent is retried once, then recorded as `not run` and
  shown. Nothing proceeds on a timer.
- **Findings carry the plan revision they reviewed.** A finding on an older revision is shown as
  stale after the Architect edits the part it concerns; it is never silently dropped.
- **The machine is named `planning`**, not `plan` (a `plan` machine already exists for runner
  plans). Its transitions are written out in the build, including: owner leaves (state persists),
  restart mid-review (child sessions persist; the wait is rebuilt from stored state, as takeover
  does), plan edited after `ready` (returns to `drafted`).
- **Each build step states its own acceptance check** before it starts.
- **The backtest has less ground truth than assumed**: 390 Architect sessions, 27 with a submitted
  task, and ask text is only partly recorded. The first threshold is therefore a starting value
  chosen by hand and labelled as such; production records are the real data.
- **Final pass:** one agent. Lead's default: Readiness, because its question is "can a builder act
  on this".

Host facts confirmed for the build (source read, not run): one tool call can create a child
session with a given agent and model, prompt it and wait, by polling; nothing times a tool call
out, and the tool must cancel its own children; a restart loses the in-memory wait. Planning
agents are registered (hidden, read-only, one shared model route `lazers-planning`). A plan link is
a markdown link routed by a link handler to a LAZERS panel, as task links are today; artifacts
have no Desktop view. A ranking over N choices in one call uses the `systemOne` RPC (up to 16
questions, 20 choices, probabilities per choice); `decide` returns one answer. The local model
needs a Desktop window; headless, the call fails at its timeout and the Architect decides. An
external decision model works only if the catalogue lists it as a decision model. Planning agents'
context budget is 256,000 tokens; prompts are capped at 1,500 tokens (measured: about 1,100).

## Final pass outcomes, 2026-11-20

One Readiness pass on the revised design. No blockers; it found that a design is not yet a plan a
builder can act on. Answers (lead's, from the owner's stated direction unless marked):

- **What is ranked:** the five planning agents only. Question skills are deferred; the Architect's
  own hardening runbook asks its questions. (Lead's call; the owner's earlier idea of question
  skills is not dropped, only not in the first version.)
- **Score rule:** per agent. An agent runs when its own combined score clears the threshold.
- **Combining pieces:** the maximum over pieces per agent; an agent is needed if any piece needs it.
- **Size:** the largest size any piece gets.
- **A hung agent:** after an inactivity span with no progress it is marked stuck, retried once,
  then recorded as `not run`. The plan itself stays open. The span is measured, like the
  verification inactivity timeout, and written beside its constant.
- **A blocker or question from the final pass** goes to the owner as in step 10, then tasks.
- **Auto-dispatch** of planning agents is on by default per project (the owner: build it, run them,
  track the metrics); the owner can turn it off.
- **Stored plan format:** structured fields, the same shapes the task tools take (objective,
  acceptance, verification, write scope, dependencies), plus open decisions; the chat breakdown and
  the panel view are both rendered from it.
- **The plan view** is in scope: a link handler and a panel view for a stored plan, following task
  links (`src/tasks/links.ts`).
- **Retention and projections** treat the `planning` machine and its two tables like other
  finished work: a tasked or abandoned draft is retirable.
- **Acceptance per step** lives in the implementation plan, `.agents/plans/architect-planning.md`.

## Owner decision, 2026-11-20: run all five, record the scores, tune later

Evidence from the decision spike on D1 (44 labelled asks; `.agents/research/decision-spike.md`):
read whole, size is right for 20 of 42 asks and simple-versus-complex for 29 of 42; sliced into
small pieces, 17 of 41 and 26 of 41. Per-agent ranking quality is 0.57 to 0.77 (0.5 is chance), and
yes-scores sit low even when an agent is needed. A threshold high enough to mean something would
filter agents that help. Running all five is known to be fine (about 95,000 tokens and under 80
seconds each).

Decision:

- **All five planning agents run on every stored plan.** No score cuts an agent in the first
  version. Auto-dispatch stays the per-project switch.
- **The decision step still runs and is recorded from day one:** pieces, per-piece scores, the
  combined score per agent, the size pick, timings. It selects nothing yet. The records are the
  data for a later threshold, set from evidence and written beside its measurement.
- **The decision model's output is context for the Architect, not routing.** Whether an ask needs a
  plan at all stays the Architect's call: the flow starts when the Architect stores a plan, so a
  simple ask never enters it.
- **Method: Recursive Decision Models** (recursivedecisionmodels.com): small typed questions on
  small pieces of state, answers choosing the next question. An earlier reading in this document
  of "RDM it" as "build and learn" was the lead's mistake.
- **D1 prompts stay small:** no request above 400 input tokens (about 60 ms at 95 tokens measured;
  1 s at 1,100; 18 s at 6,600). A long ask is always sliced; a slow prompt defeats a fast judgement.
- **Device limits:** the D1 device requests its computed largest buffer, 16,384 x 9,216 x 4 bytes
  = 604 MB, clamped to the adapter (`src/webgpu/device-limits.ts`).
- **When the decision model does not run** (local inference off, no window, a timeout, no model),
  the note does not stop at "not run". It carries the decision model's own questions, generated from
  the same definitions: the size choices and each planning agent's one-line "use when". It tells
  the Architect to answer them itself before planning and to state its picks in one line. The
  Architect's pick is recorded in the same decision record (`architect_json`, source `architect`),
  so a later threshold can be compared against D1 on the same shape.
- **What D1 is asked (second run).** The model makes small judgments about what the text says; code
  makes the decision. Thirteen yes/no observations with true/false criteria replace the per-agent
  and size questions, one request each; a rule table maps their maxima over the pieces to each
  agent (yes at 0.7, no at 0.3, between is "Architect decides"), with no `wording_only` guard.
- **Size is a recorded guess** (about 40% exact on the labelled set) and nothing routes on it;
  selection still cuts nothing, and the brainstorm runbook is the Architect's call, not triggered
  by D1.
- **The not-run note** carries the same observations as questions from the same definitions; the
  old per-agent and 5-way forms stay for the replay script only.
