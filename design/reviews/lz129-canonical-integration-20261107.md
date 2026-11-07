# LZ-129 canonical integration — 2026-11-07

Accepted original-worker artifact `9f61a6633dd3d64a3bc51672c4e5d63e1234adcb` is preserved as a parent of integration merge `0e64881`, prepared through OpenCode's native worktree API at `/private/tmp/lz129-canonical-integration-20261107` on `feat/lz129-canonical-integration-20261107`.

Four conflicting files were reconciled individually. The shared membership cache and its revision/project isolation tests remain. Source revision identity follows the reviewed process-shared publisher key rather than per-reader signing secrets; the canonical cache test now expects cross-secret source identity stability. History cursor signing remains reader-specific. Both the existing trajectory live cache/valuation provider and the new live Radar reader remain, under separate fields. Runner-store tests retain both canonical active-attempt coverage and the candidate's upgrade/index/reopen regression.

Verification of this combination:

- `bun test --max-concurrency=1 src/observability test/observability src/progress src/radar/transport.test.ts src/radar/state.test.ts src/runner/store.test.ts src/runner/runtime.test.ts test/trajectory-panel src/trajectory/privacy.test.ts`: **526 pass, 0 fail, 7,046 assertions, 27 files**, 108.74 seconds. Default test timeouts retained. Log `/private/tmp/lz129-canonical-combined-tests-20261107.log`.
- Bun formatter: 843 unchanged files; lint: 404 files; typecheck: 392 files; diff checks pass.
- GUI build and bundle evaluation pass, log `/private/tmp/lz129-canonical-gui-build-20261107.log`.

Source landing does not establish native activation or live performance acceptance. Required next observations are actual cross-location publication counts, navigation/refresh and scope behavior, and process/load measurements. Historical association materialization remains a known scaling limit; no claim that all CPU/freeze defects are solved.

The older conflicted `6ee21e0` trial and every native worker/attempt/artifact remain preserved. No production database state, inference setting or model route was changed. LZ-172/173 review corrections and interrupted LZ-174 recovery remain separate, unfinished work. Main's last provider failure was DNS resolution of `auth.openai.com`; a fresh lookup succeeds, but a new native model turn has not yet been observed. Computer Use subsequently explicitly reported macOS locked; unlock request is pending.

Canonical landing and build completed at `ecbdb01`. The clean, fully merged Root review worktree was subsequently removed through native `worktree.remove(force:false)`; readback confirms `exists:false`. Its branch retains source. Worker worktrees and the older conflicted trial remain untouched. No Desktop reload, native plan-integration command or live acceptance was performed.
