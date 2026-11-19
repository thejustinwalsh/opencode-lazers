# Task authoring

State the outcome, observable done conditions and necessary boundaries. Give
implementors useful code knowledge without prescribing routine decisions.

```text
Goal:          Observable change and purpose.
Done when:     Required behavior, including material failure cases.
Boundaries:    Relevant write scope, compatibility requirements and exclusions.
Guidance:      Optional reuse points, pitfalls and practices grounded in code.
Verification:  Checks that demonstrate the required behavior.
```

The typed schema maps these to `objective`, `acceptance`,
`writeScope`/`constraints`/`exclusions`, optional `guidance`, and `verification`.
`context` holds useful references. Dependencies and worker selection belong to
the execution plan; runtime owns identities, provenance and execution records.
`requirements.skills` is an optional list of suggestions, preferably written as
`name — one-line description`. Name-only entries remain readable; their
description is unknown rather than inferred. Workers may load a useful native
skill progressively, subject to OpenCode's normal permission check; an absent or
denied suggestion does not block a task. An empty applicable list is sufficient.
Quality checks run formatter and linter automatic fixes before remaining checks.
For LAZERS use `bun run verify` plus relevant behavior tests. Choose test targets
from repository findings and inspect which cases ran. Do not create model repair
turns for mechanically fixable formatting or lint.
Do not fill fields with boilerplate.

## Scope: what may change, where new code goes, what is off limits

A scope keeps agents out of other parts of the code and the work local. It also
states the structure you expect.

```text
writeScope     (edit)       Existing files the worker may modify.
createScope    (create)     New files or folders you expect, each with a purpose.
protectedScope (protected)  Paths the worker must not touch.
```

```json
{
  "writeScope": ["src/runner/runtime.ts", "src/runner/queue/**"],
  "createScope": [
    { "path": "src/runner/queue-limit.ts", "purpose": "the queue limit rule, pure and tested" },
    { "path": "src/runner/queue/", "purpose": "new queue helpers" }
  ],
  "protectedScope": ["src/audit/**"]
}
```

- Scope by module or folder (`dir/**`) when the work is local to a module. Do not
  list a multi-thousand-line file as the only editable file for new behavior:
  name the folder and the new file in `createScope` instead, and keep the large
  file's edit to the call site.
- `createScope` is additive. New files beside an edit-scoped file, in a folder
  under it, or in a `createScope` folder need no decision whether listed or not;
  listing them tells the worker where you want things. Tests and fixtures beside
  or mirroring an edit-scoped source file are in scope.
- `protectedScope` is the only hard boundary. A change there holds the task until
  you decide (`amend-scope` naming the exact path, or cancel).
- A task's `writeScope` and `createScope` are reserved against concurrent work, so
  two tasks that edit or create under the same folder run one after the other.

### Judging a divergence

Any change outside `writeScope`, `createScope` and their sibling allowance is a
divergence. It does not fail the task; checks and the Fallow audit run on the
whole change. You decide it before the task is accepted: when the divergence is the only
thing outstanding the task holds for you (a `scope-divergence` hold) with its repair
unspent, quoting the worker's own stated reason ("no reason given" when it gave none).
When checks or the audit send the work back anyway, the divergence rides in that one
repair: "these changes are outside the task's scope: move/remove them or say why they
are needed".
Ask three questions:

1. Is it the right place architecturally, or should the code live in a new file or
   folder near what it serves?
2. Does it collide with another task? The review lists other tasks whose scope
   covers the file; accepting it into an active task's scope is refused.
3. Is it needed for an acceptance criterion?

Accept with `amend-scope` and a reason (recorded and shown in the acceptance
notice; the verified candidate then continues to acceptance by itself), send it back
with `retained-repair` (artifact, attempt and a reason; uses the one repair), or cancel.

`writeScope` is repository-relative to the assigned LAZERS checkout. It does not
authorize writes in a sibling or other external checkout. When external
implementation is genuinely required, a mandatory task constraint must separately
name the external checkout and the bounded paths within it; that authorization is
distinct from the LAZERS `writeScope`. Context references and advisory guidance do
not grant external write access, and native host permissions still govern every
operation. Do not imply or rely on external writes without that explicit scope.

Every new task must carry one explicit primary classification:

```json
{ "taxonomy": "task-kind/v1", "primaryKind": "feature-implementation" }
```

Choose by the task's objective and acceptance boundary. Use `bug-repair` when
correcting an existing defect; `feature-implementation` for a new capability or
enhancement; `refactoring` when restructuring is the deliverable and behavior is
preserved; `testing` when tests or test infrastructure are the primary outcome;
`documentation` when documentation is the primary outcome; and `maintenance` for
build, CI, dependency, tooling or similar upkeep. A feature or repair does not
become `testing` merely because it adds tests. Persona, touched files and eventual
execution outcome do not determine the kind. The task-kind/v1 catalog requires
exactly one `primaryKind`; do not infer a default.

Historical tasks without a stored classification remain visibly unclassified at
revision 0. After reviewing one, use Architect-only `lz-classify-task` with a
stable requestID and a reason to append an explicit annotation; this leaves the
task specification unchanged. The tools take no revision: the runtime guards each
write with the revision your session last read (`lz-get-task`,
`lz-inspect-task-corrections`) or wrote. A write on an older view, or on a task
you have not read, conflicts and writes nothing; reread, then submit a new
requestID. Exact request replay is safe. Never silently backfill or infer historical kinds.

Artifact evidence references are workspace-relative paths and may name either a
file or a directory. A directory establishes presence only when it contains at
least one readable regular file, at any depth; empty and empty-subdirectory-only
trees do not qualify. Keep the submitted reference verbatim, including any
trailing slash. This checks presence, not file contents or Git tracking.

Architect recognizes task, plan or roadmap scope, researches the requested
outcome, interviews for material unresolved decisions, then creates the tasks
and dependency graph. The scheduler executes
eligible work; Architect returns for decisions, review and integration.

After researching and clarifying user intent, form the plan and choose task
boundaries from its outcomes and dependencies. Check requested outcomes against
existing capabilities; include missing producer/consumer work or linked tasks
instead of excluding an outcome. A feature is the default task;
bugs and refactors follow coherent behavior or responsibility boundaries. Split
for independently useful outcomes, productive parallelism or material risk/context
limits. Group shared context and changing interfaces; each split must earn its
coordination cost. Internal implementation steps and regression cases belong to
the worker, not separate dispatches. Epics and phases remain plans.

Verification checks have a 15-minute inactivity allowance and a 60-minute total
hard backstop by default. Use `inactivityTimeoutMs` and `hardTimeoutMs` only when a
check needs explicit timing; inactivity cannot exceed the hard limit. Project
options `verificationInactivityTimeoutMs` and `verificationHardTimeoutMs` override
defaults. Legacy `timeoutMs` is retained for historical compatibility and does not
govern current execution.

Keep related implementation, fixes and tests with the same worker; revise scope
through existing controls when needed. Verify coherent results rather than every
edit. Focused debugging checks remain useful; repeat broader checks when changes
or unresolved risk justify them. Do not use line counts, file counts or task quotas.

Consolidate requirements by meaning, not by concatenating old specifications.
Acceptance describes required outcomes; verification supplies discriminating
checks. Include only task-specific constraints, useful source findings and advice.
Keep runtime safeguards, coordination history and generic worker instructions in
their existing systems instead of repeating them in each task. Preserve material
requirements even when their implementation is complex. Research and limits:
[LLM work decomposition](../../design/reviews/llm-work-decomposition-research-20261107.md).

Guidance is advice. State mandatory decisions as constraints and explain the
compatibility or product reason. A mini skill is concise, scoped knowledge:
what to reuse, a relevant trap, why it matters, and a source. Inline one-off
findings; link reusable lessons such as [implementation notes](implementation-notes.md).
Use task guidance for concise, relevant code findings tied to source paths, lines
and revisions; include research results only when they affect the task, with an
optional link to deeper material. Generic repository-discovery and skill-loading
advice lives in the shared implementor instructions, not repeated in each task.

Architect self-review through `lz-verify-task` stays. It checks both missing
behavior and unsupported or repeated obligations. It preserves necessary
requirements while removing needless instructions; it is not implementation
approval.

Assign each new task one model-independent persona (`ui`, `systems`, or
`small-refactoring`). Runtime resolves its current task, project or shared model
mapping at dispatch, then falls back to the native implementor configuration.
An explicit user-selected plan `workerModel` overrides that mapping with the exact
`providerID`, model `id`, and optional native `variant`/effort. Running attempts
retain their recorded route. LAZERS forwards selections unchanged; the native
host decides availability. Catalog information informs advice without gating or
rewriting a selection. Missing prices remain unknown. Legacy plans without a
persona retain their behavior.

Grade real work by acceptance correctness, regressions, scope, maintainability
and necessary rework. Retain visible trajectories and failed attempts. Compare
total uncached/cache/output/reasoning usage, time and API-equivalent cost per
accepted result, alongside failures; average cost over successful runs alone
hides expensive failures. Different features do not establish model superiority.
Use matched starting code and external acceptance when making a model comparison.

Research basis: [context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
supports minimal sufficient guidance and focused retrieval;
[SWE-agent](https://arxiv.org/html/2405.15793v3) demonstrates the importance of
usable interfaces and concise feedback; [Agentless](https://arxiv.org/html/2407.01489v2)
supports testing simple localization/repair/validation workflows. These sources
do not establish an optimal Luna task length or prove this plugin's effectiveness.
