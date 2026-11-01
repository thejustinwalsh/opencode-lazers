# Stable live Trajectory history — verification record

2026-11-01. Task LZ-36, revision 1.

## Automated evidence

- Focused: `bun test src/trajectory src/observability test/trajectory test/trajectory-panel test/observability` — 66 passed, 0 failed across 16 files.
- Full: `bun test` — 421 passed, 0 failed across 82 files.
- Quality: `bun run verify` — all 422 files formatted; lint passed for 204 files; typecheck passed for 196 files.
- GUI build: `bun run build:gui` succeeded. It emitted the existing inline-dynamic-import deprecation and ONNX `import.meta` warnings.
- `git diff --check` is recorded after the final evidence edit.

## Context-read measurement

Using the two-session fixture, page size 2, ten completed live-status reads, three cached history continuations, same-sequence tool completion, then explicit recapture:

| Phase                              | Full-session reads (`session.get` + native context path) | Metadata-only reads | Context messages | Captured events                         | Loaded events                                                                                |
| ---------------------------------- | -------------------------------------------------------: | ------------------: | ---------------: | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Initial capture                    |                                                        2 |                   0 |               10 | 14                                      | 2                                                                                            |
| Ten statuses + three continuations |                                             0 additional |                  20 |     0 additional | unchanged                               | 8, unique and in capture order                                                               |
| Explicit recapture                 |                                             2 additional |                   0 |               10 | 15, including the updated progress fact | 2 in the read probe; the panel retains its previous 8-event union until replacement succeeds |

The native adapter test separately asserts metadata-only status calls `session.get` and never `session.context`. Read tests verify updated model/usage/check facts and same-sequence progress completion without rewriting captured history before recapture. The selected-event regression verifies captured entries remain authoritative, a live tool absent from capture updates the selected title/payload on same-ID completion, reselect uses the current live value, and the snapshot is only a fallback when neither captured nor live data contains the event. Pagination coverage checks the ordered page union and rejects replayed or reordered continuations.

## Expired-history recovery

Expected expired, evicted, and invalid-cursor failures carry bounded reasons through the declared `trajectory_history_unavailable` RPC error after authorization. The panel decodes the native plain `{type, message, data}` error, retains a separate history-recovery message across healthy status polls, and offers explicit cursorless recapture separately from status retry, including after a transient disconnect before the first successful capture. Regressions verify a successful recapture replaces the old capture, while a failed recapture preserves the old pages, selected event/payload, capture metadata, and history error. Empty or nonadvancing recapture continuations now fail promptly instead of retrying indefinitely and leave the old capture intact. Existing permission-first, cursor-binding, privacy, and read-only checks remain in the focused/full suites.

## Mounted Desktop acceptance — pending

The latest source candidate has not been activated or mounted. The previous mounted expiry reproduction on `214adcb` is documented in `native-observations.md`; it is historical evidence of the defect, not proof that this repair works in Desktop. Native RPC error delivery, exact-artifact disclosure/open-state, scroll-anchor, paging continuity during real activity, and expiry/recapture behavior remain unverified. Automated source/state tests and a GUI build do not substitute for those observations.
