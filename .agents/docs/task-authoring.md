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
An empty applicable list is sufficient. Do not fill fields with boilerplate.

Long specifications warrant checking whether distinct outcomes should be tasks
or whether the feature needs an explicit complex contract. Split by verifiable
outcomes and dependencies, not file count. Preserve combined feature acceptance.

Guidance is advice. State mandatory decisions as constraints and explain the
compatibility or product reason. A mini skill is concise, scoped knowledge:
what to reuse, a relevant trap, why it matters, and a source. Inline one-off
findings; link reusable lessons such as [implementation notes](implementation-notes.md).
Required native skills remain explicit dependencies and their content is attached
through a stable OpenCode session instruction entry before the worker prompt.
Repeated attachment replaces that entry instead of appending another task blob.

Architect self-review through `lazers_verify_task` stays. It checks both missing
behavior and unsupported or repeated obligations. It must preserve necessary
requirements while removing needless instructions. No word-count approval gate.

Use the explicitly selected implementor model through plan `workerModel`; for
current dogfood this is `openai/gpt-6-luna`, variant `max`. Architect can use its
own stronger model. Old plans without a selection retain owner inheritance.

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
