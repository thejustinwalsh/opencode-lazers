# Spike 014 — progressive worker guidance

## Question and increment

Can optional skill suggestions and shared source discovery reduce repeated worker
instructions without making skills or repository tutorials prerequisites for each
task?

The starting code resolved `requirements.skills` during admission and dispatch
(`src/runner/runtime.ts`, starting lines 54–63 and 296–304 / 540–543), copied
`Skill.Info.content` through the host adapter, and injected it through the
`lazers-required-skills` session instruction entry (`src/runner/native.ts`,
starting lines 101–123 and 162–170). Readable tasks labeled the suggestions
“Required skills” and appended a generic risk/policy footer
(`src/tasks/instructions.ts`, starting lines 34–36). The shared implementor role
did not carry the repository index/focused-read workflow.

## Change

- Admission and dispatch ignore optional skill availability/permission; new
  attempt contexts carry task strings only. Retry, resume and repair do not
  inject old policy skill payloads into prompts or rewrite stored task/policy
  records.
- The native adapter performs no skill catalog read or body injection. Before a
  supported worker prompt it removes only the old `lazers-required-skills`
  instruction entry; other native entries remain untouched.
- The shared implementor instructions now describe LAZERS index/focused reads
  and progressive, permission-checked native skill use. Task-specific guidance
  stays concise and source-grounded.
- Task skill strings remain compatible. New entries may use
  `name — one-line description`; name-only legacy entries render with an honest
  unavailable-description label. `policyReference` is optional for new input,
  old values still parse, and readable instructions omit generic risk/policy
  commentary while preserving task-specific constraints.

Current source: `src/runner/runtime.ts:496–581`, `src/runner/native.ts:125–147`,
`src/task.ts:56–67`, `src/tasks/instructions.ts:10–48`,
`src/implementor.md:1–5`, and `.agents/docs/task-authoring.md:14–37`.

## Evidence and boundary

Behavior coverage and exact command results are recorded in
[`verification.md`](../evidence/014-progressive-worker-guidance/verification.md).
No live-model comparison or model-quality experiment was run. The native entry
cleanup is exercised with a focused adapter test double, not a Desktop session.

The optional `policyReference` type has two narrow out-of-scope consumers still
requiring follow-through: `src/tasks/panel.tsx:651` should render the Markdown
only when a reference exists, and `src/trajectory/read.ts:138` should conditionally
include the sanitized `policyReference` in its projection so old values survive
and absent values remain absent. The current `bun check` output identifies only
those two compatibility errors; both files remain unchanged per the assigned
write scope.
