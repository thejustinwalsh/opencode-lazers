# Reviewed Models UI source integration

Main advanced from `e404a2c2ec204ea73d33b247d69cdf9510ab7f09` to exact reviewed artifact **`eb972cf27c15a6ef7c3320b616bd0224ca85ed10`** by ordinary fast-forward. Real merge ancestry preserves Main's LZ-89 accounting repair and both UI repair lanes. No source was replayed, no defect history was rewritten, and no push or native activation was performed.

## Preserved review and repair lineage

- Original LZ-84 `764db02cdce3c9688a8092853dc4be51ebd55018` had six reviewed state/panel defects plus missing registered-panel coverage and undisplayed variant omission coverage. Its original artifact and findings remain preserved.
- LZ-90 `e3a928a72da8485a4ff9d68647208b95e9440969` repaired project-generation pagination fencing, stale successful task/effort/settings refresh and selection revision. Review found a remaining task-list completion ordering that aborted a newer selection's pending reads.
- LZ-92 `70841f352c9e58a3ab6ce4aed4fe264ea7ab5694` independently cleared that edge: compatible pending detail/effort reads coalesce without aborting the original signal. Both settlement orderings, explicit refresh, reconnect and cancellation passed. Architect and reviewer each passed 53 Models tests / 756 assertions plus quality checks. Its two state paths remain byte-identical in final Main.
- LZ-91 `c96c3a16efa71307857018c7921c58effb71d9bc` repaired tab fallback, panel-container responsiveness and variant omission display. Review established the genuine `gui.setup → contributed Panel.render → ModelPanel` DOM chain, but found two remaining blockers: stale location reuse on reopen and split constraints contradicting CSS at short heights.
- Ordinary review assembly `8b328ba325c0a2297676abb79a0b36e448db850a` combined prior Main, LZ-91 and LZ-92. Architect checks exposed the registered hide/reopen failure: 161 passed / 1 failed, 1,706 assertions. Independent isolated tracing found premature location-bound RPCs, an aborted connection and duplicate refresh/comparison calls. Quality/build passing did not exonerate it.
- LZ-93 `eb972cf27c15a6ef7c3320b616bd0224ca85ed10` changed only panel TSX, panel CSS and the registered root test. Current lookup identity now gates location readiness; fixed track minima no longer contradict the split control. Original reviewer cleared both blockers with 20 tests / 442 assertions plus quality checks. Deferred location, old response rejection, short/tall panel bindings and cumulative pointer movement are tested without longer waits or relaxed counts.

The final candidate retains LZ-89 accounting/read files byte-for-byte. Architect checks on both exact LZ-93 and Main passed **162 tests / 1,866 assertions**, formatter, lint, strict types, diff checks and GUI build. Main was clean after verification. GUI build retained deprecation/ORT CJS `import.meta` warnings; it exited successfully.

## Exact runtime source records

| Plan                                            | Task source landing                                         | Combined source integration                      | Native cleanup result                                         |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| LZ-93 `bf37ca92-e165-456b-8903-0aa256d85019`    | v15, exact `eb972cf`                                        | v16                                              | cleanup-blocked v17; 9 effects complete, 1 uncertain removal  |
| LZ-92 `7a3bea3f-0c7e-4f3f-ae7b-970e343cc177`    | v10, exact `70841f3`                                        | v11                                              | cleanup-blocked v12; 8 effects complete, 1 uncertain removal  |
| LZ-90/91 `1eb72f8a-2cc5-41ec-a827-a255d867153c` | v29/v30, original artifacts with explicit later corrections | v31, `c96c3a1` lineage with LZ-92/93 corrections | cleanup-blocked v32; 14 effects complete, 1 uncertain removal |

Original Models plan `d94042b8-eb0d-4eef-8973-2e19f4ac92a9` recorded LZ-84's task source landing at v37, explicitly retaining the original defects and subsequent corrections. Its prior backend task source landings remain v35/v36. No combined/native acceptance was recorded for that plan.

## Cleanup is not acceptance or source landing

Each normal runtime cleanup request was made only after independent review and one-shot checks finished. Each returned:

> Owned worktree worker activity is not conclusively idle; preserve it

Original attempts and resources were preserved. No forced removal, fabricated idle report/receipt, private injection, implementation replay or repeated cleanup retry followed. See `../native-liveness/20261103-retained-cleanup-inspection.md` for the supported inspection boundary. The additional Architect review checkout remains preserved on `lz-review/models-final-20261103`; its genuine merge ancestry is now included in Main.

## Native/Tera gate remains open

These checks establish source, declared split arithmetic and registered DOM behavior—not native pixels, Desktop focus/theme/font behavior or effective package activation. Root retains the existing native/Tera lane and approved `design/models-panel/models-approved.png` guide. The actual corrected candidate, not old `764db02` by proxy, needs candidate-bound native comparison qualification and supported formal evidence binding. No competing mockup, rejected LZ-68 trial, paid inference or healthy-service restart was used to manufacture evidence.

Unsupported cohorts/frontier/valuation/estimates remain unavailable, assignments remain read-only, and original Models/indicator/Radar/native-source formal gates and older cleanup holds are not waived by this merge.
