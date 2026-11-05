# Architect source-journal inspection evidence

This increment adds an explicit bounded `view: "journal"` to `lz-inspect-plan`.
The journal reader returns source/input/result metadata with original
session/message IDs. It does not return message bodies, claim complete transcript
coverage or native consumption, or change input dispositions, scan checkpoints,
outcome receipts, or notices.

## Source and behavioral evidence

- `bun test src/runner/inspection.test.ts src/runner/tools.test.ts src/runner/store.test.ts`
  exercises compact/full compatibility, limit and cursor validation, permission
  denial before store access, a complete traversal of 3,839 results plus 804
  inputs, non-anchor renewal-plan mapping, read-only state, replay/scope checks,
  and stale-cursor rejection after an in-place result revision change.
- The registered-tool regression in `src/runner/tools.test.ts` reads page one,
  inserts progress for a separate worker plan, verifies that the project-wide
  observation revision advances while the selected journal revision and records
  stay unchanged, then traverses the remaining pages without gaps or duplicates.
- `bun run verify` runs Bun formatting, linting, and strict typechecking.

## Native gate remains open

These source tests do not establish live native SDK message retrieval or notice
non-acknowledgement on an activated candidate. Root must probe the exact committed
artifact against the retained native journal and retrieve a selected referenced
message through the authenticated SDK before native acceptance or integration.
