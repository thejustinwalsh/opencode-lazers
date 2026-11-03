# Reviewed Models backend source integration

Merged the corrected backend into Main as `46cd3b573278dfd8bed8973cb9caddded315e626`, with real parents preserving prior Main evidence and accepted LZ-89 `dc2e9ba6d6f5ece7bdbb0d2aa5cb80a00f8aae35`. No implementation was replayed and no native UI acceptance was recorded.

## Preserved defect and repair lineage

- LZ-83 `05a71850637ba3dd4f105322844a9949fa84edb5`: bounded comparison service. Its four reviewed effort/variant/source-pin/archive defects were corrected by LZ-87 `1bb8f82a99ac3e83885b7afd11a7f983a3d46162`; the original reviewer independently cleared all four. All seven LZ-87 paths remain byte-identical in Main.
- LZ-85 `e2e1f86213ce3d11847e05db753d172a19692428`: lossless route comparison, retaining unknown identity where truncation lost it. Its process-global unavailable-route counter destabilized cursors.
- LZ-86 `92052632ef1b15f8b11c965c752c3e6af9d72fc3`: fixed the counter/cursor boundary, but fallback keys merged distinct ID-less observations. Accepted combined `69d859a54d1f20ecc93b915335e35220fbf31345` retained this defect. Neither artifact was retrospectively declared source-clear.
- LZ-89 `dc2e9ba6d6f5ece7bdbb0d2aa5cb80a00f8aae35`: carries the actual retained fact ID and observation slot through both aggregation passes. Original reviewer confirmed two ID-less occurrences remain two for identical and different truncated displays, four remain four across distinct facts/slots with equal or missing timestamps, and all eight cursor continuations succeed. Exact 121-character versus native-exact/retained-unavailable 401-character routes, privacy, ownership, session usage and nonmutation remain intact.

The LZ-89 review passed 105 tests / 851 assertions and its independent 12-case identity matrix. Architect checks on both exact `dc2e9ba` and merged Main passed **142 tests / 1,424 assertions** across Models, trajectory, progress and registered trajectory fixtures. Formatting, lint, strict types and diff checks passed; merged Main was clean. These are source/fixture checks, not native UI observations.

## Exact source integration records

- LZ-89 plan `82cc5e08-59db-4716-9eee-8cc9e54d59d0`: task landing v20; exact combined `dc2e9ba` integration and guarded cleanup request v21.
- LZ-86/87 plan `13d07bd2-9c4b-4f2b-9b00-0a215ee569a2`: separate original task landings v45/v46; combined `69d859a` lineage integration with explicit LZ-89 correction v47. Original LZ-86 defect/review history was preserved, not erased.
- Original Models plan `d94042b8-eb0d-4eef-8973-2e19f4ac92a9`: original LZ-85 source landing v35 and LZ-83 source landing v36, explicitly naming their later corrections. No LZ-84 UI landing or combined/native acceptance was recorded.

## Native cleanup remains separate

Normal non-forced cleanup was requested only after the independent review and one-shot tests finished. LZ-89 became **cleanup-blocked v22** (8 completed effects / 1 uncertain removal); LZ-86/87 became **cleanup-blocked v48** (16 completed effects / 1 uncertain removal). Both reported `Owned worktree worker activity is not conclusively idle; preserve it`.

LZ-89's supported native preinspection found the exact owned succeeded worker, no foreground execution, an empty inbox and zero worktree-location permissions/forms. It still did not establish the complete cleanup conjunction. This is a newly completed worker in the current host generation, so do not attribute every cleanup hold solely to historical reports lost on restart. The precise failed conjunct remains unobserved through current public inspection.

No forced cleanup, fabricated background report, receipt mutation, private injection or repeated cleanup retry followed. Original worktrees, attempts, defects and checks remain preserved. See `../native-liveness/20261103-retained-cleanup-inspection.md` for the inspection boundary.

## Still open

LZ-90/91 are repairing the independently reviewed UI defects and missing real registered-panel DOM coverage. Their review-only baseline `39dcc10` includes the original UI and intermediate backend; final integration must retain the corrected LZ-89 accounting now on Main. Root owns final connected native/Tera evidence. Original LZ-77/78 formal gates, unrelated native indicator/Radar gates and older cleanup holds are not closed by this source merge. No healthy-service restart or native activation was performed here.
