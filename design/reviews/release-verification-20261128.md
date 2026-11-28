# Release verification: 0.2.1 candidate

Checked on macOS arm64 with regular OpenCode Desktop/service 2.4.1 and Bun 1.4.4-canary.1. The package SDK remains pinned to 2.3.0. No separate Desktop profile was started for these checks.

Production source: `9c7cc22e28984c8b636d6f88d41a19ccbafe0229`, tree `a9d888043ecb8c076e6fb3364b3a3c255eadeb45`.

## Integrated repairs

| Change                                                                                      | Result                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releaseFallowWasiMemory()` and `settleFallowRun()` in `src/audit/fallow-wasi-lifecycle.ts` | Completed WASI runs clear Bun's retained `memory` and `view`, imported bindings, run instances, and helper references. The threaded path clears its WASI bindings too. Memory and subprocess fixes are integrated through LZ-271/LZ-274.                                                |
| `ModelLease` in `src/webgpu/lease.ts` and lease acquisition in `src/webgpu/runtime.ts`      | Desktop reconnects across providers that retired without acquiring the inherited lease, including an already released lease. Exact active-owner and disposal checks remain. Commits `dc8aa081` and `ee0f7f6c`.                                                                          |
| `resolvePanelProject()` in `src/panel-project.ts`                                           | Tasks, Radar, Models and Trajectory read through the canonical project after a selected worker's worktree is removed. Commit `3b054165`.                                                                                                                                                |
| `terminalWorkerHoldForContinuation()` in `src/runner/terminal-worker-hold.ts`               | The attempt/history join uses `planIs()` for keyed and pre-migration identities. Commit `03f3d7cf`.                                                                                                                                                                                     |
| `assertGraphWorkspaceQuiescent()` and `WorktreeCleanup.cleanupFacts()`                      | A receipt-less superseded check can use a later settled check for the same workspace, artifact and check. Live or uncertain activity still prevents removal. Cached activity identities avoid history reads on unrelated plan churn. LZ-276 candidate `c1723cce`, merged as `9c7cc22e`. |

`src/implementor.md` now distinguishes task checks from project command templates. Commit `5014d93b` preserves relevant behavior checks and automatic formatting/lint fixes without demanding another unchanged full suite.

## Native integration and cleanup

At Unix milliseconds `1795830565020`, the project database contained 154 integrated plans and 78 cancelled plans, with no unfinished plan.

| Plan                                                   | Final state                                                       | Native removal result                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| LZ-276, `d07c075a-95fe-4259-8944-f4f85a54c870`         | `integrated`, artifact `c1723cce04b5dcc74f1971cf6d062c0e5cc76330` | One completed `worktree-remove`; `removed: true`, `native: true`, cache retirement `evicted`; recorded directory absent. |
| Retained relay, `b6686170-db82-4a40-b700-dcb318ad59ac` | `integrated`, artifact `4b0e4a6ebc557be70ecf0fa1706cb0d508f69f38` | All 15 recorded removals completed through the native API. All 15 recorded directories are absent.                       |

The last held relay workspace ended in `fb5277cf-854a-4930-8c99-60877c886bb2`. Removal effect `66b3784b23b17bdaa3885902214a0c4331476839f9c05403349a0e06a6f60bc5` records completion. Its earlier failed observations remain in receipt history. No SQL edits or forced worktree removal were used.

The new worker workspace ended in `556abb62-3006-45db-930d-74994f4c5299`. Removal effect `76ae3092a9d4e53a6045b66e7d6e0c221719b8eb0e7fae94b246e4621ca585e5` records completion.

## Live Desktop checks

The regular instance loaded the integrated server and GUI bundles. The plugin API reports `active`.

- Tasks loads the completed LZ-271 session after its recorded worker directory was removed.
- Open in Trajectory loads its four attempts, recorded checks, tools and file activity.
- Radar Project shows the actual LZ-276 worker and its patch activity while it runs. Session scope correctly shows no activity for the completed LZ-271 session.
- Models Compare and Assignments load from that same historical session. Existing persona assignments remain unchanged.
- A real Architect turn used `lz-local-system-one`. Native task review also ran the pinned D1 model, with measured inputs of 20,051 and 19,443 tokens.

After the final package build, `LocalInference.systemOne()` completed through the regular renderer in 4,698 ms with 68 input tokens and a typed choice response. A settings read during location startup returned `rpc.internal`; the next read succeeded after load completed, without a restart. Desktop showed `Unloaded` after idle release.

Three sequential native `lz-fallow-health` calls exercised actual WASM analysis. The service RSS observation used 180 samples from PID 28552, between Unix milliseconds `1795827042458` and `1795827223782`:

| First        | Peak         | Last         |
| ------------ | ------------ | ------------ |
| 2,199.33 MiB | 2,334.14 MiB | 1,745.98 MiB |

This measures service RSS during that interval. It excludes Desktop renderer and GPU memory. It supports release of completed analysis memory in this observed run; it does not measure model/GPU allocation or long-duration memory behavior.

## Checks

`bun test --timeout 120000 --dots` passed on the unchanged source commit above: **3,686 pass, 3 skip, 0 fail**, 76,694 assertions, 3,689 tests across 512 files, in 992.99 seconds. The process exited 0. One conditional Rust profile test skipped because this machine has no default Cargo toolchain. The nested real-WASM suite also passed: 47 tests, zero failures, across three files.

`bun run verify` passed with zero formatting changes, zero lint errors, and no type errors in 1,291 files. It reported 115 existing lint warnings. The data-read guards passed: 207 listed reads with zero todos, and 68 allowed RPC calls across 349 GUI modules.

The LZ-276 worker passed 41 focused cleanup/idle tests. Native task and combined verification each passed quality, 38 focused cleanup tests and the Fallow audit. No introduced Fallow finding was reported. The earlier manually interrupted broad worker run is not counted as a full-suite pass.

## Package

`bun run package:release v0.2.1 /private/tmp/lazers-v0.2.1-9c7cc22e` built the server/GUI, staged the release, installed 421 dependencies in a clean consumer, checked every export and runtime worker script, and imported `opencode-lazers` successfully.

A separate scan of the clean-installed `node_modules`, including dependencies, found zero native executable/addon files. The package also passed the packager's native-binary check.

Candidate: `.cache/releases/v0.2.1-9c7cc22e/opencode-lazers-0.2.1.tgz` (about 34 MiB), retained in the checkout outside Git. This is a copy of the clean-installed archive from the command above.

This is a verified local release candidate, not an npm or GitHub publication. The regular Desktop uses the matching built checkout; the archive's clean install was checked separately. Existing published 0.2.0 was not replaced.

Operator logs remain at `/private/tmp/lz-release-final-suite-20261128.log`, `/private/tmp/lz-release-final-quality-20261128.log`, and `/private/tmp/lz-release-package-9c7cc22e.log`. The compact native cleanup observation is `/private/tmp/lz-release-closeout-20261128.json`.

## Final patch branch

`feat/release-0.2.1` starts at `fb60d25b` and carries only the subsequent scheduler repairs: shared capacity across project identities (`f7c15e0e`, original `b817a810`), unresolved Architect follow-through (`945ae68c`, original `4900c88a`), idle task-slot release/resumption (`59613a3d`, original `915fcb80`), and the read-only queue lookup correction (`9ba16d0e`). Review providers and UI remain on main for 0.3.0; this patch does not ship them.

The first patch regression run found that `QueueReview.requestQueueReview()` opened a write transaction for its read-only prior-notice lookup. Existing `idle-churn.test.ts` observed five atomics across five idle ticks instead of zero. `9ba16d0e` changes only that lookup to `store.read()`; actual notice creation stays fenced. The unchanged assertion then passed.

The final patch scheduler run passed **80 tests, zero failures, 903 assertions, eight files in 21.77 seconds**. It covers capacity, native helper/runner sharing, resumed primary requests, dispatch pause, Architect follow-through/renewal and idle churn. The earlier 3,686-test full-suite result above remains the baseline result; it is not a new full-suite run on this patch branch.

Final `bun run verify` passed: 115 warnings, zero errors, 1,293 typed files; both read guards passed. `bun run package:release v0.2.1 /private/tmp/lazers-release-021-candidate` built the exact patch, checked for native executables/addons in the staged package, installed 421 dependencies into a fresh consumer, checked all exports/worker files and imported the plugin successfully. Logs: `/private/tmp/lazers-021-final-quality.log`, `/private/tmp/lazers-021-scheduler-tests-fixed.log`, `/private/tmp/lazers-021-final-package.log`.

Release metadata and install commands use 0.2.1. Package creation is complete; publication and final regular-Desktop activation are separate operations and are not claimed by these results.

## GitHub publication

Tag `v0.2.1` resolves to patch commit `74ccd4a6`; main preserves it through normal merge `0e4d127d`. [Release CI 46168612569](https://github.com/thejustinwalsh/opencode-lazers/actions/runs/46168612569) passed quality, 187 WebGPU/packaging/native-binary tests (zero failures, 1,113 assertions), build and fresh-install import checks. [GitHub v0.2.1](https://github.com/thejustinwalsh/opencode-lazers/releases/tag/v0.2.1) is public. Its actual downloaded asset was installed into another disposable consumer: 421 dependencies, zero native executables/addons, no Review feature exports/source. Both temporary consumers were removed after their checks.

Website deployment `46168740427` completed for main merge `0e4d127d`. npm still reports HTTP 401 for `npm whoami`; publication requires renewed maintainer authentication. No npm success is claimed.
