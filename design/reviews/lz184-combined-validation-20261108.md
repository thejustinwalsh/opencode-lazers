# LZ-184 recovered composition validation

Recovered native sibling checkout: `opencode-lazers.worktrees/lz184-review-recovered`.
Composition HEAD: `24969cee8382e7ec5c0293cacae417cb3e01c3da`.

On 2026-11-08, `bun run verify` and `bun run build:gui` passed. Broader behavior
coverage found **218 passing / 6 failing tests**, 2,581 assertions across 31 files
in 28.88 seconds. This candidate is not accepted or activated.

Command:

```sh
bun test src/progress src/observability src/radar src/runner/scheduler-coordinator.test.ts test/radar test/observation-panels/radar-agent-monitor.test.ts test/observation-panels/root.test.ts
```

Logs remain in the durable checkout under `.cache/review/{quality,build,tests}.log`.

Failures:

- `src/observability/read.test.ts:479`: live tool completion still has succeeded
  status but no longer returns the expected `result: "finished safely"`. Determine
  whether metadata-only recording intentionally changes this contract; preserve
  required trajectory behavior without introducing raw tool bodies into Radar.
- Five `src/observability/rpc.test.ts` failures at lines 890, 1614, 1860, 1974
  and 2419: nativeSessionReads/session counts increased, including `ses-owner`
  in inventories. The candidate intentionally includes the exact current native
  Architect, but existing bounded-read/inventory tests were not reconciled with
  that feature. Check authorization, scope and read budgets before updating
  expectations; do not simply delete assertions.

The source review is running through native Luna Max. Both the original Tasks
attempt and current Radar attempt were confirmed running through native
`session.active` at Unix 1794152923710. Root is not creating another implementation
attempt. Relay these failures to the existing Radar worker through Architect.

Computer Use explicitly reported macOS locked when Root attempted the follow-up;
user unlock is pending. This report preserves the actionable result meanwhile.

## Current Radar correction and baseline comparison

The current runtime-owned worker completed `c983c0a` (session-scoped truncation
coverage) with 181 focused tests and its quality/build checks reported passing.
Root merged it into the durable review composition, now HEAD
`8360cbd43f58aff42810045cf434ca081e9f73ce`.

Root's actual `bun run verify` passes there. Running
`bun test src/observability/changes.test.ts src/observability/read.test.ts src/observability/rpc.test.ts`
yields **38 pass / 6 fail**, 355 assertions, 5.36 seconds. The same six failures
remain. Logs: `.cache/review/c983-{quality,behavior}.log` in that checkout.

Control on canonical Main (`594f831`):
`bun test src/observability/read.test.ts src/observability/rpc.test.ts` passes
**36 tests / 420 assertions**, 5.09 seconds. Thus these contract differences are
introduced by the candidate, not a pre-existing failing Main baseline. Decide
behavior and update implementation/tests together rather than waive failures.

Native Luna Max source reviewer `ses_e4427a3dbffeOyojjAt0iCyOmw` finished its
review of8919a20 without finding a material defect in the inspected scheduler,
Architect-flow and file-target paths. It identified missing over-limit cases for
output-path and total-output byte caps. It explicitly distinguished mocked
registered-panel coverage from actual Desktop subscription wiring. It did not
rerun checks and did not inspect the laterc983c0a correction. Its review therefore
does not override the observed six broader test failures or live acceptance work.

Current worker reports the connected Desktop/Terra walkthrough remains unperformed.
Computer Use remains explicitly locked; Root's follow-up is awaiting unlock.
