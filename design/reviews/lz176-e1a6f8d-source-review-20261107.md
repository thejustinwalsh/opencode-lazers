# LZ-176 `e1a6f8d`: focused independent source review

OpenAI Luna Max reviewed exact `e1a6f8d0cef5b5ce593539008060c9d59025270f`
against parent `bc855a2d76e465dc806254d18ed7eb2001731316`, read-only in
Root's native `/private/tmp/lz-procedure-composition-20261107` checkout. The
reviewer confirmed clean exact HEAD. No tests, implementation, control actions,
merge or activation were performed.

## Result: no material implementation defects found

- `src/runner/retained-verification/procedure.ts:91–109` accepts a chain only if
  every step is independently supported, aggregates safe targets and declared
  scripts, retains all nine resources and fingerprints the full command.
- Existing candidate script declarations and target containment remain enforced
  (`procedure.ts:174–199, 241–260`; `isolation.ts:620–623`).
- Unchanged execution runs `check.command` verbatim and records it in the receipt
  (`src/runner/artifacts.ts:400–405, 429–444`).
- Tests cover the observed build/test chain, actual build-before-test order,
  short-circuiting after failed build, and registered task-plus-combined checks
  without additional prompts (`procedure.test.ts:5–39`,
  `isolation.test.ts:635–737`, `retained-reverify.test.ts:616–651`).

## Non-blocking acceptance-evidence gaps

1. **Low:** unsafe-form tests (`procedure.test.ts:31–39`) do not explicitly
   assert rejection of `$()` or backtick substitution. The parser appears to
   reject these; no bypass was identified.
2. **Low:** the registered-flow test (`retained-reverify.test.ts:643–648`)
   checks exact `check_json`, receipt success and output but does not assert the
   receipt's own `command` field or computed fingerprint against the original
   authored string. Unchanged `runCheck` source confirms these behaviors.
3. The combined-flow test lacks an explicit post-combined assertion that prior
   held/unknown state remains. The task-phase test checks unknown background
   before that phase (`retained-reverify.test.ts:600`).

These are targeted assertion opportunities in existing tests, not identified
implementation defects or a reason to dispatch another worker. Keep them distinct
from actual native check/acceptance evidence still required.

## Supplied checks and remaining boundary

Root reports four composition regressions and registered flow fail before/pass
after, 85 tests / 864 assertions / five files in 42.86 seconds, and formatting,
lint, typecheck, diff, GUI build and bundle evaluation pass. The reviewer and
Architect did **not** rerun those checks; passing results are supplied evidence.

LZ-176 stays undispatched for Root's bootstrap. This review does not accept the
task, authorize activation or retire held LZ-173 generation 1. Root owns any
targeted assertion follow-through, integration and quiet server activation.
Only after the relevant reviewed repair is live should the existing control
retire the obsolete held verification authority and retry unchanged original
LZ-173, retaining receipts, source/human gates, usage and unknown resources.
Actual LZ-175 descendant admission remains observed, not full verification or
fulfillment. Original LZ-174's scan-heavy candidate stays rejected unchanged.
