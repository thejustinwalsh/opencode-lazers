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
