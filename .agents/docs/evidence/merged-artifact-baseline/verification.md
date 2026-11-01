# Merged artifact baseline verification

Isolated artifact scope now compares candidate changes against the admitted base
combined with reviewed history actually shared by the candidate and reviewed main.
Ancestor cases keep their existing commit baseline. Divergent histories require a
unique merge base and a clean virtual merge; conflict, missing, or ambiguous
ancestry fails before staging.

## Captured divergent repair graph

A detached worktree smoke exercised the repository's captured graph directly:

- admitted base `B=08b2a4726564a43adec77238aa8315ae5dc7eebc`
- candidate `H=de9af3b620f9afb23a178696284e5429eda36a3c`
- reviewed main `R=f32afa36730e05da2535ce571a347bb19c44a377`
- incorporated common contribution `C=54e4ecd4e5f7b44ed2260b02d863a67a6e6d2cff`
- clean `merge-tree(B,C)` baseline `e9d4deab569909d095b81293b644faa6554565d8`

`commitArtifact` returned `H` unchanged with that tree as `scopeBase` and exactly
five candidate paths: `.agents/docs/evidence/stable-live-trajectory/report.md`,
`src/trajectory-panel/panel-state.ts`, `src/trajectory-panel/panel.tsx`,
`src/trajectory-panel/projection.ts`, and `test/trajectory-panel/panel-state.test.ts`.
The reviewed contribution was excluded without expanding the worker's permitted
paths.

## Regression and quality checks

`bun test src/runner/artifacts.test.ts src/runner/artifact-evidence.test.ts`
passed: 11 tests, 92 assertions. Regressions cover divergent and ancestor cases,
an unmerged prerequisite, an unmerged reviewed-main tail, copied content without
shared ancestry, previously reviewed-path edits in committed/staged/unstaged
states, untracked files, conflict-resolved worker merges, ambiguous ancestry,
shared-checkout scope, and artifact parent/identity behavior.

`bun fmt --check`, `bun lint`, and `bun check` also passed.
