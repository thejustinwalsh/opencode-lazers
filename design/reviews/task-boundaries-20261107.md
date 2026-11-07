# Task boundaries and orchestration overhead

## Finding

We violated the original mission by optimizing for narrowly scoped activity
instead of completed software. Root repeatedly requested small increments;
`src/architect.md` then said to split independently verifiable changes. That
criterion is too weak: almost any edit can be tested separately. Architect chose
the boundaries; no inspected rule required a task per line or file.

The [original brief](../../.agents/docs/sources/original-design-brief.md) already
requires process proportional to complexity, a single worker by default, useful
verification boundaries, and decomposition based on independence. Avoiding epics
does not require dispatching individual implementation steps.

## Research and application

- [Building effective agents](https://www.anthropic.com/research/building-effective-agents)
  recommends the simplest sufficient system and explicitly recognizes the latency
  and cost tradeoff of orchestration. Apply this by starting with one worker;
  additional workers need a concrete benefit.
- [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)
  uses feature-by-feature implementation and end-to-end testing, with coherent
  progress preserved between sessions. Its unit is working behavior, not an
  individual edit. Apply this by keeping implementation, relevant tests and
  correction in one outcome.
- [A Tale of Slicing and Imagination](https://agilealliance.org/resources/experience-reports/a-tale-of-slicing-and-imagination/)
  describes vertical slices across architectural layers rather than layer-based
  assignments. Apply this to plugin tools, persistence and UI needed for the
  same usable behavior; separate layers only when they are useful deliverables.
- [Towards a Science of Scaling Agent Systems, v3](https://arxiv.org/abs/2512.08296v3)
  reports coordination overhead and task-dependent benefits across 260 evaluated
  configurations, including degradation on sequential planning. This supports
  measuring the cost of splitting; it does not establish an optimal task duration
  or size for Luna in this repository.

These are design inputs, not proof that our revised guidance works.

## Observed examples

| Work                                              | Assessment                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LZ-137 Code Mode flag and registration test       | Desktop retained output shows two insertions/two deletions and a 2m36s worker run. A valid standalone urgent fix, but related exposure corrections should share a worker when known together. Small diff alone does not justify another orchestration cycle.        |
| LZ-175/176/177/178 retained-verification recovery | Separate defects were discovered serially; that does not prove they were all predictable upfront. Treat a discovered prerequisite as part of delivering the original coherent repair when scope permits, rather than automatically opening another execution chain. |
| LZ-179 → LZ-180                                   | Same behavior resubmitted to avoid an occupied test-file scope; zero attempts on179. This is a scope/control overhead symptom, not two useful delivered outcomes. Preserve history and the active180 worker.                                                        |
| LZ-172 Models UI                                  | Candidate waited about22h at the earlier delivery snapshot. This is a review/integration bottleneck, not evidence that the task should be subdivided.                                                                                                               |
| LZ-170 → LZ-171                                   | Asynchronous verification and mechanical candidate fixes are related but nontrivial. Inspect their actual shared execution path before consolidating; do not force either a split or a merge based on titles alone.                                                 |

Timings and limits are recorded in [delivery bottleneck](delivery-bottleneck-20261107.md).
The recent fourteen persisted objectives were inspected read-only. They include
substantial lifecycle and pricing work; the claim that all recent tasks change
one or two lines is not supported. Excessive coordination remains demonstrated.

## Current rule

A feature is the default task, with related implementation, fixes and verification.
Bugs and refactors follow coherent behavior or responsibility boundaries.
Start with one worker. Split for independently useful outcomes,
meaningful parallelism, or a material risk/context boundary. Keep discoveries and
routine repairs with the same worker through existing scope controls. Each split
must earn its research, dispatch, review and integration cost. Line counts, file
counts, layers and separately testable assertions do not define task boundaries.

Examples: task history filters plus navigation into the selected old trajectory
can be one usable outcome; separate tickets for a filter control, query argument,
renderer branch and tests would merely move implementation steps into scheduling.
An unrelated scheduler repair and that UI outcome can be independent work.

No new required sizing field, approval round, model judge or runtime admission
gate is added. Existing task schema and Architect self-review remain. Existing
running workers and useful retained work are preserved.

## Applied correction and validation

Updated the packaged Architect definition, README decomposition contract, task
authoring guide and current phase planning guidance. Sent the live Architect a
Desktop correction to audit unstarted work for consolidation, preserve workers,
and advance retained Models UI review alongside runtime implementation.

Behavioral success remains to be observed: compare request-to-integrated-result
time, worker implementation time, review/integration wait, repair turns and total
tokens/cost on real work. Reuse existing trajectories; do not create another
benchmark task or report-only execution loop. Fewer task records alone is not
success, and larger tasks alone do not repair runtime or integration failures.
