# Trajectory privacy review and integration

LZ-31 artifact `2fff6bbc94baeece2b3629c40632642082671316` was held after
independent review reproduced multipart JSON and exhausted-depth structured-string
leaks. LZ-35 repairs those cases in descendant
`15eff84067a91a26250c1b084053cccf3e8f6851`; neither finding was dismissed because
the original runtime checks passed.

## Corrected-candidate checks

Independent Architect checks in the exact LZ-35 checkout:

- `bun test src/trajectory test/trajectory`: 35 pass, 0 fail, 239 assertions.
- Retained audit reproducer: all four private-content retention flags false;
  safe argument, result and error summary flags true.
- Original review multipart reproducer through real `inspectTrajectory`:
  private multipart canary absent, safe multipart summary present.
- Original eight-level structured-string reproducer: private depth canary absent.
- `bun run verify`: formatter, lint and strict types passed.
- `bun test`: 380 pass, 0 fail, 3,505 assertions across 75 files.

All reproductions used disposable fixtures, not live application data.

## Native review lane

Native OpenCode reviewer `ses_e687d54deffemTI0rEAxrAfo6E` reported no blocking
findings on the corrected candidate. It checked independent multipart filtering,
depth/encoding handling, positive safe summaries, and unchanged permission-first,
ownership and read-only behavior. Its reported 169-case depth/encoding probe is
review evidence, not a replacement for the independent command results above.
Arbitrary secrets in ordinary prose remain outside the stated guarantee.

An external Codex CLI attempt failed on configuration before reviewing anything.
The user reaffirmed native OpenCode research/review and LAZERS implementation;
the external lane was not retried and supplies no review evidence.

## Source landing and remaining runtime boundary

The corrected descendant was merged into main after native review. Concurrent
uncommitted `src/runner/runtime.ts` and its test belong to other work and were
neither staged nor discarded. A native temporary verification worktree was
created from the committed merge snapshot to check the integrated source without
those unrelated edits. Its first full run exposed the missing generated
`.cache/lfm3-engine.js` asset, not a privacy regression. After the supported GUI
build prepared that asset and the tree fast-forwarded to `2536084`, the clean
integrated snapshot passed GUI build, 382 tests / 3,533 assertions, and quality.

Both accepted artifact ancestors were recorded through runtime integration
commands after those checks. Both plans reached integrated version 9 with zero
pending effects. Native registry and filesystem checks confirmed both owned
worker worktrees absent after non-forced cleanup. The clean temporary
verification worktree was also removed through the native API without force.
No lifecycle candidate is included in this landing.

Public `location.reload` activated the current server source including the user's
`2536084` stale-receipt fix. Before reload, all seven loaded directories existed
and both running plans had zero pending native effects. After reload the service
endpoint remained `127.0.0.1:49374`, and LZ-32's exact session, attempt, workspace,
Luna Max route and busy timestamp remained unchanged. No replacement worker or
service restart was requested. Native execution of LZ-32's next verification
epoch remains a subsequent observation, not inferred from reload success.
