# Native outcome inbox observation

**Status: Root native observation passed for the reviewed merged repair.**
Worker artifact `1356ce3` is an ancestor of `a6c5877` / `0c5de84`; this is not a
claim that pristine `1356ce3` includes its later owner-transfer and partial-review
repairs. Exact source and evidence boundaries are recorded in
[Root's native review](root-native-review.md).

## Original pre-activation observation (retained history)

On 2026-10-31, read-only `Service.discover({ version: "2.2.5" })` found the
authenticated local OpenCode 2.2.5 service; `server.info` reported PID 16786. The
task's Architect owner was still busy. The coalescing artifact in this worktree
was not loaded in that host, so its inbox behavior could not be tied to this
change.
No native messages were enqueued or cancelled and no user inbox input was
changed.

After the exact artifact is loaded in the pinned host, Architect must record the
actual old/current inbox IDs, types, delivery states, and matching durable
outbox IDs/receipts here. Confirm that only the owned same-plan queued synthetic
was cancelled, the newest outcome remains current, unrelated inputs remain, and
the obsolete outcome row/history is retained. Until that observation is added,
native wake suppression remains unverified.

## Actual product-plan observation and decision

Root approved the real b50 integration observation on 2026-10-31. Before-state
`real-b50-before.json` records owned queued synthetic accepted-v25 inbox ID
`msg_fa4727e7b7344416a4f4eef24a1b4384`, outbox ID
`693890c6451d0b3b2b6f04427b5c2e5db6d106d168c3c71211285930c57160ff`.
After normal integration, that exact native queued input is absent, while its
durable row and admission history remain `superseded` with
`native-cancellation-confirmed`. The replacing outbox is
`ae18dd6aea88b580c994ab98274d57572894e3dca0dad01378cff18e14025d7d`;
integrated-v27 inbox ID `msg_af4d7f6a5e4f4c12b9e760749e1a7a08` is queued with
`resume=0`. All three unrelated queued IDs and every prior outbox row are retained;
PID `16786` is unchanged. Consumption remains unknown.

Root's read-only native snapshots/comparison are `real-b50-after-root.json` and
`real-b50-comparison-root.json`; driver observation and registered runtime receipts
are `real-b50-after.json` and `real-b50-runtime-proof.json`. This used real product
integration, not a toy task, SQL mutation or manual inbox cancellation.
Root also records 339 passing tests / 3,214 assertions across 70 files and passing
formatter, lint and strict types on fresh merged main. Fixtures separately cover
owner replacement, cancellation races and process death; they are not this native
suppression proof.
