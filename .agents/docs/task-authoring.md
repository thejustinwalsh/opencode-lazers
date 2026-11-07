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
For LAZERS use `bun run verify` plus relevant behavior tests. Do not create
model repair turns for mechanically fixable formatting or lint.
Do not fill fields with boilerplate.

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
revision 0. After reviewing one, use Architect-only `lz-classify-task` with its
current classification revision, a stable requestID and a reason to append an
explicit annotation; this leaves the task specification unchanged. Corrections
use the latest classification revision and append another annotation. Exact
request replay is safe; a stale revision conflicts and requires rereading before
submitting a new request. Never silently backfill or infer historical kinds.

Artifact evidence references are workspace-relative paths and may name either a
file or a directory. A directory establishes presence only when it contains at
least one readable regular file, at any depth; empty and empty-subdirectory-only
trees do not qualify. Keep the submitted reference verbatim, including any
trailing slash. This checks presence, not file contents or Git tracking.

Architect recognizes task, plan or roadmap scope, researches the requested
outcome, interviews for material unresolved decisions, then creates the tasks
and dependency graph. The scheduler executes
eligible work; Architect returns for decisions, review and integration.

Epics, milestones and phases belong in plans. Plan around features: a feature is
the default task, including related implementation, fixes and verification. Split
a feature only when delivery benefits. Bugs and refactors follow coherent behavior
or responsibility boundaries. Split when
outcomes can ship independently or separate workers provide useful parallelism,
not merely because changes can be tested separately. Each boundary must earn its
research, dispatch, review and integration overhead. A long specification prompts
a check for separate outcomes, not automatic subdivision. Plans carry dependencies,
integration order and combined acceptance; line count and quotas do not size tasks.
Default to one worker for a coherent request. Keep discoveries and routine repairs
with that worker; revise scope through existing controls when needed. Verify at
meaningful completion boundaries, not after every edit. Focused debugging checks
remain useful; repeat broader checks when changes or unresolved risk justify them.
Split for a material risk
or context boundary when retaining one task would make reliable completion harder.

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
