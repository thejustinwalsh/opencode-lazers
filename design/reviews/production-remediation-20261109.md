# Production-readiness remediation

Owner: Codex, under Justin's 2026-11-09 remediation instructions. Execute the
ordered waves from the external review; preserve the existing roadmap and worker
work. The independent review is not copied into this repository. Its location:

`/private/tmp/claude-501/-Users-tjw--claude-spares-spare-K0mQ5r/3d9ed59a-5d6f-4605-9d61-499d6be08b8c/scratchpad/lazers-production-readiness-review-20261109.md`

Read findings by symbol against current source. One finding per code commit;
automatic formatting/lint, typecheck and relevant behavior tests gate each commit.
The eleven reconciliation answers require Justin's recorded decisions before
dependent fixes. No question's default selection establishes an answer.

## Pre-edit baseline

Both full suites ran before repository edits, at clean HEAD
`a20c41ab858b44670c3c031eb40ee4cec08b1a23`. HEAD and working tree were unchanged
through both runs. The native cleanup worker continued in its separate checkout;
Architect confirmed an integration/activation hold.

| Run | Started, Unix ms | Finished, Unix ms | Result                      | Duration |
| --- | ---------------: | ----------------: | --------------------------- | -------: |
| 1   |    1794242015331 |     1794242459006 | 1,733 pass / 4 fail; exit 1 | 443.58 s |
| 2   |    1794242459050 |     1794242872428 | 1,733 pass / 4 fail; exit 1 | 413.30 s |

Each run covered 1,737 tests across 179 files, with 19,316 assertions. Both had
the same four named failures, also matching the review's second-run failure set:

- `src/trajectory/read.test.ts`: trajectory presents commentary separately from
  automatic worker facts without granting authority.
- `test/current-idle-hook/replacement-verification.test.ts`: replacement idle
  callback reaches normal verification only for zero background.
- `test/trajectory-panel/panel-state.test.ts`: live status and progress do not
  cancel page-size-two history or rewrite its event selection.
- `test/trajectory-panel/live-delivery.test.ts`: native status deltas preserve
  mutable tool progress, retry delivery and scoped full recovery.

Complete logs and machine-readable timestamps/source boundaries remain in
`/private/tmp/lazers-remediation-baseline-20261109/run-{1,2}.{log,json}`.
Their raw failure arrays repeat Bun's end-of-run summary; the distinct set is
the four cases above. These are pre-existing failures, not permission to ignore
new failures or to assume later failures are timing noise.

## Existing S15-1 cleanup receipt

Justin supplied the completed native CLI receipt `{"status":"cleaned"}` for
the owned verification root ending `lazers-full-instance-9TcU4T`, with 282 MB
reclaimed. Codex did not rerun the cleanup. Read-only confirmation found no PID
25100, no listener on port 53408, and zero entries in the verification root.
This establishes the manual cleanup, not S15-1 closure: the reaper is still open.
The separate retained-verification workspace cleanup finding remains open too.

## Reconciliation register

All eleven questions were presented through native structured question prompts.
All are pending at this record; no dependent decision has been inferred.

| #   | Fact to reconcile                                                          | State                                                                        |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Active/terminal semantics across plans, nodes, attempts and resources      | Pending Justin                                                               |
| 2   | Canonical cost, unmetered charges, exact money and token basis             | Pending Justin; blocks S9/S10 money changes                                  |
| 3   | Assigned worker input versus reconciled review-input alias                 | Pending Justin                                                               |
| 4   | Durable current authority versus frozen launch parentage                   | Pending Justin                                                               |
| 5   | Commentary identity versus automatic tool-fact identity                    | Pending Justin                                                               |
| 6   | Four-state versus three-state native inventory completeness                | Pending Justin                                                               |
| 7   | Packaged defaults versus user agent permissions/request settings           | Pending Justin                                                               |
| 8   | Cleanup of clean, merged, unreserved work with absent/unknown old sessions | Pending Justin; native cleanup integration held                              |
| 9   | Shared sanitized panel errors versus universal trajectory redaction        | Pending Justin; blocks F-S14-1                                               |
| 10  | Canonical divider range, step and arrow semantics                          | Pending Justin; review's final arrow wording contradicts earlier description |
| 11  | XState snapshot authority versus runtime/store lifecycle                   | Pending Justin                                                               |

## Wave 1: S1-1

Re-located `beginSourceGuard()` and reproduced the defect against the real module:
A installed/matching; B begins; B disposes; A remained uninstalled/nonmatching.
`dispose()` now selects the most recent installed surviving registration when
disposing the current one. Pending replacements still fence older scopes; the
last pending survivor can finish installing, and empty registrations are removed.
The real-module probe after the fix returned installed/matching before B,
uninstalled/nonmatching during B, and installed/matching again after B disposed.

Added the exact failed-load sequence and newest-survivor/idempotent-disposal
behavior tests. Re-derived an additional defect assertion not listed in the
review's six-test table: `source-fence-rpc.test.ts` expected both replacement
disposal and full plugin early setup failure to leave the surviving guard
disabled. Those expectations now assert restoration, with S1-1 comments.

Checks: `bun run verify` passed, including automatic formatting/lint and strict
typecheck. `bun test src/runner/source-quarantine.test.ts
src/runner/source-fence-rpc.test.ts`: 8 pass / 0 fail, 51 assertions.
The full suite has not been rerun after this increment. Wave 1 remains open
until F-S14-1 is resolved; installed service behavior has not been reloaded.

## Re-derived findings and coordination

- S6-4/F-S4-9's absent handoff-tool premise no longer matches HEAD:
  `registerRecoveryTools()` is called in `src/index.ts`, and
  `src/recovery/tools.ts` registers both handoff tools using `HandoffReviewer`.
  Preserve that implementation. Full native handoff walkthrough remains unproven.
- Desktop coordination request `msg_1c1280bb7001cnwncleorM5hPC`
  (Unix1794241989636) preserved LZ-185's SAME worker while holding source
  integration/activation and overlapping dispatch. Architect confirmed the hold
  in `msg_1c128cd09001gM8Zbnk6Z45AK6`. This is user-directed driver coordination,
  not autonomous recovery. Keep the hold until the ordered remediation and
  relevant reconciliation allow integration.
