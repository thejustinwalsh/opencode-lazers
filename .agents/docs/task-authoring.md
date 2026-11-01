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
Do not fill fields with boilerplate.

Artifact evidence references are workspace-relative paths and may name either a
file or a directory. A directory establishes presence only when it contains at
least one readable regular file, at any depth; empty and empty-subdirectory-only
trees do not qualify. Keep the submitted reference verbatim, including any
trailing slash. This checks presence, not file contents or Git tracking.

Architect recognizes task, plan or roadmap scope, researches the requested
outcome, interviews for material unresolved decisions, then creates the tasks
and dependency graph. The scheduler executes
eligible work; Architect returns for decisions, review and integration.

Epics, milestones and phases belong in plans. A task is one small, coherent
implementation outcome with its own done conditions and verification. Split
independently deliverable outcomes; keep tightly coupled changes together. A
long specification is a signal to check for several outcomes, not a reason to
trim away necessary context. Plans carry dependencies, integration order and
combined feature acceptance; avoid splitting by file count or arbitrary quotas.

Guidance is advice. State mandatory decisions as constraints and explain the
compatibility or product reason. A mini skill is concise, scoped knowledge:
what to reuse, a relevant trap, why it matters, and a source. Inline one-off
findings; link reusable lessons such as [implementation notes](implementation-notes.md).
Use task guidance for concise, relevant code findings tied to source paths, lines
and revisions; include research results only when they affect the task, with an
optional link to deeper material. Generic repository-discovery and skill-loading
advice lives in the shared implementor instructions, not repeated in each task.

Architect self-review through `lazers_verify_task` stays. It checks both missing
behavior and unsupported or repeated obligations. It preserves necessary
requirements while removing needless instructions; it is not implementation
approval.

Use an explicit user-selected native implementor route through plan `workerModel`
with the exact `providerID`, model `id`, and optional native `variant`/effort.
Otherwise omit it and inherit the native implementor configuration. LAZERS passes
an explicit route to the native session API unchanged; the host either creates
that route or returns its error. Live catalog prices, variants, and capability
metadata inform advice but do not gate or rewrite a selection. Missing prices
remain unknown. Each plan node may independently name at most one
model-independent persona (`ui`, `systems`, or `small-refactoring`); do not map
personas to models. Plans without a route or persona retain their behavior.

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
