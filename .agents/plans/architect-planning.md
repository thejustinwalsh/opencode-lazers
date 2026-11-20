# Architect Planning Flow: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an ask, the runtime scores it with a small decision model. A simple ask goes straight to a task. For a complex ask, the Architect drafts, hardens and stores a plan made of complete task drafts. The owner steers or says LGTM. The selected planning agents review the stored drafts in fresh context, the Architect sorts their findings and questions, one Readiness pass runs, and the stored drafts are submitted unchanged through the existing task submission path. Every decision and review is recorded, so the threshold, slicer, inactivity span and agent selection can be moved on evidence. Nothing is a gate: "just task it" works from every state.

**Architecture:** The new code lives in `src/planning/`, beside what already exists on `main`: `contract.ts`, `index.ts`, `register.ts`, `shared.md`, `agents/*.md` and `scripts/planning-agent-prompt.ts`.

- **Decision step.** It starts without awaiting from the Architect prompt hook (`src/index.ts:113-120`). It runs a small question tree over the ask through a `Decider` port. The local decider uses the `systemOne` batch RPC; the external one uses `generate.decisions`. Results go to SQLite. A `context` hook delivers the result as one note on that user message in the model request only, the same way context stubs do (`src/runner/roles.ts:306-345`), so storage and the transcript are untouched.
- **Stored plan.** A `planning` row with append-only revisions. Each revision holds task drafts in exactly `TaskProposalSchema` (`src/task.ts:36`) plus plan-level fields drawn from `PlanSubmissionInput` (`src/runner/schema.ts:173`).
- **Review tool.** It starts one child session per agent: hidden, read-only, `lazers-planning` route, chosen session ids. It waits on them by polling, as `src/runner/delegated-native-lifecycle.ts:56-77` does. Its state is persisted per run, so a scheduler participant finishes a review cut short by a restart, as takeover does (`src/runner/takeover.ts:385-410`).
- **Workflow states.** Two new `lifecycleMachines` entries, `planning` and `planningRun`.
- **Tasking.** Submits the stored drafts through the same functions `lz-submit-task` and `lz-submit-plan` use.
- **Plan link and view.** Follow task links (`src/tasks/links.ts`).

**Tech stack:** Strict TypeScript, Bun (`bun:sqlite`, `bun test`), zod, XState `lifecycleMachines`, SolidJS panels, OpenCode plugin API (pinned V2), ruNNtime D1 through the `systemOne` RPC.

**Spec:** `design/architect-planning.md`, including both outcome sections. Owner clarifications from 2026-11-20 are folded in: a recursive decision tree with three slicers, and task drafts that are submitted exactly as stored.

## Already on `main` (do not re-plan)

- `src/planning/contract.ts`: `PlanningResult`, `parsePlanningResult`, `FindingTarget {unit, field}`, `TARGET_FIELDS`, the `not-run` status.
- `src/planning/index.ts`: the five agents with `useWhen` lines, in run order comprehension, grounding, readiness, critic, zoom-out.
- `src/planning/register.ts`: agents registered hidden and read-only as `lazers-planning-<id>`, with route `PLANNING_ROUTE_ID = "lazers-planning"`.
- `scripts/planning-agent-prompt.ts`: builds the plan block and the map block.

Grounding G2 (closed agent and route enums) is already answered by the shared route.

## Global Constraints

- **Terms are fixed.** Simple = size `one task`. Complex = `a few tasks` or `a large effort`. Unclear = derived: no agent's combined score clears the threshold, or the tree hit its bound. Clarity is never a separate score.
- **No "none" choice is ever offered to the model.** The agent question is one forced 5-way `choice` over the five planning agents. "None" is derived and hands the agent choice to the Architect. Whether the flow runs is decided by size alone.
- **Combination rules.**
  - Per agent: the maximum over the nodes where that agent's value is final.
  - Size: the largest size any scored part gets.
  - An agent runs when its own combined score is at or above `AGENT_THRESHOLD`.
- **Labelled starting values.** Every constant that is not yet measured carries the comment `hand-picked starting value; not measured` plus the measurement that will replace it. The measurement is written beside the constant when it lands.
- **The brainstorm recommendation** applies only to complex-and-unclear asks. It never applies to a simple ask, whatever the scores. A brainstorm produces direction in prose and is not stored as a plan.
- **No arbitrary limit refuses work.**
  - There is no spend ceiling, round cap, revision cap or finding cap.
  - The depth, beam and time bounds of the decision step are cost bounds on an advisory step. Hitting one yields the derived "none", never a refusal.
- **Workflow states only in XState.** No SQL-only transitions. Every non-terminal state has an exit, classified in `src/runner/lifecycle-dead-ends.test.ts`.
- **A stalled plan stays open.** Nothing proceeds on a timer. A hung agent is marked stuck after the inactivity span, retried once, then recorded `not-run`. The plan itself never times out.
- **Agent output is data.** It is parsed with `parsePlanningResult` and never followed as instructions. The plan block given to agents is delimited as untrusted, as `scripts/planning-agent-prompt.ts:45-56` already does.
- **Tests and gates.**
  - Tests use temporary databases. Never touch the running OpenCode service or its database. Never run a suite while the product has a verification running (`bun scripts/reload-safe.ts`).
  - Run tests with `bun test --timeout 120000 <files>`.
  - Gates for every task: the task's tests, `bun run verify`, and `bun run build` for any task touching `src/` that ships in the bundle.
- **Commits.** Atomic Conventional Commits. Plain `git commit`, no identity overrides, no AI or `Co-Authored-By` trailers, signing as configured. Never rebase; reconcile with merges.

## Review Focus

1. **An ask of one line** ("fix the typo in README"). The root asks only the size question and stops on `one task`. No agent question is asked, no planning row is created, and the note says "no planning flow". A one-line complex ask whose agent scores are flat cannot be split. It ends `none` with reason `below-threshold`, and the Architect picks the agents.
2. **An ask of several pages with code blocks.**
   - The slicer splits by headings, list items and paragraphs, then sentences. A fenced code block is never split into sentences. A sentence is never cut.
   - Over the input limit, strategies (a) and (c) slice by necessity, using the same order of structure.
   - A single unit over the limit is recorded `skipped-oversize`, never truncated.
   - Beam width and depth bound the number of calls. The recorded tree shows every pruned node.
3. **No Desktop window, so no local model.** `InferenceBroker.attached()` is false. The decision makes zero model calls, is recorded `unavailable` with reason `no-window` within milliseconds rather than at the broker timeout, and the note tells the Architect to judge size and agents itself.
4. **A planning agent returns malformed or truncated JSON.**
   - The attempt ends `failed` with reason `malformed: …` or `truncated`, and the raw reply is kept.
   - One retry in a fresh child follows. A second failure makes the agent `not-run`, shown in the result, the breakdown and the view.
   - It is never counted as clean.
5. **The owner edits the plan while agents run.**
   - The Architect stores revision r+1 while the review of r continues. The `planning` state does not move.
   - Findings carry r. Those whose draft field changed in r+1 are shown stale, never dropped.
   - Storing a revision in `ready` returns the plan to `drafted`.
6. **A service restart mid-review.**
   - Child sessions persist, and their ids are recorded before creation.
   - The scheduler participant advances the open runs and settles the review.
   - Because no live caller holds the review, it sends one notice with a stable id (`lazers-planning-review:<reviewID>`).
   - A second process tick finds the review already notified.
7. **Two plans in flight in one session.**
   - Planning rows are keyed by id, every tool takes `planningID`, and each link is distinct.
   - The decision note lists the open plans so the Architect tells a new ask from steering.
   - Reviews of two plans run independently.
8. **A plan whose tasks touch another project.**
   - A draft path outside the checkout (`../x`, `/abs`) fails `TaskProposalSchema`'s `writePath` rule. It is reported at store time and blocks only that draft at tasking.
   - A path absent from this project's map is a `path-check` finding.
   - A plan link opened from another project's session resolves to nothing, as task links do.
   - Tasking submits only into the calling location's project, with no cross-project dependencies.

---

## File Structure

| File                                                                                                                                          | Responsibility                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/runner/lifecycle-machines.ts` (modify)                                                                                                   | Add `planning` and `planningRun` machines                                                                                   |
| `src/runner/lifecycle-dead-ends.test.ts` (modify)                                                                                             | Classify their events and terminals                                                                                         |
| `src/database-schema.ts` (modify)                                                                                                             | Register the `planning` schema module                                                                                       |
| `src/planning/store.ts` (new)                                                                                                                 | Tables, writes and reads for decisions, nodes, plannings, revisions, reviews, runs, findings, questions and tasked mappings |
| `src/planning/decision/constants.ts` (new)                                                                                                    | Threshold, bands, beam, depth, budget, delivery wait, slicer default; each labelled                                         |
| `src/planning/decision/slicers.ts` (new)                                                                                                      | `Slicer` interface; structure units; three strategies                                                                       |
| `src/planning/decision/tree.ts` (new)                                                                                                         | Follow-up question table (data) and its effects                                                                             |
| `src/planning/decision/procedure.ts` (new)                                                                                                    | `decide()`: root, recursion, beam, follow-ups, combination, threshold, bounds                                               |
| `src/planning/decision/deciders.ts` (new)                                                                                                     | `Decider` port: local (`systemOne`), external (`generate.decisions`), none                                                  |
| `src/planning/decision/step.ts` (new)                                                                                                         | Start on prompt, record, deliver the note through the `context` hook                                                        |
| `src/webgpu/broker.ts` (modify)                                                                                                               | `attached(): boolean`                                                                                                       |
| `src/webgpu/tools.ts` (modify)                                                                                                                | Correct the stale "8,192-token" text to the measured limit                                                                  |
| `src/projects/settings.ts`, `src/projects/contract.ts`, `src/projects/rpc.ts` (modify)                                                        | Structured (JSON) setting values; planning settings                                                                         |
| `src/planning/draft.ts` (new)                                                                                                                 | `PlanningBody`, `TaskDraft`, store-time validation, field hashes, staleness, tasking assembly                               |
| `src/planning/render.ts` (new)                                                                                                                | Chat breakdown, full plan markdown, decision note                                                                           |
| `src/planning/prompt.ts` (new)                                                                                                                | Review message (plan block plus map), extracted from the script                                                             |
| `scripts/planning-agent-prompt.ts` (modify)                                                                                                   | Reuse `src/planning/prompt.ts`                                                                                              |
| `src/planning/checks.ts` (new)                                                                                                                | Path-not-in-map check; rule table that adds an agent                                                                        |
| `src/planning/host.ts` (new)                                                                                                                  | Small adapter over `ctx.session`: create, prompt, observe, reply, interrupt                                                 |
| `src/planning/reviews.ts` (new)                                                                                                               | `PlanningReviews`: start, blocking run, advance, retry, stuck, cancel, tick, notify                                         |
| `src/planning/tools.ts` (new)                                                                                                                 | `lz-plan-draft`, `lz-plan-review`, `lz-plan-resolve`, `lz-plan-task`                                                        |
| `src/planning/server.ts` (new)                                                                                                                | Registers tools, the `context` hook, the scheduler participant and the `lz.planning` RPC                                    |
| `src/planning/links.ts`, `src/planning/panel.tsx`, `src/planning/rpc-contract.ts` (new)                                                       | Plan link, link handler, plan view                                                                                          |
| `src/gui.tsx` (modify)                                                                                                                        | Register the plan view and the Settings controls                                                                            |
| `src/projects/gui.tsx` (modify)                                                                                                               | Per-project "Planning agents run automatically" switch                                                                      |
| `src/submission.ts`, `src/tools.ts`, `src/runner/tools.ts` (modify)                                                                           | Extract the submit-task and submit-plan bodies into callable functions, so tasking uses the same path                       |
| `src/webgpu/task-review.ts` (modify)                                                                                                          | Refusal over its limits says to split                                                                                       |
| `src/guidance/planning-draft.md`, `planning-show.md`, `planning-resolve.md`, `planning-brainstorm.md` (new); `src/guidance/index.ts` (modify) | Runbooks and their retrieval                                                                                                |
| `src/architect.md` (modify)                                                                                                                   | A short intro to the flow; pointer list entries                                                                             |
| `src/retention/retention.ts` (modify)                                                                                                         | Kind `planning-detail`                                                                                                      |
| `src/index.ts` (modify)                                                                                                                       | Start the decision in the prompt hook; register the planning server                                                         |
| `src/core/core.ts` (modify)                                                                                                                   | Expose `inferenceBroker` (already at :218) and a per-project `PlanningService`                                              |
| `scripts/measure-decision-model.ts` (new)                                                                                                     | Live model limits and latency                                                                                               |
| `scripts/planning-report.ts` (new)                                                                                                            | Read-only report and replay of recorded decisions, reviews and outcomes                                                     |
| `docs/reference/contributor-contracts.md`, `design/architect-planning.md` (modify)                                                            | Contracts and status                                                                                                        |

---

## Stage A: workflow states and storage

### Task 1: The `planning` and `planningRun` machines

**Files:**

- Modify: `src/runner/lifecycle-machines.ts`. Add next to `takeoverMachine` (around :184) and to the registry (:209-228).
- Modify: `src/runner/lifecycle-dead-ends.test.ts`, `classification` (:18-131).
- Test: `src/runner/lifecycle-machines.test.ts`, plus the dead-ends test.

**Interfaces:**

- Produces two machines built with `defineLifecycle` (:117). Its events are named by their target state.
  - The `planning` machine, `defineLifecycle("lazers-planning", "drafted", …)`:
    - `drafted: ["in-review","tasked","abandoned"]`
    - `in-review: ["questions-open","tasked","abandoned"]`
    - `questions-open: ["in-review","final-review","tasked","abandoned"]`
    - `final-review: ["ready","tasked","abandoned"]`
    - `ready: ["drafted","tasked","abandoned"]`
    - `tasked: []`, `abandoned: []`
  - The `planningRun` machine, `defineLifecycle("lazers-planning-run", "starting", …)`:
    - `starting: ["running","failed","cancelled"]`
    - `running: ["reviewed","failed","stuck","cancelled"]`
    - `reviewed: []`, `failed: []`, `stuck: []`, `cancelled: []`
  - `export type PlanningState = …` and `PlanningRunState`.
- `defineLifecycle` adds a self edge to every state. A revision stored in any non-terminal state except `ready` is therefore a self transition. In `ready` it is the event `drafted`.

- [ ] **Step 1: Write the failing tests**
  - `lifecycleTransition("planning", s, "tasked") === "tasked"` for each of drafted, in-review, questions-open, final-review and ready ("just task it" from every state).
  - Likewise `"abandoned"` from each.
  - `lifecycleTransition("planning","ready","drafted") === "drafted"` (edit after ready).
  - `lifecycleTransition("planning","in-review","in-review") === "in-review"` (revision during review).
  - `lifecycleTransition("planning","drafted","final-review")` throws `Invalid planning transition drafted → final-review`.
  - `lifecycleTransition("planning","tasked","drafted")` throws.
  - `lifecycleTransition("planningRun","running","stuck") === "stuck"`, and `("planningRun","stuck","running")` throws (a retry is a new run row).
  - Dead-ends classification:
    - `planning: { observable: ["questions-open"], architect: ["drafted","in-review","final-review","ready","tasked","abandoned"], terminal: ["tasked","abandoned"] }`
    - `planningRun: { observable: ["running","reviewed","failed","stuck"], architect: ["cancelled"], terminal: ["reviewed","failed","stuck","cancelled"] }`
- [ ] **Step 2: Run** `bun test --timeout 120000 src/runner/lifecycle-machines.test.ts src/runner/lifecycle-dead-ends.test.ts`. Expect FAIL: unknown lifecycle `planning`, and "every machine is classified" fails.
- [ ] **Step 3: Implement** the two `defineLifecycle` calls and the registry entries. The test does not settle one point: `in-review` exits to `questions-open` only when every run is terminal. That is enforced by the caller in Task 16, not the machine.
- [ ] **Step 4: Run.** Expect PASS, including the four existing dead-ends tests.
- [ ] **Step 5: Commit** `feat(planning): planning and planning-run lifecycle machines`.

**Acceptance:** Every planning state exits to `tasked` and `abandoned`, an edit in `ready` returns to `drafted`, and the dead-ends suite classifies both machines with no unclassified event.

### Task 2: Planning tables and store

**Files:**

- Create: `src/planning/store.ts`.
- Modify: `src/database-schema.ts`. Add the module `planning: { generation: 1, source: "src/planning/store.ts", tables: [...] }` after `"repo-map"` (:93-97).
- Test: `src/planning/store.test.ts`.

**Interfaces.** The tables are additive, so no existing table changes. The bundle-generation overlap is safe: an old generation never reads them.

- `planning_decisions(id TEXT PK, project_key, session_id, message_id, created_at, ask_text, ask_chars, strategy, decider, decider_model, status CHECK IN ('decided','none','unavailable'), reason, size, scores_json, selected_json, threshold, constants_json, model_ms, elapsed_ms, calls, open_planning_ids_json, delivered_text, late_json, UNIQUE(session_id,message_id))`
- `planning_decision_nodes(decision_id, node_id, parent_id, depth, span_start, span_end, kind, calls_json, outcome, input_tokens, elapsed_ms, PRIMARY KEY(decision_id,node_id))`
  - `calls_json`: `[{questions:string[], probabilities:Record<q,Record<choice,number>>, elapsedMs, inputTokens}]`
- `planning_plannings(id TEXT PK, project_key, project_directory, session_id, decision_id, title, state, revision, created_at, updated_at, tasked_plan_id)`
- `planning_revisions(planning_id, revision, body TEXT, validation TEXT, field_hashes TEXT, author_session, created_at, PRIMARY KEY(planning_id,revision))`
- `planning_reviews(id TEXT PK, planning_id, revision, stage CHECK IN ('review','final'), selection_json, created_at, settled_at, returned_at, notified_at)`
- `planning_runs(id TEXT PK, review_id, agent, attempt, session_id, state, prompt_message_id, started_at, last_activity_at, max_gap_ms, ended_at, reason, raw_reply, input_tokens, output_tokens, cache_read_tokens, model_json, map_hash, map_tokens, duration_ms)`
- `planning_findings(id TEXT PK, planning_id, review_id, run_id, source, agent_finding_id, revision, draft_id, unit, field, severity, confidence, body TEXT, resolution CHECK IN ('open','revised','contested','to-owner','answered'), resolution_json, resolved_revision)`
- `planning_questions(id TEXT PK, planning_id, review_id, source, agent_question_id, revision, finding_id, weight, body TEXT, route CHECK IN ('open','conversation','owner','merged','owner-answered'), merged_into, answer, citation_json, answered_at)`
- `planning_tasked(planning_id, draft_id, revision, task_id, reference, plan_id, self_review_id, changed_fields_json, PRIMARY KEY(planning_id,draft_id))`
- Produces `class PlanningStore`, with methods:
  - `recordDecision(row): void`. Idempotent on `(session_id, message_id)`; the first row wins, because prompt hooks are retry-safe, not exactly-once.
  - `decision(sessionID, messageID)`
  - `createPlanning(...)`
  - `appendRevision(planningID, expectedRevision|undefined, body, validation, hashes): {revision} | {conflict: number}`
  - `move(planningID, to: PlanningState)`. Uses `lz_runner_transition('planning',state,?)`, as `takeover.ts:430` does.
  - `moveRun(runID, from, to, patch)`
  - findings, questions and tasked reads and writes.

- [ ] **Step 1: Write the failing tests** (temporary database):
  - Installing twice is a no-op.
  - Recording the same `(session, message)` decision twice keeps the first row.
  - `appendRevision(p, 1, …)` after revision 2 exists returns `{conflict: 2}` and writes nothing.
  - `move(p,"tasked")` from `drafted` succeeds. `move(p,"final-review")` from `drafted` throws `Invalid planning transition`, and the row is unchanged.
  - `moveRun` with a stale `from` changes 0 rows.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/store.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** with `repository.installSchema("planning", …)`, following `src/context/repo-map-store.ts:15-36`. Every state write goes through `lz_runner_transition` (`registerLifecycleTransitions`, `lifecycle-machines.ts:243`).
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): tables for decisions, plans, reviews and findings`.

**Acceptance:** A temporary database holds every planning record. An invalid transition is refused by the XState function inside SQL, and a concurrent revision write reports a conflict instead of overwriting.

---

## Stage B: the decision step

### Task 3: Measure the decision model (measurement M1)

Facts read from the code, which the script confirms live:

- **Two input bounds apply to the batch path.**
  - The model's own bound: `MAX_LENGTH = 16384` tokens per question, covering state plus question (`node_modules/runntime/dist/zoo/index.mjs:2839`, ruNNtime 0.2.0). It is enforced at :2785 by throwing `D1 prompt exceeds its 16384-token context`, never by truncating.
  - The transport envelope: 64,000 characters of the serialized request (`src/webgpu/system-one.ts:4`, checked at :43 and `broker.ts:139-141`).
  - `src/webgpu/runtime.ts:914` (`contextCapacityTokens: 16_384`) matches the engine. The 8,192 in the `lz-local-system-one` description (`src/webgpu/tools.ts:73`) is stale. The 6,000-character `DECISION_CONTEXT_MAX_LENGTH` (`src/webgpu/decisions.ts:17`) applies only to the single-question `decide` path, which this feature does not use.
- **Encoded text is not reused between questions in one batch.** `systemOne` loops over the questions and calls `encodeQuestion(tokenizer, state, q, …)` and `runQuestion` for each one (`index.mjs:2963-2968`). Only an image prefix is shared. A batch of Q questions over T tokens therefore costs about Q full passes over T. Strategy (a) is Q × L(T), not one encoding plus short answers.
- **The model in use** is `LiquidAI/d1-omni-600M` (`src/webgpu/manifest.ts:33`), while the request literal says `"d1-omni-2b"` (`system-one.ts:30`). Record this; do not rename.

**Files:**

- Create: `scripts/measure-decision-model.ts`, `scripts/measure-decision-model.test.ts`.
- Modify: `src/webgpu/tools.ts:73` (text only).

**Interfaces:**

- Produces `measureDecisionModel(transport: {systemOne(input): Promise<SystemOneResult>}, texts: string[], clock): Promise<MeasureReport>`, where `MeasureReport` is:
  - `{ model, perCall: {stateChars, inputTokens, questions, elapsedMs, warm:boolean, error?}[], charsPerToken:{p5,p50}, maxAcceptedTokens, firstRefusal:{inputTokens,message}|null, latencyFit:{msPerTokenPerQuestion, interceptMs} }`
- The CLI `bun scripts/measure-decision-model.ts [--json]` uses the service endpoint the way `src/webgpu/server.ts:40-47` does: `Service.discover()` and `OpenCode.make(...).rpc(LocalInference)`. It needs a Desktop window. Its texts come from the repository's own `design/*.md`, cut at sentence ends to 256, 1k, 2k, 4k, 8k, 12k, 15.5k and 17k approximate tokens. It runs 1, 2 and 6 questions per length, three times each, with the first call per length marked cold.

- [ ] **Step 1: Write the failing test** with a stub transport:
  - Latency 10 + 0.01 × tokens × questions ms; refusal above 16,384 tokens with the engine's message.
  - Assert `maxAcceptedTokens` is the largest accepted size.
  - Assert `firstRefusal.message` contains `16384-token context`.
  - Assert `latencyFit.msPerTokenPerQuestion` is within 1% of 0.01.
  - Assert a 2-question call's measured time is about twice a 1-question call (the no-reuse signature).
  - Assert an empty `texts` throws `no texts to measure`.
- [ ] **Step 2: Run** `bun test --timeout 120000 scripts/measure-decision-model.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Fit by least squares over warm calls. Change `tools.ts:73` "fit the 8,192-token context" to "fit the 16,384-token context of the decision model (state plus question, per question)".
- [ ] **Step 4: Run.** Expect PASS. Then run the CLI once with a Desktop window open. Paste its summary (model, maxAcceptedTokens, charsPerToken p5, latency fit, cold and warm medians) as the comment block heading `src/planning/decision/constants.ts` in Task 6.
- [ ] **Step 5: Commit** `feat(planning): measure the decision model's input limit and latency`.

**Acceptance:** The script reports the accepted token limit, characters per token, and latency as a function of length and question count. Its stubbed test proves the fit and the per-question cost, and the live numbers are written beside the constants.

### Task 4: Structured setting values and the planning settings

This is the shared seam with the project profile feature: its design needs structured values in the same store. Whichever plan reaches this first owns the widening. The other reuses it and skips this task's contract part.

**Files:**

- Modify: `src/projects/settings.ts` (:11-37 types and schemas, :136-165 `write`), `src/projects/contract.ts` (:10-19 views, :108-115 `setSetting`), `src/projects/rpc.ts` (:128, :181).
- Test: `src/projects/settings.test.ts`, `src/projects/rpc.test.ts`.

**Interfaces:**

- `GlobalSettings` gains:
  - `decisionModel: {kind:"local"} | {kind:"external"; providerID:string; modelID:string} | {kind:"architect"}`, default `{kind:"local"}`.
  - `decisionSlicer: "whole" | "pre-slice" | "uncertainty"`, default `"uncertainty"`.
- `ProjectSettings` gains `planningAutoDispatch: boolean`, default `true`.
- `setSetting.input.value` becomes `z.json()`. Each name keeps its own zod schema in `globalSchema` and `projectSchema`, so a number setting still refuses `"x"` with `SETTING_INVALID`. Values stay JSON text in `lazers_settings.value`, so no migration is needed.

- [ ] **Step 1: Write the failing tests:**
  - `setGlobalSetting(repo,"decisionModel",{kind:"external",providerID:"openrouter",modelID:"x"})` round-trips through `globalSettings`.
  - `{kind:"external"}` without a model throws `Invalid decisionModel`.
  - `setProjectSetting(repo,key,"planningAutoDispatch",false)` reads back `false`. An unset value reads `true`.
  - RPC `setSetting` with `value: "3"` for `limit` returns `{ok:false, refusal:"SETTING_INVALID"}`.
  - The existing number tests stay green.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/projects/settings.test.ts src/projects/rpc.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** In `rpc.ts:128`, change the signature to `value: unknown`.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(projects): structured setting values; decision model, slicer and planning auto-dispatch`.

**Acceptance:** Structured and boolean settings round-trip and validate per name, and every existing numeric setting behaves exactly as before.

### Task 5: Slicers (three strategies behind one interface)

**Files:**

- Create: `src/planning/decision/slicers.ts`.
- Test: `src/planning/decision/slicers.test.ts`.

**Interfaces:**

```ts
export type Span = { start: number; end: number } // UTF-16 offsets into the ask
export type SliceKind =
  "whole" | "limit" | "heading" | "list-item" | "code" | "paragraph" | "sentences" | "sentence"
export type Slice = Span & { kind: SliceKind }
export type InputLimit = { maxChars: number } // from Task 3: floor(16384 × charsPerToken.p5 × 0.9), capped by 64,000 − request overhead
/** Structural units of a span, in order: headings, then list items / fenced code / paragraphs, then sentences. A fenced block is one unit. */
export function structuralChildren(text: string, span: Span): Slice[] // [] when the span is one sentence or one code block
/** Children for recursion: structuralChildren merged left-to-right into at most `max` groups of near-equal length. */
export function groupChildren(children: Slice[], max: number): Slice[]
/** By necessity: pack consecutive structural units into slices of at most limit.maxChars; a single unit over the limit is returned with kind "limit" and flagged oversize. */
export function packToLimit(
  text: string,
  span: Span,
  limit: InputLimit,
): { slices: Slice[]; oversize: Slice[] }
/** Strategy (b) baseline: paragraphs; a paragraph of more than four sentences becomes windows of four with a one-sentence overlap. */
export function fixedSlices(text: string): Slice[]
export type SlicerStrategy = "whole" | "pre-slice" | "uncertainty"
```

Sentence ends are `.`, `!` or `?` followed by whitespace, outside fenced code and inline code. An abbreviation list is not attempted. The behaviour is recorded, not tuned.

- [ ] **Step 1: Write the failing tests** with the fixture text below. Its fenced block uses `~~~` here only to keep this document readable; write it with three backticks in the test.
  ```
  ## Goal
  Add a plan view.

  ## Steps
  - store drafts
  - render breakdown

  ~~~ts
  const a = 1. b = 2
  ~~~
  Last paragraph one. Two. Three. Four. Five.
  ```
  - `structuralChildren(whole)` gives two `heading` slices, one starting at "## Goal" and one at "## Steps".
  - `structuralChildren` of the second heading slice gives `list-item` "- store drafts", `list-item` "- render breakdown", `code` covering the whole fence (it contains "1. b" and is not split), and `paragraph` "Last paragraph one. Two. Three. Four. Five.".
  - `structuralChildren` of that paragraph gives five `sentence` slices.
  - `structuralChildren("Fix the typo in README.")` is `[]`.
  - `fixedSlices` of the paragraph gives exactly "Last paragraph one. Two. Three. Four." and "Four. Five.".
  - `packToLimit` with `maxChars: 40` never ends a slice inside a sentence: every slice end is at a sentence end or a unit end. The code block (longer than 40) comes back in `oversize`.
  - Calling any function twice on the same input gives deep-equal output.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/decision/slicers.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** A line-based scanner. Headings match `^#{1,6} `. List items match `^\s*([-*+]|\d+\.) ` and continue until the next item or a blank line. Fences are tracked open and closed.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): structure-first slicers with a fixed-slice baseline`.

**Acceptance:** On the fixture, all three slicing entry points produce the exact expected spans, never split a code block or a sentence, and are deterministic.

### Task 6: The decision procedure

**Files:**

- Create: `src/planning/decision/constants.ts`, `src/planning/decision/tree.ts`, `src/planning/decision/procedure.ts`.
- Test: `src/planning/decision/procedure.test.ts`.

**Interfaces:**

```ts
// constants.ts: each line carries "hand-picked starting value; not measured" and the replacing measurement
export const AGENT_THRESHOLD = 0.22 // uniform over five agents is 0.20 ("unsure"); just above it. Moved by planning-report §Decisions.
export const UNCERTAIN_BAND = 0.08 // an agent is confident at p ≥ 0.30 or p ≤ 0.14
export const FLAT_SPREAD = 0.1 // max−min below this: the node is flat
export const SIZE_CONFIDENT = 0.6 // size confidence at the root below this: children are asked size too
export const BEAM_WIDTH = 2 // nodes expanded per level; start small: worst case 1 + 2×4 + 2×4 calls
export const MAX_CHILDREN = 4 // groupChildren bound per expansion
export const MAX_DEPTH = 2 // replaced by: largest D with worstCaseCalls(D) × L(p95 slice tokens) ≤ DECISION_BUDGET_MS (Task 3 fit)
export const DECISION_BUDGET_MS = 1_500 // model time per ask; a call starts only if elapsed + lastCallMs ≤ budget
export const DELIVERY_WAIT_MS = 3_000 // the context hook waits at most this from prompt admission
export const DEFAULT_SLICER: SlicerStrategy = "uncertainty"

// tree.ts: the follow-up table, data only
export type FollowUp = {
  id: string
  parent: { question: "size"; answer: SizePick }
  question: { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  effect: { kind: "floor-agent"; agent: PlanningAgentId; when: "yes" }
}
export const FOLLOW_UPS: readonly FollowUp[] = [
  {
    id: "stored-data",
    parent: { question: "size", answer: "a large effort" },
    question: {
      type: "noul",
      instructions:
        "Does this text change stored data: a database table, a migration, a file format or saved settings?",
      criteria: { true: "yes, stored data changes", false: "no stored data changes" },
    },
    effect: { kind: "floor-agent", agent: "critic", when: "yes" },
  },
  {
    id: "existing-code",
    parent: { question: "size", answer: "a few tasks" },
    question: {
      type: "noul",
      instructions: "Does this text name existing files, functions, commands or tables?",
      criteria: { true: "yes, it names existing code", false: "no" },
    },
    effect: { kind: "floor-agent", agent: "grounding", when: "yes" },
  },
]
// "yes" means noul ≥ 0.7, the existing adaptDecision bound (decisions.ts:61); floor-agent raises that agent's score at this node to AGENT_THRESHOLD.

// procedure.ts
export const SIZE_CHOICES = ["one task", "a few tasks", "a large effort"] as const
export type SizePick = (typeof SIZE_CHOICES)[number]
export type Answers = Record<
  string,
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
>
export interface Decider {
  readonly id: "local" | "external"
  readonly model: string
  available(): { ok: true } | { ok: false; reason: "no-window" | "feature-off" | "no-model" }
  ask(
    state: string,
    questions: Record<string, SystemOneQuestion>,
    signal: AbortSignal,
  ): Promise<{ answers: Answers; inputTokens: number }>
}
export type NodeOutcome =
  | "confident"
  | "expanded"
  | "pruned"
  | "depth-stop"
  | "budget-stop"
  | "single-sentence"
  | "pre-sliced"
  | "skipped-oversize"
  | "simple"
export type DecisionNode = {
  id: string
  parent: string | null
  depth: number
  span: Slice
  calls: {
    questions: string[]
    probabilities: Record<string, Record<string, number>>
    elapsedMs: number
    inputTokens: number
  }[]
  outcome: NodeOutcome
}
export type AgentScore = { score: number; nodeID: string; final: boolean }
export type DecisionOutcome =
  | {
      status: "decided"
      size: SizePick
      scores: Record<PlanningAgentId, AgentScore>
      selected: PlanningAgentId[]
      nodes: DecisionNode[]
      modelMs: number
    }
  | {
      status: "none"
      size: SizePick
      reason: "below-threshold" | "depth-bound" | "budget"
      scores: Record<PlanningAgentId, AgentScore>
      selected: []
      nodes: DecisionNode[]
      modelMs: number
    }
  | {
      status: "unavailable"
      reason: "no-window" | "feature-off" | "no-model" | "error" | "over-limit"
      error?: string
      nodes: DecisionNode[]
      modelMs: number
    }
export function decide(
  ask: string,
  deps: {
    decider: Decider
    strategy: SlicerStrategy
    limit: InputLimit
    clock: () => number
    constants?: Partial<DecisionConstants>
    followUps?: readonly FollowUp[]
    signal: AbortSignal
  },
): Promise<DecisionOutcome>
```

**Procedure.** Node ids are path-derived (`"0"`, `"0.1"`, `"0.1.0"`), which makes the procedure deterministic. Questions are fixed: `size` is a `choice` over `SIZE_CHOICES`, and `agents` is a `choice` whose criteria are each agent's `useWhen` (`src/planning/index.ts:24-49`).

- **(c) uncertainty**, the default:
  - The root is the whole ask, or `packToLimit` slices when the ask exceeds `limit`; those slices are all scored at depth 0.
  - Call 1 asks `size` and `agents` together. If size is `one task`, `agents` is still answered in the same batch, because the call is already made, but the node outcome is `simple` and the procedure ends. The answer is recorded for measurement, and costs one extra pass.
  - When the root size is `a few tasks` or `a large effort` and a follow-up matches, call 2 on the same node asks that follow-up. It is conditional, so it is a second call. Because there is no encoding reuse, it costs the same as batching it would.
  - An agent at a node is final when `|p − T| ≥ UNCERTAIN_BAND`.
  - A node is expandable when any agent is not final there or the spread is below `FLAT_SPREAD`, and it is not one sentence (`structuralChildren` gives `[]`, outcome `single-sentence`).
  - Children are `groupChildren(structuralChildren(span), MAX_CHILDREN)`. Each child asks `agents`, and asks `size` only when root size confidence was below `SIZE_CONFIDENT`.
  - At each level, the expandable nodes are ranked by the count of non-final agents, then by span length descending, then by start ascending. The first `BEAM_WIDTH` are expanded and the rest are `pruned`.
  - Nodes at `MAX_DEPTH` that are still expandable are `depth-stop`. Calls not started because of the budget leave the node `budget-stop`, unscored.
- **Agent combination.** For each agent: the maximum over nodes where it is final, plus all scored leaf nodes (`pruned`, `depth-stop`, `single-sentence`). Size is the largest over scored nodes.
- **Status.**
  - `simple`: `decided` with `selected: []`.
  - At least one agent at or above T, with no depth or budget stop on any node that left an agent non-final: `decided`.
  - Otherwise `none` with reason `budget` or `depth-bound` (whichever stopped first), or `below-threshold`.
- **(a) whole.** Only the root is asked (`size`, `agents`, matching follow-ups). It slices only by necessity over the limit, then treats the packed slices as depth-0 nodes. It never recurses.
- **(b) pre-slice.** No root call. `fixedSlices` gives depth-0 nodes, outcome `pre-sliced`, each asked `size` and `agents`.

- [ ] **Step 1: Write the failing tests.** The stub decider returns scripted answers keyed by node text, and the stub clock advances 400 ms per call. Use canonical agent order comprehension, grounding, readiness, critic, zoom-out.
  1. **Simple.** Ask "Fix the typo in README." with size {.8,.15,.05}. Exactly one node `{id:"0", kind:"whole", outcome:"simple", calls:[{questions:["size","agents"]}]}`; status `decided`, size `one task`, `selected: []`.
  2. **Early confident stop.** A two-paragraph ask with size {.1,.7,.2} and agents {.05,.45,.38,.06,.06}. One node, outcome `confident`; `selected` = `["grounding","readiness"]`; `scores.comprehension.score` = .05; total calls 1, plus 0 follow-ups because the "existing-code" stub answers noul .2.
  3. **Split.** The Task 5 fixture (two headings). Root agents flat {.2 ×5}, size {.05,.8,.15}. Child "0.0" {.05,.50,.31,.07,.07}; child "0.1" {.06,.06,.06,.70,.12}. The tree has exactly three nodes: "0" `expanded`, "0.0" `confident`, "0.1" `confident`. Children ask only `["agents"]`. `selected` = `["grounding","readiness","critic"]`, and comprehension's final score is .06, from node "0.1" (the root is excluded because it was expanded, not final).
  4. **Prune.** A three-paragraph ask with the root flat and three children whose non-final counts are 3, 1 and 2. `BEAM_WIDTH` 2 expands "0.0" and "0.2", and "0.1" is `pruned`. The pruned node's scores count as leaf scores.
  5. **Depth stop.** `MAX_DEPTH` 1, every node flat. Depth-1 nodes are `depth-stop`; status `none`, reason `depth-bound`. The scores are still reported.
  6. **Budget.** Budget 1,000 ms, 400 ms per call: exactly 2 calls are made. The third child is `budget-stop` with no `calls`; status `none`, reason `budget`.
  7. **Below threshold.** A one-sentence ask, flat. One node `single-sentence`; status `none`, reason `below-threshold`.
  8. **Follow-up.** Root size "a large effort" {.05,.15,.8}, agents {.3,.3,.3,.05,.05}, `stored-data` answered noul .85. The node has two calls, `["size","agents"]` then `["stored-data"]`, and critic's score is floored to .22, so `selected` includes `critic`.
  9. **No window.** `available()` returns `{ok:false, reason:"no-window"}`: status `unavailable`, `nodes: []`, the stub saw 0 calls, `modelMs` 0.
  10. **Determinism.** Fixture 3 run twice gives identical `JSON.stringify` output.
  11. **Strategies.** On fixture 3: (a) produces one node and no recursion; (b) produces depth-0 `pre-sliced` nodes equal to `fixedSlices` and no root call. With `limit.maxChars` 40, (a) produces `limit` slices at depth 0, and the oversize code block is `skipped-oversize`.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/decision/procedure.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Decisions the tests do not settle:
  - `ask` errors other than abort make the decision `unavailable` with reason `error` and the message kept.
  - An engine refusal `D1 prompt exceeds` on a node marks it `skipped-oversize` and falls back to `packToLimit` for that node.
  - Abort through `signal` returns what was scored, with status `unavailable` and reason `error` ("aborted").
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): hierarchical decision procedure with beam, follow-ups and a derived none`.

**Acceptance:** With stubbed scores, the procedure produces the exact expected tree for a simple stop, an early confident stop, a split, a prune, a depth stop, a budget stop, a follow-up and the no-window case. It is deterministic and never offers or returns a "none" choice from the model.

### Task 7: Deciders

**Files:**

- Create: `src/planning/decision/deciders.ts`.
- Modify: `src/webgpu/broker.ts`. Add `attached(): boolean { this.expire(); return this.owner !== undefined }` next to `demand()` (:117).
- Test: `src/planning/decision/deciders.test.ts`, `src/webgpu/broker.test.ts`.

**Interfaces:**

- `localDecider(broker: Pick<InferenceBroker,"attached">, featureOn: () => boolean, systemOne: (input: SystemOneInput, signal) => Promise<SystemOneResult>): Decider`
  - It sends `{model:"d1-omni-2b", state, questions, timeoutMs: 10_000}` through `ctx.rpc(LocalInference).systemOne` (location side `src/webgpu/server.ts:184` → `broker.generate`).
  - `available()` returns `no-window` when `!attached()` and `feature-off` when the "decisions" feature is off (`featureEnabled`, `src/webgpu/features.ts`).
- `externalDecider(generate: Plugin.Context["experimental"]["generate"]["decisions"], model: {providerID, modelID}): Decider`
  - It maps a `SystemOneQuestion` `choice` or `noul` to `Generate.DecisionQuestion`. Read the exact shapes at `node_modules/@opencode/schema/dist/generate.d.ts:120-200`. The state goes as one `DecisionTextPart`.
  - `UnsupportedModelError` or `ModelNotFoundError` makes `available()` false (`no-model`) for the rest of the process. Only catalogue-listed decision models work.
- `deciderFor(settings: GlobalSettings, …): Decider | undefined`. `{kind:"architect"}`, or local with the feature off and no external model, returns `undefined`, and the step records `unavailable` with reason `no-model`.

- [ ] **Step 1: Write the failing tests:**
  - A broker with no attach reports `attached() === false`. After `attach("o")` it is `true`. After the heartbeat expires (fake `now`) it is `false`.
  - `localDecider` with a detached broker gives `available()` `{ok:false, reason:"no-window"}`, and `systemOne` is never called.
  - The external mapping of a 5-way `choice` yields 5 options with the same keys and returns probabilities summing to 1 from a stub.
  - An `UnsupportedModelError` from the stub makes the next `available()` `{ok:false, reason:"no-model"}`.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/decision/deciders.test.ts src/webgpu/broker.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): local and external deciders; the broker reports an attached window`.

**Acceptance:** With no Desktop window the local decider declines at once instead of waiting for the broker deadline, and an external model that the host refuses as a decision model declines.

### Task 8: Wire the decision step (prompt hook, recording, delivery note)

**Files:**

- Create: `src/planning/decision/step.ts`, `src/planning/server.ts` (decision part).
- Modify: `src/index.ts:113-120` (prompt hook) and registration, `src/core/core.ts` (a per-project `PlanningService` holding the store, the deciders and `inferenceBroker`), `src/planning/render.ts` (decision note).
- Test: `src/planning/decision/step.test.ts`, `src/planning/render.test.ts` (note part).

**Interfaces:**

- `startDecision(svc, {sessionID, messageID, text, agent}): void`. Never awaited by the hook and never throws into it.
  - Skips when `agent !== "architect"`, when the text carries an `[lz-notice ` marker (`src/runner/notice-marker.ts`), or when a row exists.
  - Otherwise runs `decide` and records the decision plus its nodes. The ask text is recorded from now on; ask text is only partly recorded today (critic C1).
  - The hook passes `prompt.prompt.text` (`SessionPrompt.prompt`, `node_modules/@opencode/plugin/dist/effect/session.d.ts:13-18`). The agent comes from `ctx.session.get`, cached per session as `ensureArchitectMap` does (`src/context/architect-map.ts:31-32`).
- `decisionNote(row, openPlannings, delivery: Delivery): string`. One block starting `[lz-planning decision m=<messageID>]`. Exact forms:
  - simple: `size: one task — no planning flow; ask one question first if the ask is unclear.`
  - decided: `size: a few tasks · run: grounding 0.45, readiness 0.38 · cut: comprehension 0.05, critic 0.06, zoom-out 0.06 · threshold 0.22 (hand-picked)`, plus the `planning-draft` runbook (first time in the session) or its pointer.
  - none: `size: a large effort · no agent clears 0.22 (below-threshold): choose the agents yourself · weak scores: …`, plus `Recommend a brainstorm to the owner before drafting; the owner decides.` and the `planning-brainstorm` runbook or pointer.
  - unavailable: `decision unavailable (no-window): judge the size yourself; for a complex ask choose from comprehension, grounding, readiness, critic, zoom-out.`
  - With open plannings, append `· open plans: <title> (<state>), …` so the Architect can tell steering from a new ask.
- **Context hook.** In `server.ts`, `timedHooks(ctx.session,"session").hook("context", …)`, as in `roles.ts:322`. For an `architect` request: for every user message in `context.messages` with a decision row, append one text part with the row's `delivered_text`.
  - For a row without `delivered_text`, wait for the decision until `DELIVERY_WAIT_MS` after the row's prompt time, then render and store `delivered_text` once.
  - Afterwards the same text is rendered every time, so the cache prefix stays stable. A late decision is stored in `late_json` for measurement and never replaces the delivered text.
  - Match by `message.id === messageID` (`ContextMessage.id`, `src/runner/context-stubs.ts:31-35`). If no id matches, match the last user message whose text equals the recorded ask, and say so in a test comment. This is the one host fact to confirm in the walkthrough (Task 25).

- [ ] **Step 1: Write the failing tests:**
  - With a stub decider and stub `context` messages, `[{id:"m1",role:"user",content:[{type:"text",text:"Add a plan view …"}]}]`, after `startDecision` the hook adds exactly one text part beginning `[lz-planning decision m=m1]`. A second hook call yields deep-equal messages.
  - A decider that takes 5 s with `DELIVERY_WAIT_MS` 3,000 delivers the `unavailable` text with reason `timeout`, records it, and later records `late_json` without changing `delivered_text`.
  - A notice text with `[lz-notice kind=accepted …]` records no decision.
  - A non-architect session records none.
  - The same `(session, message)` started twice records one row.
  - `decisionNote` for each of the four statuses equals the exact strings above, with fixed scores.
  - The `planning-draft` runbook appears in the first decided note of a session, and the second note carries the pointer.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/decision/step.test.ts src/planning/render.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** In `src/index.ts`, add `startDecision(core.planning, {...})` before `ensureArchitectMap` inside the existing hook body. Do not await it.
- [ ] **Step 4: Run.** Expect PASS, and the existing `src/index` tests and `src/runner/context-stubs.test.ts` stay green.
- [ ] **Step 5: Commit** `feat(planning): decide on each Architect ask and deliver the result in the request`.

**Acceptance:** Every Architect ask gets one recorded decision with its tree and exactly one stable note in the model request. Admission never waits, and a missing window or slow model yields an honest "decide yourself" note.

### Task 9: Decision report and replay (measurement M2)

See "Measurement design" below for the definitions.

**Files:**

- Create: `scripts/planning-report.ts`, `scripts/planning-report.test.ts`.

**Interfaces:** `bun scripts/planning-report.ts [--db <tasks.sqlite>] [--project <dir>] [--since <iso>] [--json] [--replay --strategy whole|pre-slice|uncertainty]`.

- Opens the database read-only (`mode=ro`), as `scripts/replay-concerns.ts` does.
- `--replay` re-runs `decide` on recorded ask texts through the live service (as Task 3 does) and prints agreement with the recorded outcome per strategy. It writes nothing.

- [ ] **Step 1: Write the failing test** with a fixture database of 12 decisions: 3 simple, 6 decided, 2 none, 1 unavailable.
  - The JSON report has `decisions.total = 12` and `byStatus = {decided:9, none:2, unavailable:1}` (simple counts under decided).
  - `belowThresholdRate = 2/11` (unavailable excluded).
  - `pickRate.grounding` matches the fixture, with `flags` listing any agent picked for 90% or more of complex decisions as `"picked-for-nearly-every-ask"`.
  - Node latency p50 and p95 by input-chars bucket.
  - `strategies` lists each strategy's count.
  - A database with no decisions exits with code 2 and prints `no recorded decisions (0 rows; asks with text: 0)`.
- [ ] **Step 2: Run** `bun test --timeout 120000 scripts/planning-report.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the Decisions section now. Task 24 adds the Reviews, Questions and Outcomes sections.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): report and replay recorded planning decisions`.

**Acceptance:** On a fixture database the report prints the exact counts, rates and latency buckets. It refuses an empty sample with the counts it found, and replay compares strategies on the same recorded asks.

---

## Stage C: the stored plan, breakdown, link and view

### Task 10: Plan draft schema, validation and staleness

**Files:**

- Create: `src/planning/draft.ts`.
- Test: `src/planning/draft.test.ts`.

**Interfaces:**

```ts
export const DraftID = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
export const TaskDraft = z.strictObject({
  draftID: DraftID,
  dependsOn: z.array(DraftID).max(100).default([]),
  persona: WorkerPersona.optional(),
  /** Exactly what lz-submit-task takes, minus idempotencyKey; validated with TaskProposalSchema, stored even when invalid. */
  proposal: z.unknown(),
})
const line = z.string().trim().min(1).max(2000)
export const PlanningBody = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    ask: z.string().trim().min(1).max(8000), // the ask as understood
    assumptions: z.array(line).max(50).default([]),
    openDecisions: z
      .array(
        z.strictObject({
          id: z.string().regex(/^D\d+$/),
          question: line,
          options: z.array(line).min(2).max(4).optional(),
          answer: line.optional(),
        }),
      )
      .max(50)
      .default([]),
    plan: z.strictObject({
      // plan-level fields lz-submit-plan takes
      objective: PlanSubmissionInput.shape.objective,
      priority: PlanSubmissionInput.shape.priority,
      afterPlans: PlanSubmissionInput.shape.afterPlans,
      workspaceMode: PlanSubmissionInput.shape.workspaceMode,
      workerAgent: PlanSubmissionInput.shape.workerAgent,
      workerModel: PlanSubmissionInput.shape.workerModel,
      verification: z.unknown(),
      acceptance: z.unknown(), // validated, stored even when invalid
    }),
    tasks: z.array(TaskDraft).min(1).max(100),
  })
  .superRefine(/* duplicate draftID → issue (identity: refuses the store) */)
export type Validation = {
  drafts: Record<string, { path: string; message: string }[]>
  plan: { path: string; message: string }[]
  graph: { kind: "unknown-dependency" | "cycle"; draftID: string; detail: string }[]
}
export function validateBody(body: PlanningBody): Validation // TaskProposalSchema.safeParse per draft; TaskProposalSchema.shape.verification/acceptance for plan level; graph checks
export const DEFERRED_TO_TASKING = [
  "idempotencyKey",
  "classification",
  "verification timing vs project defaults",
  "Fallow config",
  "base commit",
  "PlanSubmissionInput on the assembled plan",
  "model-route preflight",
] as const
export function fieldHashes(
  body: PlanningBody,
): Record<
  string /* draftID | "@plan" */,
  Record<string /* proposal key | "dependsOn" | "persona" | "*" */, string>
>
export const FIELD_KEYS: Record<TargetField, readonly string[]> // objective→["objective"], acceptance→["acceptance"], verification→["verification"], write-scope→["writeScope","createScope","protectedScope"], dependencies→["dependsOn"], exclusions→["exclusions"], assumption→["assumptions"], design-decision→["*"], other→["*"]
export function isStale(
  finding: { draftID: string | null; field: TargetField; revision: number },
  hashesAt: (revision: number) => ReturnType<typeof fieldHashes>,
  current: number,
): boolean
export function changedFields(from: PlanningBody, to: PlanningBody): Record<string, string[]> // per draftID: changed keys; "added"/"removed"
```

Classification is optional in `TaskProposalSchema` (`src/task.ts:44`), but fresh-key admission requires it, so it is a deferred check reported at tasking.

- [ ] **Step 1: Write the failing tests:**
  - A body whose draft `plan-link` lacks `acceptance` stores, and `validateBody(...).drafts["plan-link"]` has `{path:"acceptance", message: …}`.
  - A draft with `writeScope: ["../other/x.ts"]` reports a `writeScope.0` issue (another-project case).
  - `dependsOn: ["nope"]` gives `graph[0].kind === "unknown-dependency"`.
  - `a→b→a` gives `cycle`.
  - Duplicate draftIDs fail `PlanningBody.safeParse`.
  - Changing only `plan-link.writeScope` from r1 to r2: `isStale({draftID:"plan-link", field:"write-scope", revision:1}, …, 2) === true`, the same finding with field `objective` is `false`, and `changedFields(r1,r2)` is `{"plan-link":["writeScope"]}`.
  - Reordering `tasks` changes no hash.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/draft.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Hashes are SHA-256 over canonical JSON with sorted keys, so object key order does not matter, matching submission identity (`contributor-contracts.md:39`).
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): stored plan of task drafts validated with the submit schema`.

**Acceptance:** A draft is checked with the very schema `lz-submit-task` uses, is stored even when incomplete with per-task problems listed, and a finding goes stale exactly when its draft field changed.

### Task 11: Renderers (chat breakdown and full plan)

**Files:**

- Modify or create: `src/planning/render.ts`, `src/planning/links.ts` (`planMarkdownLink` only).
- Test: `src/planning/render.test.ts`.

**Interfaces:**

- `planMarkdownLink(planningID: string, projectID: string): string` returns `[Full plan](.lazers/plans/<hex(projectID)>/<planningID>)`. The prefix is `.lazers/plans/`, and the hex encoding is the same as `encodeProjectID` (`src/tasks/links.ts:15-19`); export and reuse it.
- `renderBreakdown(input: { body: PlanningBody; revision: number; validation: Validation; planningID: string; projectID: string; review?: ReviewSummary }): string`
  - The task line is `<n>. <draftID> — <first sentence of objective, max 100 chars, "…" if cut>`, then ` · after a, b` when there are dependencies, then ` · incomplete` when the draft has validation problems.
- `renderFullPlan(body, revision): string`. Markdown with `# <title> (r<n>)`, `## Ask`, `## Assumptions`, `## Open decisions`, `## Plan` (plan-level fields as JSON), then for each draft `## Task <draftID>` with `dependsOn` and the proposal as fenced JSON. Agents target `unit` = the draftID or a section heading.
- `ReviewSummary = { agents: number; notRun: number; findings: Record<FindingSeverity, number>; ownerQuestions: number; tokens: number; costUSD?: number }`

- [ ] **Step 1: Write the failing test.**

  Fixture:
  - Title "Planning flow", revision 3, projectID "proj", planningID `0b4e2c1a-0000-4000-8000-000000000001`.
  - Draft `store-schema`, objective "Store plan drafts and their revisions. Keep every revision.", no dependencies.
  - Draft `breakdown`, objective "Render the chat breakdown from the stored plan.", depends on `store-schema`.
  - Draft `plan-link`, objective "Open a stored plan from a chat link.", depends on `store-schema` and `breakdown`, and has a validation problem.
  - Open decision `D1` "Which slicer is the default?" with options whole, pre-slice, uncertainty.

  Assert that `renderBreakdown` equals exactly:

  ```
  **Planning flow** · r3
  1. store-schema — Store plan drafts and their revisions.
  2. breakdown — Render the chat breakdown from the stored plan. · after store-schema
  3. plan-link — Open a stored plan from a chat link. · after store-schema, breakdown · incomplete

  Open decisions
  - D1 Which slicer is the default? (whole / pre-slice / uncertainty)

  [Full plan](.lazers/plans/70726f6a/0b4e2c1a-0000-4000-8000-000000000001)
  Reply LGTM to continue, a change to revise, or "just task it" to skip the agents.
  ```

  Also assert:
  - With `review: {agents:5, notRun:1, findings:{blocker:1,major:4,minor:2,nit:0}, ownerQuestions:3, tokens:412000, costUSD:0.83}`, a line `Review r3: 5 agents (1 not run) · 7 findings (1 blocker, 4 major) · 3 questions for you · 412,000 tokens · $0.83` sits between the open decisions and the link.
  - With no price the `· $…` part is omitted.
  - With no open decisions the section and its blank line are omitted.
  - `renderFullPlan` contains `## Task plan-link`.

- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/render.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): render the chat breakdown and the full plan from the stored drafts`.

**Acceptance:** A stored plan renders to the exact terse breakdown (tasks with dependencies, then open decisions, then the link) and to the full plan the agents read, both from the same stored drafts.

### Task 12: `lz-plan-draft` (store, revise, abandon, finalize, guide, evidence)

**Files:**

- Create: `src/planning/tools.ts` (this tool), `src/guidance/planning-show.md`.
- Modify: `src/guidance/index.ts` (runbooks :15-24; `retrieval` :34-37 gains the four planning topics → `` `lz-plan-draft` with `action: "guide", topic` ``), `src/planning/server.ts`.
- Test: `src/planning/tools.test.ts`.

**Interfaces:**

```ts
export const PlanDraftInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("store"),
    planningID: z.uuid().optional(),
    expectedRevision: z.int().positive().optional(),
    decisionMessageID: z.string().optional(),
    /** The Architect's own classification of the ask (owner correction, 2026-11-20). Written with `PlanningStore.setArchitectPick(decisionID, pick)` to the decision row's `architect_json`, source `architect`, so it is compared with D1 on the same ask. */
    architectPick: z
      .strictObject({
        size: z.enum(["one task", "a few tasks", "a large effort"]).optional(),
        agents: z.array(PlanningAgentId).optional(),
      })
      .optional(),
    body: PlanningBody,
  }),
  z.strictObject({
    action: z.literal("finalize"),
    planningID: z.uuid(),
    body: PlanningBody.optional(),
  }), // the one post-final update; final-review → ready
  z.strictObject({
    action: z.literal("abandon"),
    planningID: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    action: z.literal("guide"),
    topic: z.enum(["draft", "show", "resolve", "brainstorm"]),
  }),
  z.strictObject({ action: z.literal("evidence"), planningID: z.uuid(), draftID: DraftID }),
])
type StoreResult =
  | {
      status: "stored"
      planningID: string
      revision: number
      state: PlanningState
      breakdown: string
      link: string
      validation: Validation
      deferred: typeof DEFERRED_TO_TASKING
      runbook?: string
    }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; errors: { path: string; message: string }[] }
```

- **Permissions.** Permission `lz-plan-draft`, added to the Architect only (`src/architect.ts`). Planning agents stay denied by `lz-*` (`src/planning/register.ts:35`).
- **Store transitions.** A store in `ready` moves the plan to `drafted`. In other non-terminal states it is a self transition. In `tasked` or `abandoned` it returns `{status:"invalid", errors:[{path:"planningID", message:"plan is tasked; start a new plan"}]}`.
- **Runbook delivery.** The first store in a session carries the `planning-show` runbook (`Delivery.once`, `src/guidance/index.ts:74-110`).
- **`evidence`.** Returns up to 20 strings of at most 6,000 characters (the `TaskReviewInput.evidence` bounds, `src/webgpu/task-review.ts:15-21`): owner answers and resolved findings concerning that draft, each as `"Planning <source> on <field>: <what> — resolved <outcome>: <answer or evidence>"`.
- **Two plannings** in one session are independent rows.

- [ ] **Step 1: Write the failing tests:**
  - A store without `planningID` creates the row in `drafted` with revision 1 and returns the exact Task 11 breakdown for the fixture.
  - A second store with `expectedRevision: 1` gives revision 2. A third with `expectedRevision: 1` gives `{status:"conflict", currentRevision:2}`.
  - Storing in `ready` moves to `drafted`.
  - `abandon` then `store` returns `invalid`.
  - Two plannings in one session get distinct ids and links.
  - The first store's result has `runbook` and the second has a pointer line.
  - `guide` `brainstorm` returns the runbook text.
  - `evidence` for a draft with one owner-answered question returns one string that includes the answer.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/tools.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Write `planning-show.md`: reply with the breakdown exactly as returned; LGTM → `lz-plan-review`; a change → revise and store; "just task it" → `lz-plan-task`; never rewrite the breakdown by hand.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): store, revise and abandon a plan with lz-plan-draft`.

**Acceptance:** The Architect stores and revises a plan of task drafts, receives the generated breakdown and link, cannot silently overwrite a newer revision, and an edit after `ready` returns the plan to `drafted`.

### Task 13: Plan link handler, `lz.planning` RPC and the plan view

**Files:**

- Create: `src/planning/links.ts` (parse and handler), `src/planning/rpc-contract.ts`, `src/planning/panel.tsx`.
- Modify: `src/planning/server.ts` (RPC), `src/gui.tsx` (`setupPlanningPanel(ctx)` beside `setupTaskPanel`, :154).
- Test: `src/planning/links.test.ts`, `src/planning/view-model.test.ts`.

**Interfaces:**

- `parsePlanLink(href): {planningID, projectID} | undefined`
- `createPlanLinkHandler(services): LinkHandler`. A copy of `createTaskLinkHandler` (`src/tasks/links.ts:82-125`): priority 100, it owns malformed `.lazers/plans/` links, and it resolves only when the planning's `project_key` matches the session's project (`sameProject`).
- RPC `lz.planning`:
  - `get({planningID, revision?}) → PlanningView`
  - `list({sessionID?}) → {id,title,state,revision,updatedAt}[]`
- `PlanningView = { id; title; state; revision; body; validation; breakdown; findings: (StoredFinding & {stale: boolean})[]; questions: StoredQuestion[]; reviews: { id; stage; revision; agents: { agent; status: "running"|"stuck"|"reviewed"|"not-run"; attempts; tokens; durationMs; reason? }[]; costUSD? }[]; tasked?: { draftID; reference; changedFields: string[] }[] }`
- `planningViewModel(view): Section[]`, a pure function the panel renders:
  - tasks with dependencies, validation marks, and the findings per draft and field, with stale ones labelled "stale (r<n>)";
  - open decisions;
  - questions with their route;
  - agents with status and cost;
  - after tasking, the task reference per draft and "changed after review: writeScope".
- The view is read-only. The owner steers through the Architect.

- [ ] **Step 1: Write the failing tests:**
  - `parsePlanLink(planMarkdownLink(id,"proj").href)` round-trips.
  - `.lazers/plans/zz/x` is owned but unresolved.
  - A link whose planning belongs to another project resolves to `undefined` (another-project case).
  - `planningViewModel` for a fixture with one stale finding shows the label `stale (r1)`.
  - A stuck agent shows `stuck`, retrying.
  - A tasked draft shows its `LZ-n` and `changed after review: writeScope`.
  - Absent cost omits the cost row (no "unknown").
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/links.test.ts src/planning/view-model.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** The panel follows the Tasks panel's tab registration (`ctx.layout.open(`${ctx.id}:planning`, session, {tab:"select"})`) and `DESIGN.md` for styling.
- [ ] **Step 4: Run.** Expect PASS. Then `bun run build` and `bun scripts/verify-gui-bundle.ts`.
- [ ] **Step 5: Commit** `feat(planning): plan link and plan view`.

**Acceptance:** Clicking the breakdown's link in the plan's own project opens a view of the stored plan with findings (stale marked), questions, agent status and cost, and the link resolves to nothing from another project.

---

## Stage D: review

### Task 14: Review message, path check and the agent-adding rule

**Files:**

- Create: `src/planning/prompt.ts`, `src/planning/checks.ts`.
- Modify: `scripts/planning-agent-prompt.ts` (:42-60 move into `prompt.ts`).
- Test: `src/planning/prompt.test.ts`, `src/planning/checks.test.ts`.

**Interfaces:**

- `planningReviewMessage({planMarkdown, source, mapText}): string`. The plan block and map block exactly as the script builds them today: a backtick fence longer than any in the plan, and the untrusted-content sentence.
- `pathCheck(body, mapPaths: ReadonlySet<string>): PlanningFinding[]`
  - For each draft, each `writeScope` entry without glob characters must be in the map or under a `createScope` folder. A glob entry must match at least one map path (`Bun.Glob`) or sit under a `createScope` folder.
  - Each miss is a finding with `id: "P<n>"`, severity `major`, confidence `confirmed`, `target {unit: draftID, field: "write-scope"}`, `evidence: ["<path> is not in the repository map (hash <h>)"]`. `source` is `"path-check"`.
- `export const AGENT_RULES = [{ id: "stored-data", agent: "critic", test: /(^|\/)(migrations?|schema)(\/|\.|$)|database-schema\.ts$|\.sql$/ }] as const`, applied to `writeScope` and `createScope` paths. `rulesAdd(body): {agent, ruleID}[]`. One deterministic rule, as data.
- The overlap check is dropped (design outcome; zoom-out z1).

- [ ] **Step 1: Write the failing tests:**
  - The script's stdout for `design/architect-planning.md` with agent `readiness` is byte-identical before and after the extraction. Capture the expected output in the test as a hash of the current output.
  - `pathCheck` flags `src/nope.ts` and passes `src/planning/contract.ts` and `src/planning/new/**` when `createScope` has `src/planning/new/`.
  - A draft writing `src/database-schema.ts` yields `rulesAdd` `[{agent:"critic", ruleID:"stored-data"}]`.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/prompt.test.ts src/planning/checks.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): review message, path check and the stored-data rule`.

**Acceptance:** The runtime builds the same review message the hand runs used, flags draft paths missing from the repository map, and adds Critic for a draft that writes stored-data files, all with no model.

### Task 15: Planning host adapter

**Files:**

- Create: `src/planning/host.ts`.
- Test: `src/planning/host.test.ts`.

**Interfaces:**

```ts
export interface PlanningHost {
  create(input: {
    id: string
    parentID: string
    agent: string
    model?: ModelRef
    directory: string
    title: string
  }): Promise<"created" | "exists">
  prompt(input: {
    sessionID: string
    messageID: string
    text: string
    directory: string
  }): Promise<void>
  observe(sessionID: string): Promise<
    | { found: false }
    | {
        found: true
        updatedAt: number
        busyAt?: number
        idleAt?: number
        outcome?: "succeeded" | "failed" | "interrupted"
      }
  >
  reply(sessionID: string): Promise<
    | {
        text: string
        finish: string | null
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        model?: ModelRef
      }
    | undefined
  >
  interrupt(sessionID: string): Promise<void>
}
export function planningHost(ctx: Pick<Plugin.Context, "session">): PlanningHost
```

- `create` mirrors `src/runner/native.ts:1078-1098` (`ctx.session.create` with a chosen `Session.ID`, `parentID`, `agent`, `model`, `location`, `title`, `metadata: {lazersPlanningRun: id}`). An "already exists" error maps to `"exists"`.
- `observe` reads `time.updated`, `time.busy`, `time.idle` and the last outcome (`node_modules/@opencode/schema/dist/session.d.ts:139-147`).
- `reply` reads the last assistant message through `ctx.session.context`, as `src/runner/native.ts:776` does.
- Model comes from `agentRoutes(PLANNING_ROUTE_ID)?.route ?? agentRoutes("lazers-implementor")?.route`, and is otherwise omitted so the registered agent's native route applies (`src/planning/register.ts:68-69`).

- [ ] **Step 1: Write the failing tests** against a stub `ctx.session`:
  - `create` passes the exact id, parent, agent `lazers-planning-grounding` and title.
  - An already-exists failure returns `"exists"`.
  - `observe` on `SessionNotFoundError` returns `{found:false}`.
  - `reply` returns the last assistant text and `finish: "length"` when the stub says so.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/host.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): host adapter for planning child sessions`.

**Acceptance:** One small adapter creates a planning child with a chosen id and route, prompts it, observes progress and completion, reads its reply and interrupts it.

### Task 16: Review executor (parallel children, retry, stuck, persisted wait)

**Files:**

- Create: `src/planning/reviews.ts`.
- Modify: `src/planning/server.ts`. Register the scheduler participant `sharedScheduler.register(JSON.stringify(["planning", projectDirectory]), {intervalMs: 1000, run: () => reviews.tick()})` (`src/runner/scheduler-coordinator.ts:49`). Registrations with the same key share one group.
- Test: `src/planning/reviews.test.ts`.

**Interfaces:**

```ts
export const PLANNING_AGENT_INACTIVITY_MS = 5 * 60_000 // hand-picked starting value; not measured. Replaced by: 3 × p99 of planning_runs.max_gap_ms over ≥50 reviewed runs, rounded up to a minute, floor 2 min (planning-report §Reviews).
export type AgentSelection = {
  agent: PlanningAgentId
  source: "decision" | "architect" | "rule:stored-data" | "final"
}
export type ReviewResult = {
  reviewID: string
  planningID: string
  revision: number
  stage: "review" | "final"
  agents: {
    agent: PlanningAgentId
    status: "reviewed" | "not-run"
    reason?: string
    attempts: number
    tokens: number
    durationMs: number
    bySeverity: Record<FindingSeverity, number>
  }[]
  findings: StoredFinding[]
  questions: StoredQuestion[]
  summary: ReviewSummary
  breakdown: string
  runbook?: string
}
export class PlanningReviews {
  constructor(deps: {
    store: PlanningStore
    host: PlanningHost
    now: () => number
    pollMs?: number
    inactivityMs?: number
    mapFor: (
      directory: string,
    ) => Promise<{ text: string; hash: string; tokens: number; paths: ReadonlySet<string> }>
    notify: (sessionID: string, id: string, text: string) => Promise<void>
    title: (agent: PlanningAgentId, revision: number) => string
  })
  start(input: {
    planningID: string
    stage: "review" | "final"
    agents: AgentSelection[]
    parentSessionID: string
    directory: string
  }): Promise<ReviewRow> // joins an open review of the same planning, stage and revision
  run(reviewID: string, signal?: AbortSignal): Promise<ReviewResult> // blocking; Promise.all over agents; marks returned_at
  advance(reviewID: string): Promise<ReviewRow> // one step per run; used by run() and tick()
  cancel(reviewID: string, reason: string): Promise<void> // interrupt children; runs → cancelled
  tick(): Promise<void> // advance open reviews; notify settled reviews with no live caller
}
```

**Run step rules.** The run machine is `planningRun` from Task 1.

- **Before creating anything.** Insert the run row in `starting` with `session_id = ses_<uuid>` and `prompt_message_id`. Then `create`, then `prompt` with the review message (Task 14). A move to `running` follows the first observation where `busyAt ≥ started_at`, mirroring `delegated-native-lifecycle.ts:56-62`, which notes that a child is created idle and an idle before the prompt proves nothing.
- **Starting after a restart.** On tick, if the session is missing, `create` again with the recorded id. If it exists but the prompt message is absent, prompt again with the same `messageID`.
- **Progress.** Each `updatedAt` increase sets `last_activity_at` and updates `max_gap_ms`.
- **Done** (`idleAt > busyAt`, with an outcome):
  - `succeeded`: `reply`, then `parsePlanningResult`.
    - Parse failure: `failed` with reason `malformed: <first 300 chars of the error>`.
    - `finish === "length"`: `failed` with reason `truncated`.
    - Otherwise `reviewed`, storing findings, questions and tokens.
  - `failed` or `interrupted`: `failed` with that reason.
  - The raw reply is always kept.
- **Stuck.** When `now − last_activity_at ≥ inactivityMs`, interrupt the child and move to `stuck`.
- **Retry.** A `failed` or `stuck` run with attempt 1 creates attempt 2 in a fresh child. The prompt appends `A previous attempt ended: <reason>. Reply with the JSON object only.`. A second `failed` or `stuck` makes the agent `not-run` with the last reason. An agent result with `status: "not-run"` is `reviewed` with that status and is not retried: it is the agent's own answer.
- **Settled.** When every agent has a terminal outcome, `settled_at` is set and the planning moves `in-review → questions-open`, or stays in `final-review` for the final stage. The findings are inserted with the review's revision, and `draft_id` is resolved when `unit` equals a draftID. The path-check findings from Task 14 are inserted at `start`.
- **Abort.** `signal` aborts lead to `cancel`: children are interrupted, runs become `cancelled`, the agents are `not-run "cancelled"`, and the review settles.
- **Restart.** `run()` registers the review in an in-memory `live` set. `tick` notifies only settled reviews with `returned_at` and `notified_at` both null and not in `live`, with id `lazers-planning-review:<reviewID>` and text `[lz-notice kind=planning-review plan=<planningID> v=<revision>]` plus the breakdown and the counts. Then it sets `notified_at`.
- **Capacity, settled here.** Plugin-created children are not counted against the delegated-agent limit, and stay uncounted. Native admissions exist only for host subagent tool calls (`src/runner/roles.ts:216`). `bindNativeChildFromCreatedSession` binds only a session matching an admitted request (`src/runner/delegated-agent-capacity.ts:1061-1086`), so a planning child binds nothing. Queueing a blocking Architect tool call behind a worker of up to an hour would stall the conversation. The child count is shown in the plan view instead.

- [ ] **Step 1: Write the failing tests** with a stub host, a scripted clock and `pollMs: 0`:
  1. **Succeed.** Two agents whose replies are valid JSON. `run` resolves with both `reviewed`, findings stored with revision 3, the planning in `questions-open`, `returned_at` set and `notify` never called.
  2. **Malformed.** Grounding's first reply is `{"agent":"grounding"` (truncated JSON) and its second is valid: attempts 2, `reviewed`, the first run `failed` with reason starting `malformed:`, raw reply kept. Comprehension returns invalid JSON twice: `not-run`, reason `malformed: …`, attempts 2.
  3. **Truncated.** `finish: "length"` gives reason `truncated`.
  4. **Hung.** The stub never advances `updatedAt`. After the clock passes `inactivityMs`, `interrupt` is called, the run is `stuck` and attempt 2 starts. A second hang makes it `not-run`, reason `stuck`. Total `interrupt` calls: 2.
  5. **Restart.** Start a review, advance until both runs are `running`, then drop the executor without calling `run`. A new `PlanningReviews` on the same database runs `tick` until settled: `notify` is called once with id `lazers-planning-review:<id>`, and a second `tick` calls it 0 more times. A run left in `starting` whose session the stub reports missing is created again with the same session id.
  6. **Abort.** `run(id, signal)` with abort after start: both children interrupted, both agents `not-run "cancelled"`, the planning in `questions-open`.
  7. **Edit during review.** While running, the store appends revision 4 changing `plan-link.writeScope`. The findings are stored with revision 3, and the view-model marks the write-scope finding stale.
  8. **Capacity untouched.** After a review, the `delegated_agent_admissions` row count is unchanged.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/reviews.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Conditional updates use `state=?`, as in `takeover.ts:414-440`, so `run()` and `tick()` can race safely.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): run planning agents in parallel with retry, stuck detection and a persisted wait`.

**Acceptance:** Agents that succeed, return malformed or truncated JSON, hang or are cancelled each end in the right recorded status. A review cut by a restart finishes from stored state and is reported once, and planning children never take delegated-agent slots.

### Task 17: `lz-plan-review` (selection and auto-dispatch)

**Files:**

- Modify: `src/planning/tools.ts`, `src/planning/server.ts`.
- Create: `src/guidance/planning-resolve.md` (text; Task 18 refines it).
- Test: `src/planning/review-tool.test.ts`.

**Interfaces:**

- Input: `{ planningID: uuid, stage: "review"|"final" = "review", agents?: PlanningAgentId[] }`.
- Output: `ReviewResult | { status: "needs-agents"; scores?: Record<PlanningAgentId, number>; reason: string }`.
- **Selection for `review`:**
  - Auto-dispatch on and the planning's decision `decided` (complex): the selection is the decision's selected agents ∪ `rulesAdd` ∪ the `agents` argument, with the source recorded per agent.
  - Decision `none`, `unavailable` or missing: `agents` is required. Without it, the tool returns `needs-agents` with the weak scores, and nothing starts.
  - `planningAutoDispatch` off: only `agents`. Without it, `needs-agents` with reason "automatic planning agents are off for this project".
- `final` uses Task 19's rules.
- Transitions: `drafted → in-review` or `questions-open → in-review` on start. A start from `final-review`, `ready`, `tasked` or `abandoned` returns `{status:"invalid"}` with the state named.
- Blocking: `Effect.promise((signal) => reviews.run(id, signal))`. The first result in a session carries the `planning-resolve` runbook.

- [ ] **Step 1: Write the failing tests:**
  - A decided decision `[grounding, readiness]` with a draft writing `src/database-schema.ts` selects `[grounding, readiness, critic]` with sources `decision, decision, rule:stored-data`.
  - Adding `agents: ["zoom-out"]` gives four agents.
  - A `none` decision with no `agents` returns `needs-agents`, and no run rows exist.
  - Auto-dispatch off with no `agents` returns `needs-agents`, and with `agents: ["critic"]` runs only critic.
  - The planning moves `drafted → in-review → questions-open`.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/review-tool.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): lz-plan-review runs the selected planning agents on the stored plan`.

**Acceptance:** Review runs the decision's agents plus the rule's, the Architect's choice applies when the decision is not trusted or auto-dispatch is off, and the tool blocks until every agent settles.

---

## Stage E: resolution, final pass and tasking

### Task 18: `lz-plan-resolve` (finding outcomes and question routing)

**Files:**

- Modify: `src/planning/tools.ts`, `src/guidance/planning-resolve.md`.
- Test: `src/planning/resolve.test.ts`.

**Interfaces:**

```ts
export const ResolveInput = z.strictObject({
  planningID: z.uuid(),
  findings: z
    .array(
      z.discriminatedUnion("outcome", [
        z.strictObject({
          findingID: z.string(),
          outcome: z.literal("revised"),
          revision: z.int().positive(),
        }),
        z.strictObject({
          findingID: z.string(),
          outcome: z.literal("contested"),
          evidence: z.array(z.string().min(1)).min(1).max(10),
        }), // path:line or a quoted plan line
        z.strictObject({ findingID: z.string(), outcome: z.literal("to-owner") }),
      ]),
    )
    .max(500)
    .default([]),
  questions: z
    .array(
      z.discriminatedUnion("route", [
        z.strictObject({
          questionID: z.string(),
          route: z.literal("conversation"),
          answer: z.string().min(1),
          citation: z.strictObject({ messageID: z.string(), quote: z.string().min(8).max(2000) }),
        }),
        z.strictObject({ questionID: z.string(), route: z.literal("owner") }),
        z.strictObject({ questionID: z.string(), route: z.literal("merged"), into: z.string() }),
        z.strictObject({
          questionID: z.string(),
          route: z.literal("owner-answered"),
          answer: z.string().min(1),
          messageID: z.string(),
        }),
      ]),
    )
    .max(500)
    .default([]),
})
type ResolveResult = {
  applied: number
  refused: { id: string; reason: string }[]
  ownerBatch: string
  openCount: number
  suggestedMerges: string[][]
}
```

- **Conversation answers.** A `conversation` answer is applied only when `quote` occurs verbatim in the cited message of the Architect's own session (read with the host messages, `RunnerHost.session(id, {messages:true})`). Otherwise it is refused with `citation not found in <messageID>`. This enforces "answers only what the conversation states".
- **`revised`.** Needs `revision > finding.revision`, and the finding's draft field must have changed by then (`isStale`). Otherwise it is refused with `field unchanged since r<n>`.
- **`merged`.** Allowed when both questions' related findings share `(draftID, field)` or their normalized text (lower case, collapsed whitespace) is equal. `suggestedMerges` lists those groups.
- **`ownerBatch`.** The open owner questions as one numbered list, ordered by weight (`changes-design`, `changes-scope`, `changes-detail`), then by the related finding's severity, then by agent order. Each line is `n. <question> (<options joined " / ">) — <agent>, <draftID>.<field>`. The Architect asks them in one native question form.
- **Planning machine.** Unchanged: resolution happens in `questions-open` or `final-review`.

- [ ] **Step 1: Write the failing tests:**
  - A citation whose quote is in the stub message applies. A quote not in it is refused with `citation not found`.
  - `revised` with an unchanged field is refused.
  - Two questions on `plan-link.write-scope` appear in `suggestedMerges`, and merging one into the other leaves one open.
  - `ownerBatch` for three questions of weights detail, design and scope lists design, then scope, then detail, with exact strings.
  - A finding `to-owner` plus its question `owner-answered` shows `answered` in the view-model.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/resolve.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Write `planning-resolve.md`:
  - Answer a question yourself only with a verbatim citation from this conversation. Every other question goes to the owner in one batch.
  - For each finding: revise the plan and store it, or contest it with evidence the reviewer could read, or pass it to the owner.
  - You are not conservative with questions.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): resolve findings and route questions with citations`.

**Acceptance:** Every finding ends revised (proved by a changed field), contested with evidence, or passed to the owner. A question answered from the conversation must cite it verbatim, and the owner receives one ordered, de-duplicated batch.

### Task 19: The final pass and finalize

**Files:**

- Modify: `src/planning/tools.ts` (`stage: "final"` and `action: "finalize"`).
- Test: `src/planning/final.test.ts`.

**Interfaces:**

- `export const FINAL_PASS_AGENT: PlanningAgentId = "readiness"`. One agent; the lead's default recorded in the design.
- `lz-plan-review {stage:"final"}` is allowed from `questions-open`. It moves to `final-review` and runs Readiness on the current revision with source `final`. The `agents` argument is ignored for this stage, and the result says so.
- Its blockers and questions are resolved with `lz-plan-resolve` as in step 10: questions go to the owner.
- `lz-plan-draft {action:"finalize", body?}` stores the one post-final update, or none, and moves `final-review → ready`. The result's breakdown carries the line `Final r<n> — tasking next. Reply "stop" to keep it open.`. This is informational, not a gate (comprehension C7).
- Finalize is accepted with findings still open. They stay visible and are listed in the result as `open: n`.

- [ ] **Step 1: Write the failing tests:**
  - From `questions-open`, a final review runs exactly one child, `lazers-planning-readiness`.
  - A final-pass question appears in `ownerBatch`.
  - `finalize` moves to `ready`, stores revision n+1 when a body is given, and the breakdown ends with the final line.
  - A subsequent `store` moves `ready → drafted`.
  - `stage:"final"` from `drafted` is `invalid`.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/final.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): final Readiness pass and the single post-final update`.

**Acceptance:** After the owner's answers, exactly one Readiness pass runs on the latest revision. Its questions reach the owner, and the plan becomes `ready` with one recorded update.

### Task 20: `lz-plan-task` ("just task it" and normal tasking) and self-review

**Files:**

- Modify:
  - `src/submission.ts`, `src/tools.ts:113-163`: extract `submitTaskReceipt(deps, input, sessionID)`, the body of `lz-submit-task`'s execute (Fallow gate, starting revision, `submitTask`, `observeRevision`, summary). `lz-submit-task` calls it unchanged.
  - `src/runner/tools.ts:21-30`: extract `submitPlanReceipt(runtime, onPlanSubmitted, input, sessionID)`.
  - `src/planning/tools.ts`.
  - `src/webgpu/task-review.ts:12-26`: refusal text over the limits.
- Test: `src/planning/task-tool.test.ts`, `src/tools.test.ts` (unchanged behaviour), `src/webgpu/task-review.test.ts`.

**Interfaces:**

- Input: `{ planningID: uuid, baseCommit?: string, selfReviews?: {draftID, reviewID: uuid}[] }`. Allowed from every non-terminal state ("just task it").
- Output: `{ status: "tasked"; planID: string; tasks: {draftID, taskID, reference, link}[]; changedAfterReview: Record<string, string[]> } | { status: "invalid"; drafts: Record<string, {path, message}[]>; plan: {path, message}[] }`.
- **Order of operations:**
  1. Cancel open reviews of the planning, interrupting their children.
  2. Read the current revision and run every deferred check (`DEFERRED_TO_TASKING`) on every draft before writing anything:
     - `TaskSubmissionSchema` with key `planning:<planningID>:<draftID>:r<revision>`;
     - classification present;
     - `invalidVerificationTimings`;
     - the graph;
     - `PlanSubmissionInput.parse` of the assembled plan: `requestID: planning:<planningID>:r<revision>`, nodes `{taskID, revision:1, persona}`, dependencies from `dependsOn`, `integrationOrder` topological with ties broken by draft order, `baseCommit` given or HEAD of the location directory, plus the plan-level fields.

     Any failure returns `invalid` with nothing written and the state unchanged.

  3. Otherwise call `submitTaskReceipt` per draft as stored, then `submitPlanReceipt`.
  4. Write `planning_tasked`, with `changed_fields_json = changedFields(lastReviewedRevisionBody, current)`, then move to `tasked`.
  5. A retry after an ambiguous failure replays: the keys are deterministic.
- **Self-review.** `lz-verify-task` still runs per draft, by the Architect, before `lz-plan-task`, with `evidence` from `lz-plan-draft {action:"evidence"}`. The `planning-resolve` runbook says that a self-review concern on a field already resolved by a planning finding or an owner answer is closed by citing that evidence, never asked again. `selfReviews` reviewIDs are recorded for measurement. The task-review limits stay (`task-review.ts:12,18`). Over them, the error reads `This item is too large for one task: split it into tasks in the plan (limit: <what>).`.

- [ ] **Step 1: Write the failing tests:**
  - From `drafted` with three valid drafts: three tasks saved with `idempotencyKey` `planning:<id>:<draftID>:r1`, one plan admitted with dependencies `store-schema→breakdown` and `breakdown→plan-link`, the state `tasked`, and the references mapped.
  - From `in-review`: children interrupted, runs `cancelled`, then tasked.
  - A draft missing `classification` returns `invalid` with `drafts["plan-link"]` naming `classification`, zero tasks saved and the state unchanged.
  - Reviewed at r2, then `writeScope` changed in r3, then tasked: `changedAfterReview` is `{"plan-link":["writeScope"]}` and the view shows it.
  - Calling `lz-plan-task` twice returns the same task ids (idempotent replay).
  - The existing `lz-submit-task` and `lz-submit-plan` tests pass unchanged.
  - Task-review input with 21 evidence entries returns the split message.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/planning/task-tool.test.ts src/tools.test.ts src/runner/tools.test.ts src/webgpu/task-review.test.ts`. Expect FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): task a stored plan as it is through the submit paths`.

**Acceptance:** "Just task it" works from every open state and submits the stored drafts unchanged through the same functions as `lz-submit-task` and `lz-submit-plan`. Nothing is written unless every draft passes, changes after the last review are recorded, and each draft maps to its real task.

---

## Stage F: runbooks and the Architect file

### Task 21: Brainstorm and drafting/hardening runbooks; Architect intro

**Files:**

- Create: `src/guidance/planning-draft.md`, `src/guidance/planning-brainstorm.md`.
- Modify: `src/guidance/index.ts`, `src/architect.md` (a short "Planning" paragraph after "Specify", :34-86, and two lines in "Situational guidance", :106-116).
- Test: `src/guidance/guidance.test.ts`.

**Content (owner style: short, imperative):**

- **`planning-draft`.**
  - Draft the plan as complete task drafts in `TaskProposalSchema` shape with stable draftIDs.
  - Harden your own draft first: read the code each task touches, check every claim, write acceptance a broken result would fail.
  - Ask the owner all your own questions in one batch.
  - Then store with `lz-plan-draft` and show the breakdown.
  - Use the project's verification commands (its profile when one exists).
- **`planning-brainstorm`.**
  - For a complex ask with no clear agent signal: recommend a brainstorm. The owner decides.
  - The brainstorm settles direction in prose and is not stored.
  - Write task drafts only after direction is settled.
  - Never for a simple ask.
- **`architect.md` paragraph.** Each ask arrives with an `[lz-planning decision]` note. Simple: task it. Complex: draft, harden, store, show, then review on LGTM, resolve, final pass, task. "Just task it" from any step.

- [ ] **Step 1: Write the failing tests:**
  - `runbook("planning-brainstorm")` is non-empty.
  - `pointer("planning-draft")` names `` `lz-plan-draft` with `action: "guide", topic: "draft"` ``.
  - The `architect.md` text contains `lz-plan-draft` and does not exceed its current length plus 600 characters.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/guidance/guidance.test.ts`. Expect FAIL.
- [ ] **Step 3: Write the text.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `docs(planning): drafting, hardening and brainstorm runbooks; Architect intro`.

**Acceptance:** Each runbook arrives once per session where its step starts, with a pointer after, and the Architect's standing prompt grows by one short paragraph.

---

## Stage G: Settings

### Task 22: Settings controls

**Files:**

- Modify: `src/gui.tsx` (LAZERS settings page, :158-201), `src/projects/gui.tsx` (beside spend ceiling, :244-251).
- Test: `src/projects/gui.test.ts`, or the existing settings view test, as a pure view-model test.

**Interfaces:**

- Global "Planning" group:
  - "Decision model": Local (D1) / External model / Architect decides.
    - External picks from the host catalogue's decision models; the host refuses others.
    - Shows "Sends the ask text to <provider>."
  - "Slicing": Uncertainty (default) / Whole text / Pre-sliced.
- Per project: switch "Planning agents run automatically", default on.
- Planning-agent route: already in Assignments ("Planning agents"). Nothing to add.
- Writes go through `lz.projects.setSetting` (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - The view-model for default settings shows "Local (D1)", "Uncertainty" and the switch on.
  - Choosing External without a model keeps the old value and shows the `SETTING_INVALID` message beside the field.
- [ ] **Step 2: Run** the test. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS, then `bun run build`.
- [ ] **Step 5: Commit** `feat(planning): Settings for the decision model, slicing and automatic planning agents`.

**Acceptance:** The owner can choose the decision model and the slicer and turn planning agents off per project, and an external route is labelled as sending the ask off the machine.

---

## Stage H: retention, outcome measurement, docs

### Task 23: Retention of finished planning detail

**Files:**

- Modify: `src/retention/retention.ts` (`RetentionKindID` :63, `KINDS` :173).
- Test: `src/retention/retention.test.ts`.

**Interfaces:** Kind `planning-detail`, label "Plan drafts", optional table.

- **Removes:** for plannings in `tasked` or `abandoned` whose `updated_at` is before the cutoff, and whose `tasked_plan_id` (if any) is in `TERMINAL_PLAN_STATES` (:17):
  - `planning_revisions` rows except the first, every reviewed revision, and the last;
  - `planning_runs.raw_reply`, set to NULL.
- **Never removes** decisions, nodes, findings, questions, tasked mappings, or the measurement columns of runs.

- [ ] **Step 1: Write the failing test:**
  - A tasked planning with revisions 1 to 5, reviewed at 2 and 4, integrated plan, older than 30 days: `preview` counts 1 revision (r3) plus raw replies. `retire` removes exactly those.
  - An `in-review` planning keeps everything.
  - A second `retire` finds nothing.
- [ ] **Step 2: Run** `bun test --timeout 120000 src/retention/retention.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(retention): retire finished planning detail`.

**Acceptance:** Finished plans lose only intermediate revisions and raw agent replies after the chosen age. Everything the measurement needs stays.

### Task 24: Review, question and outcome reports (measurement M3)

**Files:**

- Modify: `scripts/planning-report.ts`, `scripts/planning-report.test.ts`.

**Adds three sections** (definitions under "Measurement design"):

- §Reviews: per agent.
- §Questions.
- §Outcomes and per-finding prediction.

- [ ] **Step 1: Write the failing test** on a fixture database:
  - Agent `grounding`: `notRunRate 1/4`, reasons `{malformed:1}`, `maxGap p99` from fixture runs, and `suggestedInactivityMs = max(120000, ceil(3×p99 / 60000) × 60000)` printed beside the current constant.
  - Questions: `{raised: 9, conversation: 2, owner: 5, merged: 2}`.
  - Outcomes: a tasked planning whose task has one `REPAIR` and one `SCOPE_AMENDED` in `runner_transitions` reports `repairs: 1, scopeAmended: 1`. A write-scope finding on that draft counts as `predicted: true`.
  - Planning-agent token and duration p50 and p95.
  - Fewer than 50 reviewed runs prints `inactivity span: not enough runs (n=4)`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(planning): report reviews, questions and plan outcomes`.

**Acceptance:** The report joins every finding to the real task it concerned and to that task's later repairs, scope changes, takeovers and failed combined checks, and prints the evidence for moving the threshold and the inactivity span.

### Task 25: Contracts, design status and a live walkthrough

**Files:**

- Modify: `docs/reference/contributor-contracts.md`. Replace "Nothing in the runtime starts them yet" (:55) with the flow, the tools, the two machines, and capacity not counted.
- Modify: `design/architect-planning.md`. Set the status to built, and add the measurement links.

**Walkthrough** (dogfood per `AGENTS.md`, regular Desktop, after `bun run build` and a reload at a quiet point):

1. Ask one line, and confirm the note says one task.
2. Ask this plan's own goal, and confirm a decided note, then draft, store, breakdown, and the link opening the view.
3. LGTM, and confirm a review whose children appear under the session. Note seconds and tokens.
4. Restart the service mid-review, and confirm the notice arrives once.
5. Close the Desktop window, ask again, and confirm the note says `no-window`.
6. "Just task it" on a second plan in the same session.
7. Confirm in the request inspector that the `context` hook matched by message id. If it matched by text, record that.

- [ ] **Commit** `docs(planning): contracts and status for the planning flow`.

**Acceptance:** Every Review Focus case was exercised once in the real app, and the host facts confirmed only by reading source are confirmed by running.

---

## Measurement design

**What is recorded.**

- **Per decision** (`planning_decisions` plus `planning_decision_nodes`):
  - ask text and length, project and session;
  - slicer strategy, decider and model, every constant in effect (`constants_json`, so a later threshold change can be replayed against the old one);
  - status and reason, size, per-agent combined score with the node it came from, selected agents;
  - model time, wall time and call count, the open plannings at the time, the delivered note, and any late result.
  - Per node: span offsets and kind, depth, every call's questions and full probabilities, input tokens, elapsed time, and outcome (confident, expanded, pruned, depth-stop, budget-stop, single-sentence, pre-sliced, skipped-oversize, simple).
- **Per review** (`planning_reviews` plus `planning_runs`): stage, revision, selected agents with their source; per attempt the agent, child session, state, reason, raw reply, input, output and cache tokens, model, map hash and tokens, duration, last activity and maximum gap between progress observations.
- **Findings and questions:**
  - Findings: source, severity, confidence, draft and field, revision, resolution and resolved revision.
  - Questions: weight, route (conversation with citation, owner, merged into, owner-answered) and answer.
- **Outcome.** `planning_tasked` maps draft → task → plan. Outcomes are read from `runner_transitions` (`src/runner/store.ts:705`):
  - `REPAIR` (repairs);
  - `SCOPE_AMENDED`, `SCOPE_SENT_BACK`, `SCOPE_DECISION_REQUIRED` (scope amendments and stops);
  - `TAKEOVER_STARTED` (takeovers);
  - `BLOCKED` on the plan with the combined-check reason (failed combined verification). The exact reason prefix is read from `src/runner/verification-review.ts` or `runtime.ts` at implementation time.

  The baseline is the same counts over plans not created by planning in the same window.

**Where it is stored.** The planning tables (Task 2), in the shared task database, like `repo_map_deliveries`.

**The report** (`scripts/planning-report.ts`, read-only) prints:

- **Decisions:**
  - status rates;
  - below-threshold rate;
  - pick rate per agent, flagging any agent picked for 90% or more of complex asks (the same trap as "none");
  - top-score against score-spread as predictors of "agent needed", by area under the curve. "Agent needed" means it produced at least one major or blocker finding that was revised or sent to the owner. Measured only over reviews where that agent ran, and planning-flow selection keeps nearly all agents running, so this sample exists.
  - decision time per node and per ask, by input-length bucket;
  - size against the number of tasks the planning became (or tasks submitted from that session before the next user message, for simple asks).
- **Strategies:** replay agreement and cost per strategy on the same asks.
- **Reviews:** tokens, duration, not-run rate and reasons, gap distribution.
- **Questions:** route shares.
- **Outcomes:** per-plan counts against the baseline, and per finding whether its prediction happened. A write-scope finding is joined to `SCOPE_*` events; acceptance or verification findings to `REPAIR` or failed checks; other fields are unscored.

**Starting values.** `AGENT_THRESHOLD = 0.22` is a hand-picked starting value, labelled as such in code: uniform over five is 0.20, which is "unsure". The same applies to the band, flat spread, beam width 2, depth 2, budget 1,500 ms, delivery wait 3,000 ms and the inactivity span of 5 minutes. Each is replaced only by the report's rule:

- **Threshold:** the largest value whose selection keeps at least 95% of needed agents over at least 100 reviewed complex asks.
- **Depth:** from the Task 3 latency fit.
- **Inactivity span:** the larger of 2 minutes and three times the p99 maximum gap over at least 50 reviewed runs, rounded up to a minute.

**How the inactivity span is measured.**

- Each run records `max_gap_ms`, the largest interval between successive increases of the child session's `time.updated`, observed at a 1-second poll plus events, from `running` to done.
- Only `reviewed` runs count. A stuck run is the event being bounded, not a sample.
- This is the verification inactivity pattern (`src/runner/verification-timeout.ts:4`): real progress resets the allowance.

**Default slicer.** It stays (c). It changes on these recorded results:

- to (a) if, over at least 100 complex asks replayed both ways, (a) agrees with (c) on at least 95% of per-agent run/cut decisions and (c) costs at least 1.5× (a)'s model time;
- to (b) if (b) beats (c) on recall of needed agents by at least 5 points at no more model time.

---

## Parallel, serial, and external dependencies

- **Serial spine:** 1 → 2 → 8 → 12 → 16 → 17 → 18 → 19 → 20 → 25.
- **Parallel immediately:** 3 (measurement; needs a Desktop window for the live run only), 4, 5, 15.
- **After 5:** 6; then 7 (types only) in parallel with 6.
- **After 2:** 9 (report code; useful once 8 records data), 10 → 11 → 13 (13 also needs 12), 14 (needs 10 and 11), 23.
- **After 4:** 22.
- **After 8 and 12:** 21.
- **24** needs 9, 16 and 20.
- **Runtime split** (`.agents/plans/runtime-split.md`): nothing here waits on it.
  - The Architect seams it moved already exist (`architect-sources.ts`, `architect-ownership.ts`, `architect-renewal.ts`), and this plan does not edit them.
  - The decision step hooks `src/index.ts`, not `ArchitectSources`.
  - Tasking calls `runtime.submitPlan` (`runtime.ts:5348`) through the existing tool body. If S19 later moves it, the coordinator forwarder keeps the call working.
- **Project profile** (`design/project-profile.md`, not planned here), three shared seams:
  1. The Architect prompt hook in `src/index.ts:113-120`. Profile adds setup guidance at session start; planning adds `startDecision`. These are independent lines in one hook body, and the second to land merges.
  2. Structured setting values (Task 4). The first plan to reach it owns it.
  3. Settings UI (`src/gui.tsx`, `src/projects/gui.tsx`), where profile adds a "Verification" group per project.

  Order: either may go first. Planning's drafting runbook refers to "the project's verification commands (its profile when one exists)", so neither blocks the other.

---

## Self-review

### Design requirements → tasks

| Requirement                                                                                                                           | Task                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Eleven-step flow; never a gate; "just task it" from every state                                                                       | 1, 12, 17, 18, 19, 20, 21 |
| Simple = one task; complex = a few or large; unclear derived                                                                          | 6, 8                      |
| Forced choice, no "none"; none derived; per-agent rule; max over pieces; largest size; threshold just above unsure, labelled          | 6                         |
| Recursive slicing, beam, depth and latency bound, follow-ups as data, three strategies, tree recorded                                 | 5, 6, 8                   |
| Real input limit, latency against length, encoding reuse                                                                              | 3                         |
| No window → Architect decides; external model only if catalogued                                                                      | 7, 8                      |
| Every decision recorded from day one; backtest and report                                                                             | 2, 8, 9, 24               |
| Architect hardens first, sole author; questions batched                                                                               | 12, 21                    |
| Stored plan = task drafts in submit shapes; validated with the same schema; deferred checks named                                     | 10, 12                    |
| Tasking submits drafts as they are; changes after review recorded; draft → task mapping                                               | 20                        |
| Chat breakdown and view rendered from drafts; link handler and panel                                                                  | 11, 13                    |
| Agents in fresh context with plan plus map, read-only; findings typed; failure = not-run; retry once; stuck after measured inactivity | 14, 15, 16                |
| Findings carry revision; stale shown, not dropped                                                                                     | 10, 13, 16                |
| Restart mid-review rebuilt from stored state; owner leaves → state persists                                                           | 16                        |
| Questions pass through the Architect, which answers only cited conversation facts                                                     | 18                        |
| Final pass = Readiness; its questions go to the owner; one update                                                                     | 19                        |
| Path-not-in-map check; one rule adds an agent; overlap check dropped                                                                  | 14                        |
| Auto-dispatch on by default per project; decision model and route settings                                                            | 4, 17, 22                 |
| No spend ceiling; cost shown                                                                                                          | 11, 13, 16                |
| Brainstorm is prose, complex-and-unclear only, never simple                                                                           | 8, 21                     |
| `lz-verify-task` still per task, not asked twice; split message                                                                       | 20                        |
| Retention of finished planning                                                                                                        | 23                        |
| Each build step states its acceptance                                                                                                 | every task                |

### Reviewer majors → answer

| Finding                                                        | Answer                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comprehension C1 (row mapping), Readiness R3                   | Task 6 statuses and Global Constraints: size alone decides the row. "Unclear" is derived (no agent clears T, or the bound is hit), not judged.                                                                                                                                                                                                  |
| Comprehension C2 (below-threshold decides what)                | Tasks 6 and 17: below threshold the Architect picks the agents only; flow entry is by size.                                                                                                                                                                                                                                                     |
| Comprehension C3 (final-pass set and order)                    | Task 19: Readiness only, on the latest revision. The one update is the finalize after its questions are answered.                                                                                                                                                                                                                               |
| Critic C1 (ask text not stored)                                | Task 8 records ask text from day one. Task 9 refuses an empty sample and prints counts. The first threshold is labelled hand-picked.                                                                                                                                                                                                            |
| Critic C2 (revision link)                                      | Tasks 10, 13, 16: findings keyed to revision and draft field, staleness by field hashes, reviews pinned to a revision.                                                                                                                                                                                                                          |
| Critic C3 (partial completion)                                 | Task 16 (retry, stuck, not-run, abort) and Task 1 (every state exits; the plan stays open; nothing on a timer).                                                                                                                                                                                                                                 |
| Critic C4 (cost unbounded)                                     | Answered by the owner: no ceiling. Tokens and cost recorded per agent (Task 16), shown (Tasks 11, 13), reported (Task 24).                                                                                                                                                                                                                      |
| Final f1 (question skills)                                     | Only the five agents are ranked (Task 6); question skills deferred.                                                                                                                                                                                                                                                                             |
| Final f2 and f3, Readiness R2 (combine rules, threshold scale) | Task 6: probability scale of the 5-way choice; per agent max over final nodes; size max; T = 0.22 labelled.                                                                                                                                                                                                                                     |
| Final f4, Readiness R4 (failure defined)                       | Task 16: session failure, malformed or truncated reply, or stuck after the inactivity span; one retry; agent-declared not-run kept.                                                                                                                                                                                                             |
| Final f5 (stored format)                                       | Task 10: `PlanningBody` with `TaskProposalSchema` drafts; every revision kept; finding and question rows in Task 2.                                                                                                                                                                                                                             |
| Final f6 (final blockers)                                      | Task 19: final-pass questions go to the owner via resolve, then finalize, then task.                                                                                                                                                                                                                                                            |
| Final f7 (plan view)                                           | Task 13.                                                                                                                                                                                                                                                                                                                                        |
| Final f10, Readiness R1 (no acceptance per step)               | Every task has a failing test with assertions and one acceptance sentence.                                                                                                                                                                                                                                                                      |
| Readiness R5 (transitions, abandon, restart, edit after ready) | Task 1 (edges), Task 16 (restart), Task 20 (just task it cancels running agents; late findings after exit are not stored because the runs are cancelled), Task 23 (retention).                                                                                                                                                                  |
| Grounding G1 (already exists)                                  | The header lists what exists; nothing re-planned.                                                                                                                                                                                                                                                                                               |
| Grounding G2 (closed route enums)                              | Already done on `main`: one shared route `lazers-planning` (`register.ts`).                                                                                                                                                                                                                                                                     |
| Zoom-out z1 (overlap check)                                    | Dropped; path check kept (Task 14).                                                                                                                                                                                                                                                                                                             |
| Zoom-out z2 (ranking not worth it)                             | Owner decision: selection built and permissive, measured from day one. Task 9 and Task 24 report whether ranking predicts needed agents, so it can be removed on evidence.                                                                                                                                                                      |
| Minors                                                         | C5 and G4 (`lz-verify-task` named; split message): Task 20. C6 (attention style): exact string in Task 11. C7 (owner sees final): Task 19. Critic C6 (agent text is data; external route sends content): Tasks 14, 22. Critic C7 (additive tables): Task 2. f8 (retention): Task 23. f9 (auto-dispatch default and rule trigger): Tasks 14, 17. |

### Decisions taken here that the design implied (no owner question needed)

- Delivery is by a request-only `context` hook note, so storage is untouched and the cache stays stable.
- Tasking is one tool, `lz-plan-task`, calling the extracted bodies of `lz-submit-task` and `lz-submit-plan`.
- Planning children are not counted against the delegated-agent limit.
- The review starts when the Architect calls it on LGTM. Auto-dispatch governs which agents run, not when.
- A conversation answer requires a verbatim citation.

### Open questions for the owner

1. **Threshold arithmetic.** The agent question is one forced 5-way choice, so its probabilities sum to 1. On a single unsplit node, at most four agents can exceed 0.22, and usually one to three do. "Nearly all five run" then comes from the maximum over the tree's parts on longer asks. Keep the forced 5-way ranking (as built here) and let the records decide? Or score each agent with its own yes/no question, which gives independent scores but offers the model a per-agent "no"?
2. **Notice after a restart.** The settled-review notice resumes an idle Architect, so the conversation continues without the owner. Should it instead wait as a queued notice until the owner's next prompt? This plan resumes, matching how takeover results are delivered.

### Critical files for implementation

- /Users/tjw/Documents/ChatGPT/opencode-lazers/src/index.ts
- /Users/tjw/Documents/ChatGPT/opencode-lazers/src/runner/lifecycle-machines.ts
- /Users/tjw/Documents/ChatGPT/opencode-lazers/src/webgpu/system-one.ts
- /Users/tjw/Documents/ChatGPT/opencode-lazers/src/task.ts
- /Users/tjw/Documents/ChatGPT/opencode-lazers/src/runner/takeover.ts

## Corrections (host)

Differences found while implementing Tasks 4 and 15 against the code on `main`.

**Task 4**

- The setting declarations moved to a new pure-zod file, `src/projects/setting-schemas.ts` (not in the plan's file list). It holds one `setting(schema, builtIn)` entry per setting; `GlobalSettings`, `ProjectSettings`, the built-in defaults, write validation and the RPC views (`GlobalSettingsView`, `ProjectSettingsView` in `contract.ts`) are all derived from it, so a new setting (the project profile's structured value) is added by one entry there. It is separate from `settings.ts` because `contract.ts` is imported by the GUI bundle and `settings.ts` imports the database schema.
- The hand-written view schemas in `contract.ts` are replaced by the derived ones. The plan said `setSetting.input.value` becomes `z.json()`; it did, and `null` still clears the stored value.
- Existing tests that asserted the whole settings object with `toEqual` (`settings.test.ts` x2, `rpc.test.ts` x1) now use `toMatchObject`, since the objects gained keys. No assertion about an existing setting's value changed.
- A test writes rows in the previous code's format (JSON text per number setting) and reads them back.

**Task 15**

- `create` maps "already exists" by reading the session back after any create failure: the native API has no typed duplicate-session error (`SessionNotFoundError` is the only tag the code relies on). A failed create whose id does not read back rethrows.
- `reply` sums tokens over every assistant step after the last user message, not only the last assistant message, because a review of several tool steps spends tokens in each. `text` is the last assistant message that has text; `finish` is the final step's finish reason.
- `prompt`'s `directory` is part of the port but the native `session.prompt` addresses the session by id, so it is not sent.
- The route lookup is exported as `planningModel(routes?)` (`lazers-planning`, else `lazers-implementor`, else undefined); `create` takes the model from the caller rather than reading routes itself, so the adapter stays a pure `ctx.session` wrapper.
- `ModelRef` is the existing `ModelPolicy` (`providerID`, `id`, `variant?`).

## Corrections (core)

Differences found while implementing Tasks 1, 2, 10 and 11 against the code on `main`.

- **Task 1: `starting` is an event.** `defineLifecycle` adds a self edge to every state, so `planningRun` has the event `starting`. The plan's dead-ends classification omitted it; it is listed as observable. `src/runner/lifecycle-machines.test.ts` also has a `goals` table (terminal states reachable from every state); `planning` and `planningRun` are added there. `PlanningState` and `PlanningRunState` are explicit unions, because `keyof typeof machine.config.states` resolves to `never` for machines built by `defineLifecycle`.
- **Task 2: where the schema installs.** `installPlanningSchema(repository)` is exported from `src/planning/store.ts` and called from `TaskRepository.open()` in `src/storage.ts` under its own `shared.once("planning", …)` key, as repo-map is. The plan only named `src/database-schema.ts`. The store methods take camelCase rows (columns snake_case) and keep JSON columns as strings; `appendRevision` takes `body`, `validation`, `hashes` as values and stringifies them.
- **Task 10: `z.unknown()` is a required key in zod 4.** `TaskDraft.proposal`, `plan.verification` and `plan.acceptance` are `z.unknown().optional()`, so a draft or plan stored without them is accepted (the plan's intent: store even when incomplete). `validateBody` reports the absence.
- **Task 10: `validateBody` lists only drafts with problems** (`drafts` has no key for a complete draft). Plan-level problems have paths prefixed `verification.` / `acceptance.`. A cycle is reported once per cycle with `draftID` the entry point and `detail` the path (`a → b → a`).
- **Task 10: `fieldHashes`** keys per draft: each proposal key, `dependsOn` (sorted), `persona`, and `*`. `@plan` holds `title`, `ask`, `assumptions`, `openDecisions`, each plan-level field, and `*` over the whole body with tasks sorted by `draftID`. `changedFields` also reports `@plan` when a plan-level key changed. A finding with `draftID: null` reads `@plan`.
- **Task 11: blank lines.** The breakdown is blocks joined by one blank line (tasks, open decisions, link block). With no open decisions the section and its separator go, so one blank line remains between the tasks and the link. The review line is the first line of the link block. Answered decisions are not listed as open. The findings parenthesis lists only blockers and majors, as in the plan's example; singular nouns are used for a count of 1.
- **Task 11: `encodeProjectID`** in `src/tasks/links.ts` is now exported (no other change there).

## Corrections (decision)

Differences found while implementing Tasks 5 to 8 against the code on `main` and the owner decision of 2026-11-20 (all five agents run, scores recorded, nothing selected).

- **Decision output is context, not routing.** `DecisionOutcome` has no `none` status. A cost bound (budget, depth) ends the search with `stopped` set on a `decided` outcome; nothing refuses. `selected` is every agent whose combined score is at or above `agentThreshold`, and the default `0` cuts none. `unavailable` reasons: `no-window`, `feature-off`, `no-model`, `error`, `over-limit`, `budget`, and `timeout` (set by the delivery step).
- **Questions.** The default per agent per piece is one yes/no question (`noul`), with its one-line "use when" as the criteria; the 5-way `choice` is behind `agentForm: "choice"` for the replay script. One question per request (`batch: false`); `batch: true` sends a piece's questions together. Question text lives in `src/planning/decision/tree.ts` and is the single definition the decider and the note both use.
- **Input bound.** No request carries more than `maxInputTokens` 400: state is limited to `(400 - 100 reserved for the question) x 3` chars (`stateLimit`), `charsPerToken` 3 being below the measured prose figure and labelled unmeasured. Measurement M1 (Task 3) was not part of this batch.
- **Slicers.** A fourth strategy `windows` is the default: `sentenceWindows` makes windows of 4 sentences (a heading, list item or fenced block counts as one unit) with a one-sentence overlap, each packed to the limit by necessity. `whole`, `pre-slice` (`fixedSlices`) and `uncertainty` (beam, children, follow-ups) are the other three behind `decide`. The plan's fixture block is 28 characters, so the oversize test uses a 25-character limit instead of 40.
- **Agent order.** `AGENT_ORDER` (run order: comprehension, grounding, readiness, critic, zoom-out, from `planningAgents`) is used for scores and notes; `PLANNING_AGENT_IDS` in `contract.ts` has a different order and is not used for that.
- **Follow-ups** run only at depth-0 nodes of `whole` and `uncertainty`; "floor" raises the agent's score to `followUpFloor` (0.22).
- **Wiring.** `PlanningDecisions` (`src/planning/decision/step.ts`) is built by `createPlanningDecisions` in `src/planning/server.ts` and held in `src/index.ts`, not `src/core/core.ts`, so `core.ts` is unchanged (it already exposes `inferenceBroker`). The agent of a session is read with `ctx.session.get` and cached in `index.ts`. The local "decisions" feature being off is not checked up front (the feature state lives inside the webgpu server): `systemOne` answers with an error, which the step records as `error`.
- **Context hook** matches by message id; a message without an id matches the recorded ask text. The host fact (does the `context` hook's message carry the prompt's `messageID`) is still to confirm in the Task 25 walkthrough.
- **Runbooks.** `planning-draft` and `planning-brainstorm` are written by Task 21. The note takes an optional runbook text (full first, pointer afterwards, from the store) through `PlanningServiceDeps.runbook`; none is passed yet.
- **Table.** `planning_decisions` gained `architect_json` (schema module `planning` generation 2; an `ALTER TABLE` adds it to a database installed at generation 1). `PlanningStore` gained `setArchitectPick`, `addDecisionNodes`, `sessionDecisions`. Task 12's `lz-plan-draft` store input gets the optional `architectPick` field (written into its section above); the tool is not built here.
- **Late results.** A decision that finishes after the delivery wait leaves its row `unavailable`/`timeout`, writes `late_json` (status, size, scores) and adds its nodes; `delivered_text` never changes.
- **No `Decider.selected`/settings wiring.** `decisionModel`, `decisionSlicer` settings from Task 4 are not read yet: the local decider and the default strategy are used. `deciderFor(setting, parts)` takes the setting value so the wiring is one line when the settings reach this code.

## Corrections (draft)

- **Settings wiring.** `decisionSlicer` gained the value `windows` and its default is now `windows` (the owner's default slicer); the Task 4 default `uncertainty` would have overridden it. The decider and constants are read from `globalSettings` at each ask (`PlanningServiceDeps.decider` may be async; `constants` may be a function). The "decisions" feature is read from `ctx.storage` `webgpu.features` as the local inference server does, so a switched-off feature records `feature-off`.
- **Task 12: `expectedRevision` is required to revise.** A store with `planningID` and no `expectedRevision` is `invalid` (`path: "expectedRevision"`), so a revision never silently overwrites; the plan only said a stale one conflicts.
- **Task 12: guide topics.** Only `show` has a runbook (`src/guidance/planning-show.md`, registered with a retrieval pointer). `draft`, `resolve` and `brainstorm` return a "not written yet" message until Task 21 writes them.
- **Task 12: `finalize`** is implemented here (final-review to ready, optional body appended at the current revision); the final pass that calls it is Task 19. `abandon` moves any open state to `abandoned` and leaves cancelling running review runs to Task 16. `PlanningStore.setTitle` keeps the row title equal to the latest revision's.
- **Task 12: permission.** Workers deny `lz-plan-draft` in `src/runner/roles.ts` (as `lz-project-profile`); the Architect needs no allow rule. The tool is registered in `src/index.ts`, not `src/planning/server.ts`.
- **Task 12: breakdown review line.** `renderBreakdown` is called without a `review` until Task 17 stores reviews.
- **Task 13: files.** The view types and `planningViewModel` are in `src/planning/view-model.ts` (pure, no server imports, so the GUI bundle stays small); `src/planning/read.ts` builds the view from the store; `src/planning/sentence.ts` holds `firstSentence`, shared with `render.ts`. `PlanLinkTarget` etc. live in `links.ts` beside `planMarkdownLink`. `decodeProjectID` is exported from `src/tasks/links.ts` next to `encodeProjectID`.
- **Task 13: RPC.** `lz.planning` has a third method, `resolve({planningID})`, returning only what the link handler needs (project key and directory), so a link never loads a whole plan. `get` returns `null` for a plan that is missing or another project's. The RPC registers from `src/index.ts` through `registerPlanningRpc` in `src/planning/server.ts`.
- **Task 13: view.** `findings[].stale` is computed on the server with `isStale` against the shown revision. An agent's status comes from its latest run (`failed` and `cancelled` read as `not-run`); cost is absent until Task 24 prices tokens. The panel polls every 3 s while the tab is open and shows the latest plan of the session when no link selected one. Tab icon is the host `task` icon; menu order 80.

## Corrections (review)

- **Task 16: the notice id.** A native message id must be `msg_` plus alphanumerics, so `lazers-planning-review:<reviewID>` is refused by `SessionMessage.ID`. The notice id is `reviewNoticeID(reviewID)` = `msg_<reviewID without dashes>`: still one stable id per review. Child session ids are `ses_<uuid>` and prompt message ids `msg_<uuid>`, recorded on the run row before anything is created.
- **Task 16: `AgentSelection.source`** gains `all` (the owner's decision: all five agents run, selection cuts none); `decision` and `architect` stay for a future threshold and for an explicit `agents` argument. The review's `selection_json` is `{agents, parentSessionID, directory}`, so a restart knows where to create children and which session to notify.
- **Task 16: settling is one transaction.** `PlanningStore.settleReview` sets `settled_at` only if unset and, in the same transaction, inserts the findings and questions (ids `<runID>:<agentID>`, revision of the review) and moves an `in-review` plan to `questions-open`. A second caller changes nothing. Path-check findings are inserted at `start` (source `path-check`, run id `path-check`).
- **Task 16: starting runs.** A prompt is sent once per run per process (`prompted` set); after a restart the same prompt message id is sent again, and the host treats a repeated id as the same message. A run that cannot start for `inactivityMs` ends `failed: could not start: ...` and takes the one retry. Progress is any change of the child's `updatedAt`; a new process counts its first observation as progress.
- **Task 16: cancelling** also records a `cancelled` second attempt for an agent whose first attempt had failed or stuck, so no retry follows. `cancelForPlanning` cancels every open review of a plan.
- **Task 16: the repository map** is read once per review (`mapFor`), and its paths come from the "Source files:" lines of the map text (`mapPathsOf`), because `RepoMap` carries no path list.
- **Task 14: the script** prints the agent prompt, then `planningReviewMessage`; a hash test over a fixture repository keeps its output byte-identical. `pathCheck` takes the map hash as an optional third argument for its evidence text.
- **Task 17: selection follows the owner's decision.** With automatic dispatch on, the review runs the decision's selected agents when it `decided` (all five at the default threshold of 0), else all five; the stored-data rule and the `agents` argument add to that, each with its source. The plan's `needs-agents` for a `none` or `unavailable` decision no longer occurs; it remains for automatic dispatch off with no `agents`. The switch is the project setting `planningAutoDispatch`, read at each call.
- **Task 17: `stage: "final"`** returns `invalid` until Task 19 defines the final pass's agents. `lz-plan-review` is denied to workers like `lz-plan-draft`. `planning-resolve.md` is written in full here (it is the runbook the first review result carries, and `lz-plan-draft` `guide` topic `resolve` returns it).
- **Task 17: abandon cancels review runs.** `PlanDrafts` takes a `cancelReviews` callback, wired in `src/index.ts` to `PlanningReviews.cancelForPlanning`, so an abandoned plan's running children are interrupted and their runs end `cancelled`.
- **Task 18: what counts as open.** `openCount` is the questions routed `open` or `owner` plus the findings still `open`. `ownerBatch` lists only questions routed `owner`, ordered by weight, then the related finding's severity (blocker first), then agent run order; a question with no related finding ends `— <agent>, plan`. A question answered by `conversation` or `owner-answered` also moves its related finding to `answered` when that finding was `open` or `to-owner`.
- **Task 18: merge rule.** A merge needs both questions on the same `(draft, field)` of their related findings, or equal normalized text. `suggestedMerges` is every such group of two or more open or owner questions (a group by field and a group by text are both listed, once each).
- **Task 18: the citation check** reads the Architect's session with `ctx.session.context` (`sessionMessageText` in `src/planning/server.ts`), not `RunnerHost.session`, since the tool already runs inside the plugin context; user and synthetic messages use their `text`, assistant messages their text parts. `lz-plan-resolve` is denied to workers like the other planning tools.

## Corrections (finish)

- **Task 19: where the move happens.** `PlanningReviews.start` moves a `questions-open` plan to `final-review` for stage `final` (a plan already in `final-review` joins or restarts the pass), so the tool needs no extra transition. `FINAL_PASS_AGENT` is exported from `src/planning/tools.ts`. The `agents` argument is ignored for the final stage and the result carries `note`.
- **Task 19: finalize result.** Besides the final line (`Final r<n> — tasking next. Reply "stop" to keep it open.`), the `stored` result of `finalize` carries `open`: the findings still `open` plus the questions routed `open` or `owner`.
- **Task 20: shared functions.** `submitTaskReceipt(deps, input, sessionID)`, `repositoryRunner(repository)` and `taskSubmitter(ctx, repository, timeoutDefaults, fallowGate)` are in `src/tools.ts`; `lz-submit-task` calls the same function. `submitPlanReceipt(runtime, onPlanSubmitted, input, sessionID)` is in `src/runner/tools.ts`. `runtime.ts` is untouched.
- **Task 20: order.** Every check runs first, then the open reviews are cancelled (the plan cancelled first): an `invalid` result disturbs nothing. The classification is required for a draft unless the draft already has a `planning_tasked` row for it (a retry after an ambiguous failure replays an earlier submission). Graph and plan-level problems are reported under the draft's `dependsOn` and under `plan`; the assembled plan is checked against `PlanSubmissionInput` with placeholder task ids before the first task is written.
- **Task 20: results.** A second call on a `tasked` plan returns the recorded tasks without submitting anything. `changedAfterReview` compares the current revision with the latest settled review's revision (empty when no review settled or none is older than the current revision); it also lists `@plan` when plan-level fields changed. The tasking class lives in `src/planning/tasking.ts`; `registerPlanTaskTool` in `src/planning/tools.ts`.
- **Task 20: split message.** Any `too_big` issue of `lz-verify-task`'s input (evidence over 20, text over 6,000 characters, a task array over its bound) reads `This item is too large for one task: split it into tasks in the plan (limit: <n> entries|characters).`
- **Task 21: delivery.** The drafting runbook rides the first decision note of a session for any ask that is not a simple one (decided or not run), with a pointer afterwards; a `a large effort` ask also carries the brainstorm runbook once (through `Delivery`). `PlanningServiceDeps.runbook` now takes `(first, {size, sessionID})`. The resolving runbook rides the first `lz-plan-review` result and the showing runbook the first `lz-plan-draft` store result; `lz-plan-draft` `guide` returns any of the four.
- **Task 21: the not-run note** tells the Architect to pass its picks as `architectPick` when it stores the plan. `src/architect.md` gained a "Planning" paragraph and one line in "Situational guidance" (14,026 characters, under the 14,107 bound the guidance test checks).

## Corrections (settings)

- **Task 22: slicer labels.** The slicer choices are Sentence windows (the default, per the owner), Uncertainty, Whole text and Pre-sliced; the plan's default "Uncertainty" no longer applies. The decision model and slicing rows are at the top of the Projects section, since that section already reads and writes global settings through `lz.projects`; the per-project switch is a child row under each project.
- **Task 22: layout.** Each row's trailing slot holds one select or one switch. The external model's provider and model inputs (fixed 140 px) and its "Sends the ask text to <provider>." notice sit under the row title and wrap. The host catalogue of decision models is not enumerated: the provider and model are typed, and the host refuses an unsupported one when the decider first runs (the decider then reports `no-model`).
- **Task 22: the planning-agent route** stays in the Models panel's Assignments ("Planning agents"); nothing was added.
- **Task 23: how it retires.** `planning-detail` ("Plan drafts") is added to `KINDS` by `KINDS.push` after the table so it can name `TERMINAL_PLAN_STATES`. It deletes `planning_revisions` rows between the first and last revision that no review reviewed, and sets `planning_runs.raw_reply` to NULL (a new `clear` column on the retention `Spec`, whose `where` excludes NULLs so a second run finds nothing). A planning is finished when it is `tasked` or `abandoned`, untouched since the cutoff, and (when tasked) its runner plan is `integrated` or `cancelled`. It is not tied to the runner plan being past the cutoff or having no waiting notice, since the draft detail is independent of those. No new constant: the age is the retention setting.
- **Task 24: sections.** `reviewsReport`, `questionsReport` and `outcomesReport` are exported from `scripts/planning-report.ts` and printed after the decisions. A review unit is (review, agent): it is not-run when its last attempt is not `reviewed`, or the agent answered `not-run` itself; the reason is the part before the first colon. Failed attempts' tokens count toward cost and tokens, and only `reviewed` attempts toward the percentiles and the gap evidence. `owner` counts questions routed `owner` and `owner-answered`; an `open` count appears only when some are unrouted. The failed-combined-check count is a `BLOCKED` transition with no task whose payload reason starts `Combined verification`. The baseline is every runner plan the flow did not create (runner plans carry no date, so `--since` narrows only the planned side).
- **Task 24: cost.** `reviewsReport(db, filter, price?)` and `PlanningReviewsDeps.price` take a price lookup (USD per million tokens by model) and show a cost only when every run was priced; with none, no cost appears. The production price lookup is asynchronous (the model price index), so `src/index.ts` does not pass one yet: reviews and the report show tokens, and cost once the lookup is wired. Exact edit: pass `price` to `createPlanningReviews` from a synchronous read of `resolvePrice` over the cached price snapshot.

## Corrections (observations)

- **What D1 is asked.** `src/planning/decision/observations.ts` holds 13 yes/no observations (wording and criteria from the second spike run, with the reworded `open_choice` and `wording_only`), one request each, plus one Score "How many separate changes does this text describe?" per piece (14 requests a piece). The per-agent, size and 5-way questions remain in `tree.ts` as `agentForm: "yesno" | "choice"` for replay only; the default is `observations`.
- **Code decides.** A rule table (`AGENT_RULES`) maps observations to agents: the largest P(yes) of each observation over the pieces, then the largest of the rule's observations. No `wording_only` guard. Yes at 0.7 or more, no at 0.3 or less, between is "Architect decides". Selection still cuts nothing (threshold 0): all five run. Comprehension also scores 1 when the ask has 8 or more pieces.
- **Size is a recorded guess.** It comes from the expected number of changes (Score levels weighted 1, 2.5, 5, times 0.75 with several pieces) and is stored with `sizeReliable: false`. Nothing routes on it: the note no longer says "no planning flow" for one task, the draft runbook is delivered to every ask's first note (pointer afterwards), and the brainstorm runbook is no longer delivered with a "large effort" guess; the drafting runbook tells the Architect to recommend one on its own judgment and to read it with `guide` topic `brainstorm`.
- **Strategies.** In the observation form `uncertainty` behaves as `whole`: the beam works on per-piece agent scores, which this form does not have. Follow-ups apply only to the old forms. The `planning` table module is generation 3 (`observations_json`, the per-observation maxima with the piece they came from). The local and external deciders now map `score` answers.
- **Note.** A decided note states each observation in plain words with yes, unsure or no and its score, then each agent as yes, Architect decides or no, then the unreliable size guess. The not-run note lists the same observations, as questions, from the same definitions, with the size choices and each agent's use-when line.
- **Report.** `planning-report` prints per-observation yes/unsure/no counts and the yes rate, and the per-agent band counts; `--replay --form` replays with any of the three forms.
