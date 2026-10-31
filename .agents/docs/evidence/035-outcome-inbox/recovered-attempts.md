# Recovered first-attempt history

2026-10-31. Independent read-only review compared failed wake `c44d345` and
reference `239e728` with their accepted replacements and current main `0f50b59`.
No implementation, dependency or test change remained unrecovered.

Wake's eleven original paths are represented by `1356ce3` / `a6c5877`, including
store migration and process recovery tests. The reviewed integration additionally
fixes global native message identity, owner retargeting and cumulative partial
review. References' nineteen original paths are represented by `d1f58b4`,
`053338d` and `1f9fb6a`, including the association lookup/search dependencies that
the replacement worker omitted. Current reference-focused checks passed 53 tests /
452 assertions. Full merged checks passed 339 / 3,214 before this bookkeeping.

Native cleanup requires the owned worktree HEAD to be an ancestor of main.
`5d9be1f` records both fully recovered originals as merge parents with the `ours`
strategy. It makes no tree change and reapplies no obsolete code. This preserves
original commit history and lets the existing native cleanup verify mergedness;
it is not a claim that the failed attempts were accepted without review.

Runtime commands and OpenCode's native non-forced worktree removal still own
cleanup. Dirty, active or genuinely unmerged work must remain available.
