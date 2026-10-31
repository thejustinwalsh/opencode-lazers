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
