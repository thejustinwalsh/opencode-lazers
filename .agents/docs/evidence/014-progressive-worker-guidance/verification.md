# Spike 014 focused evidence

## Focused behavior suite

Command:

```sh
bun test src/runner src/task.test.ts src/tasks src/tools.test.ts src/architect.test.ts test/runner
```

Result: 53 tests passed, 0 failed, 638 expectations. The suite covers
nonblocking absent/missing/denied skill suggestions, body-free fresh/retry/
resume/repair handoffs, preservation of seeded historical attempt policies,
targeted removal of the old LAZERS instruction entry with unrelated entries
preserved across repeated prompts, optional skill rendering with legacy labels,
policy-reference omission and legacy reads, omission of obsolete readable-task
footer commentary, and preservation of task-specific constraints.

Full command `bun test`: 142 tests passed, 0 failed, 1,185 expectations.

## Quality boundary

`bun run verify` reports that all 196 files are formatted and lint is clean in
109 files. Its final `bun check` reports exactly two type errors caused by the
newly optional legacy policy reference: `src/tasks/panel.tsx:651` passes
`string | undefined` to `Ui.Markdown.text`, and `src/trajectory/read.ts:138`
passes it to `safeText`. The narrow follow-through is to conditionally render
the panel reference and conditionally include the sanitized trajectory field.
These readers are outside the assigned write scope and remain for Architect;
no other type errors were reported.

The unit adapter test verifies the cleanup call targets only
`lazers-required-skills`; it is not evidence of a live OpenCode Desktop session.
No model call, comparative run, or effectiveness claim is included.

## Architect compatibility review

After both scoped worker attempts stopped, the two reserved readers were fixed:
the panel conditionally renders an existing reference, and the trajectory
projection conditionally includes its sanitized legacy field. A regression
constructs records both with and without the field, verifies the projection,
and confirms that reading does not change either stored record.

`bun fmt --check && bun lint && bun check && bun test` passed: 196 formatted
files, no lint problems in 109 files, no type errors in 104 files, and 143 tests
with 1,190 expectations. The earlier failed runtime attempts remain recorded;
these checks do not replace runtime re-verification or claim Desktop UI coverage.

## Assigned-baseline re-verification

On baseline `5b41706d4d0fc03c05d35106c36bd96a8fe78ce5`, the focused command passed
53 tests with 638 expectations, `bun test` passed 143 tests with 1,190
expectations, and `bun run verify` passed formatting (196 files), lint (109
files), and typechecking (104 files). These checks cover the combined artifact;
they are not a live Desktop session or a model experiment.
