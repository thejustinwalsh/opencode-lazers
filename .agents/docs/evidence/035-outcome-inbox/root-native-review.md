# Root native outcome observation

2026-10-31, OpenCode Desktop 2.2.5 / service PID 16786. Actual product-plan
integration exercised the merged coalescer (`a6c5877`, activated with `0c5de84`);
no toy plan, new model run, SQL mutation or manually cancelled inbox input.
Worker artifact `1356ce3` is an ancestor of that reviewed integration; native
observations describe the merged implementation, including its review fixes.

Before: `real-b50-before.json` records the queued owned b50 accepted-v25 message
`msg_fa4727e7b7344416a4f4eef24a1b4384`, outbox
`693890c6451d0b3b2b6f04427b5c2e5db6d106d168c3c71211285930c57160ff`.

After the normal b50 integration command, `real-b50-after-root.json` records:

- That exact queued message is absent. Its durable row remains `superseded`,
  retaining admission history and a `native-cancellation-confirmed` receipt.
- The replacement integrated-v27 message
  `msg_af4d7f6a5e4f4c12b9e760749e1a7a08` is queued, with durable `resume=0`.
- All three unrelated preexisting queued IDs and all prior outbox rows remain.
  The service PID is unchanged. Model consumption stays unknown.

`real-b50-comparison-root.json` records these read-only comparisons. The GUI
remained responsive and showed current task observations during this run. The
fresh merged main check passed 339 tests / 3,214 assertions across 70 files,
plus formatter, lint and strict types. This does not prove every provider/race
path natively; focused fixtures separately cover cancellation and lost replies.
