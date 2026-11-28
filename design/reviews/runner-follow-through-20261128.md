# Provider integration and runner follow-through

Observed 2026-11-28 against the regular OpenCode instance. The source and provider artifacts remain in git; no task database rows were manually changed.

## Failure

Plan `11bfefe3-4fcc-42f0-9d84-14c39cfde460` stopped with `Combined artifact verification failed`. Its completed check receipts show:

| Check             | Result                                                  |
| ----------------- | ------------------------------------------------------- |
| `quality`         | Exit 0                                                  |
| `cccc-tests`      | 20 passed                                               |
| `jscpd-tests`     | 34 passed                                               |
| `gitleaks-tests`  | 27 passed                                               |
| `cccc-parity`     | Missing built `opencode-lazers/code-review/cccc` module |
| `jscpd-parity`    | Missing pinned native development oracle                |
| `gitleaks-parity` | 11 fixtures passed                                      |

`PlanFinish.finish()` correctly retained the failed checks and called `RuntimeJournal.hold()`. The blocked notice was recorded as delivered with `resume=1`. Delivery did not establish successful Architect execution or resolution.

`QueueReview.requestQueueReview()` accepted only running dependency/reservation waits. `PlanStep.step()` returned for a blocked plan, and `TaskRuntime.tick()` called queue review only when such running waits existed. A consumed notice followed by an idle Architect therefore left this blocked plan without a recurring review path. The same delivered-versus-resolved gap affected accepted work awaiting integration.

The native resume also returned `Agent not found: "architect"`. LAZERS was absent from the plugin inventory. The self-hosted checkout was mid-merge with conflict markers in `package.json:18`; global OpenCode configuration loads LAZERS from that checkout. The driver resolved only that conflict, preserving both structural and cccc exports, and reloaded. Plugin loading completed after the reload call returned; the driver confirmed both active LAZERS and registered Architect before resuming the existing session.

## Corrections

- `4900c88a`: queue review includes blocked, accepted and cleanup-blocked plans, even without running dependency waits. Existing five-minute reconciliation cadence and queued-notice deduplication apply. Busy Architects and pending native questions/permissions remain undisturbed. Unrelated busy workers do not suppress review of finished or blocked work.
- `915fcb80`: an idle task worker releases its capacity admission without losing the task/attempt/session. Question and permission waits also release it when no background work runs. `session.hook('model.request')` reacquires the existing task slot before a resumed primary request. Submission and queueing remain unrestricted at capacity. Admission transitions still use `capacityMachine` through `lz_runner_transition`.

These changes add no task acceptance check or verification limit. Native helper execution completion continues through its existing lifecycle observer.

## Validation and live result

`bun run verify` passed. Eight relevant behavior suites passed 134 tests with 1,714 assertions. Regressions exercise unresolved delivered notices, setup repair and resumed combined verification without replacement attempts, accepted review beside a busy worker, input waits, unrestricted queueing, native idle/background hooks and same-session primary-request admission.

Architect completed provider merge `9ce78252`, recorded integration against `a0ae69a6`, and removed all five provider/verification worktrees through native cleanup. The driver built the server from the integrated repair commits and reloaded at a tool boundary. LAZERS reported active; Architect was registered; the original packaging session remained active.

Regular Desktop Project Tasks showed LZ-277 through LZ-281 as Integrated and LZ-282 as Running. LZ-282 completes normal build/package wiring for the four producers. The old provider recovery required driver intervention; it is not evidence of an intervention-free run. The repeat-wake behavior is demonstrated by the regression that reproduces the missing follow-through path.
