# Adversarial review

All **37/37 units reviewed**. **24 findings: 4 blocker, 12 major, 8 minor, 0 nit.** “Reviewed” means the diff and relevant surrounding paths were inspected, not exhaustive verification; each report states its limits.

Starting baseline: `bf59cc89ab23a47cc55390985c84885d2eec2c5a` on `main`. Final reference check: `f6b17cd34998d29715795b3194a5f628c127ff6c`. Main advanced independently during the review; later context-stub and website-fit changes were checked for effects on findings. Units remain the exact ranges in `UNITS.txt`, not the intervening newer commits. Locations refer to current main at the final check unless a historical location is expressly identified.

Static tracing unless a report records execution. No source edits, commits, branch changes, formatters/fixers, delegation, servers, live database access, or `lz-*` tools. All review-authored files and reproduction artifacts are under this directory.

Counts: blocker / major / minor / nit. Pending counts are not findings.

| SHA      | Topic                                                        | Status   | B / M / m / n |
| -------- | ------------------------------------------------------------ | -------- | ------------- |
| 5cf4baa2 | [complexity-pass](5cf4baa2-complexity-pass.md)               | reviewed | 0 / 0 / 0 / 0 |
| 79d81fe6 | [complexity-pass-2](79d81fe6-complexity-pass-2.md)           | reviewed | 0 / 0 / 0 / 0 |
| 94811653 | [removed-mockups](94811653-removed-mockups.md)               | reviewed | 0 / 0 / 0 / 0 |
| 32a982bc | [detail-screenshots](32a982bc-detail-screenshots.md)         | reviewed | 0 / 0 / 0 / 0 |
| a93c3e40 | [json-byte-visitor](a93c3e40-json-byte-visitor.md)           | reviewed | 0 / 0 / 0 / 0 |
| 437f56ea | [fallow-wasm-threads](437f56ea-fallow-wasm-threads.md)       | reviewed | 0 / 0 / 0 / 0 |
| f51cf0d1 | [assignment-reconnect](f51cf0d1-assignment-reconnect.md)     | reviewed | 0 / 0 / 0 / 0 |
| ee0203de | [radar-flow-pulses](ee0203de-radar-flow-pulses.md)           | reviewed | 0 / 0 / 0 / 0 |
| c20db866 | [radar-flow-animation](c20db866-radar-flow-animation.md)     | reviewed | 0 / 0 / 1 / 0 |
| 3bb090ac | [fallow-memory](3bb090ac-fallow-memory.md)                   | reviewed | 1 / 0 / 0 / 0 |
| 9261988a | [terminate-probe](9261988a-terminate-probe.md)               | reviewed | 0 / 0 / 1 / 0 |
| 70a0f10e | [radar-flow-animation-2](70a0f10e-radar-flow-animation-2.md) | reviewed | 0 / 0 / 1 / 0 |
| a41cf93a | [retained-repair-routes](a41cf93a-retained-repair-routes.md) | reviewed | 0 / 0 / 0 / 0 |
| 93bb4046 | [recovery-bundle](93bb4046-recovery-bundle.md)               | reviewed | 0 / 1 / 0 / 0 |
| 42c5ff4a | [fallow-audit-review](42c5ff4a-fallow-audit-review.md)       | reviewed | 0 / 1 / 0 / 0 |
| 8d153eaf | [website-copy](8d153eaf-website-copy.md)                     | reviewed | 0 / 0 / 1 / 0 |
| 581cf7e8 | [fallow-suppression](581cf7e8-fallow-suppression.md)         | reviewed | 0 / 0 / 1 / 0 |
| 8c276019 | [scope-divergence](8c276019-scope-divergence.md)             | reviewed | 0 / 0 / 1 / 0 |
| 84e85b0f | [task-churn](84e85b0f-task-churn.md)                         | reviewed | 1 / 1 / 0 / 0 |
| 7abe4acd | [slim-takeover](7abe4acd-slim-takeover.md)                   | reviewed | 0 / 2 / 0 / 0 |
| 47f2ffb0 | [trajectory-history](47f2ffb0-trajectory-history.md)         | reviewed | 0 / 0 / 0 / 0 |
| 91b29dd4 | [multi-project-design](91b29dd4-multi-project-design.md)     | reviewed | 0 / 0 / 0 / 0 |
| 95fc4327 | [project-pause](95fc4327-project-pause.md)                   | reviewed | 0 / 0 / 0 / 0 |
| 1add0595 | [project-codes](1add0595-project-codes.md)                   | reviewed | 0 / 1 / 0 / 0 |
| 9b057818 | [takeover-resubmit](9b057818-takeover-resubmit.md)           | reviewed | 0 / 0 / 0 / 0 |
| 49f6a84a | [projects-settings](49f6a84a-projects-settings.md)           | reviewed | 0 / 1 / 0 / 0 |
| 81b1d6ba | [retention-purge](81b1d6ba-retention-purge.md)               | reviewed | 2 / 1 / 0 / 0 |
| d93f6681 | [ledger-paging](d93f6681-ledger-paging.md)                   | reviewed | 0 / 1 / 0 / 0 |
| 8a10ed88 | [timeline-zoom](8a10ed88-timeline-zoom.md)                   | reviewed | 0 / 0 / 1 / 0 |
| 38534dad | [website-native-scroll](38534dad-website-native-scroll.md)   | reviewed | 0 / 0 / 0 / 0 |
| e978094a | [research](e978094a-research.md)                             | reviewed | 0 / 0 / 0 / 0 |
| 9337fab3 | [submission-lock-race](9337fab3-submission-lock-race.md)     | reviewed | 0 / 0 / 0 / 0 |
| a963208e | [all-projects-reads](a963208e-all-projects-reads.md)         | reviewed | 0 / 1 / 0 / 0 |
| e21a3734 | [guidance-on-demand](e21a3734-guidance-on-demand.md)         | reviewed | 0 / 0 / 0 / 0 |
| d34968b0 | [mock-model-research](d34968b0-mock-model-research.md)       | reviewed | 0 / 0 / 0 / 0 |
| 2ddad907 | [runntime-decisions](2ddad907-runntime-decisions.md)         | reviewed | 0 / 0 / 0 / 0 |
| aa3c498c | [website-panel-demos](aa3c498c-website-panel-demos.md)       | reviewed | 0 / 2 / 1 / 0 |

## Verification and limits

Six focused files ran: **29 tests passed, 0 failed, 141 assertions**. No full suite or build ran.

| Command (`bun test …`)                                                    | Result                          |
| ------------------------------------------------------------------------- | ------------------------------- |
| `test/trajectory-panel/viewport.test.ts`                                  | 7 pass / 31 assertions / 43 ms  |
| `src/trajectory/history.test.ts`                                          | 7 pass / 43 assertions / 44 ms  |
| `src/radar/pulse-loop.test.ts`                                            | 7 pass / 47 assertions / 311 ms |
| `src/runner/check-settlement.test.ts`                                     | 4 pass / 10 assertions / 309 ms |
| `./.agents/reviews/2026-11-20-sol/cache-symlink-reproduction.test.ts`     | 1 pass / 3 assertions / 159 ms  |
| `./.agents/reviews/2026-11-20-sol/review-invariants-reproduction.test.ts` | 3 pass / 7 assertions / 114 ms  |

The last two files deliberately assert the **observed defects**, not the desired fixed behaviour. They reproduce the cache overwrite, observer assertion gap, wrong suppression disposition and duplicate suppression IDs. The first cache command omitted `./` and matched no files; the corrected explicit-path command above ran successfully. Cache artifacts are retained in `cache-reproduction-kuFNFY/`.

Most findings are confirmed static traces, not executed races. No live database, runtime worktree fixtures, fixer-invoking tests, native Desktop walkthrough, server, WASM rebuild, broad parity run or large-volume benchmark was used. The two large refactors received static path comparison, not an exhaustive interleaving/equivalence proof. External research citations were checked for internal consistency, not independently re-researched.

## Ten findings to fix first

1. **[3bb090ac-1 — blocker](3bb090ac-fallow-memory.md): cache publication follows a `.gitignore` symlink and overwrites unrelated data.** Reproduced. Make host-side writes symlink-safe; protect existing user files.
2. **[81b1d6ba-1 — blocker](81b1d6ba-retention-purge.md): batch deletes reuse stale plan eligibility.** Revalidate terminal state and reader protections inside each delete transaction.
3. **[81b1d6ba-2 — blocker](81b1d6ba-retention-purge.md): worktree deletion bypasses live-idle checks and final revalidation.** Reuse the ordinary cleanup safety path immediately before native removal.
4. **[84e85b0f-1 — blocker](84e85b0f-task-churn.md): claimed takeover notice can strand a busy worker after restart.** Make the persisted claim recover into the bounded handoff/deadline path.
5. **[7abe4acd-2 — major](7abe4acd-slim-takeover.md): stale transition payload loses an acknowledged handoff.** Merge the current persisted payload transactionally, not the pre-await snapshot.
6. **[a963208e-1 — major](a963208e-all-projects-reads.md): combined Needs you silently omits other projects' questions.** Route through loaded providers and include sessions without plans.
7. **[1add0595-1 — major](1add0595-project-codes.md): successful code edits can violate read schemas.** Align mutation, persisted identity and all-project/task-reference contracts.
8. **[d93f6681-1 — major](d93f6681-ledger-paging.md): page requests eagerly materialize all retained history.** Bound source work by the requested page, without restoring refusal/truncation ceilings.
9. **[93bb4046-1 — major](93bb4046-recovery-bundle.md): recovery notice hides items beyond 60 with no working continuation.** Make every pending item retrievable from the delivered notice.
10. **[49f6a84a-1 — major](49f6a84a-projects-settings.md): polling remounts editable settings rows.** Reconcile by stable project key and preserve focus/drafts during reads and saves.

## Cross-cutting problems

- **State-machine graphs do not cover payload-dependent liveness or lost updates.** Takeover's state is machine-defined, but a claim flag can prevent its exit and stale payload merges can erase acknowledged data. Restart tests must exercise intermediate persisted flags and awaited-call interleavings, not just state reachability.
- **Safety is reimplemented at subsystem boundaries.** Retention has its own reduced worktree cleanup path; host-side cache copying sits outside WASI's confinement. Reuse the full safety boundary, including idle/ownership checks and symlink resistance, rather than copying only some predicates.
- **No-truncation policy lacks end-to-end paging.** Handoffs silently slice text; recovery text lists 60; ledger ceiling removal turns into unbounded eager capture. Preserving database rows is not sufficient when the consumer cannot retrieve them safely.
- **Identity is inconsistent across layers.** Project codes pass writes but fail reads; live row object identity replaces stable project identity; supplemental audit IDs collapse separate comments and corrupt repair dispositions. Test identities through write, read, refresh and comparison.
- **Tests do not always establish the premise they claim to verify.** An observer array is checked before delivery; elapsed milliseconds stand in for proof that helpers started; mocked private-helper ordering is not persisted lifecycle evidence. Add positive controls, explicit readiness handshakes and observable end-state assertions.
- **Owner-facing completeness/guarantees exceed implementation.** All-projects questions are incomplete, expanded timeline selection cannot reach its external inspector, and website copy describes advisory Fallow findings as mandatory passing gates. Exercise the actual owner interaction and document incomplete coverage explicitly.
