# Runner runtime maintenance

`TaskRuntime` owns the scheduler tick and command admission. The runner modules
below own execution for their respective workflows. They receive the store,
host, and callbacks needed to use the existing lease, lifecycle transitions,
and outcome records.

| Module                               | Responsibility                                                         |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `retained-verification-execution.ts` | Retained candidate checks, isolated workspaces, acceptance and cleanup |
| `adoption-execution.ts`              | Descendant adoption, candidate workspaces and checks                   |
| `worktree-cleanup.ts`                | Quiescence, ownership, removal and cleanup retries                     |
| `outcome-delivery.ts`                | Native inbox observation, delivery, replacement and ownership transfer |

Use the bundled Fallow dependency or `lz-fallow-report` before and after
refactoring. Compare duplication across all touched modules so moving a clone
does not count as removing it. Read the cited callers before removing
dead-code findings, especially native registrations and recovery paths.
Run `bun run verify` and the affected runner behavior tests.

The first split consolidated five copies of the retained-verification generation
and state check and two paths that record the same setup cleanup failure. Fallow 3.41.0 reported 41 clone groups touching the original
runtime and 33 touching the runtime plus all extracted modules after the split.
The health report still flags `TaskRuntime.command` as the largest remaining
complexity hotspot. Use its existing command families to guide further extraction
and preserve the common version check and transaction when moving handlers.
