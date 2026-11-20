# Architect planning flow

Status: design approved by the owner in conversation on 2026-11-20. Not built.
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
