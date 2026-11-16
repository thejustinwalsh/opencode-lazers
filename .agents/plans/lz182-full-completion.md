# Retained Tasks scheduling: full-scope completion

## Outcome and source boundary

Complete the original LZ-182 outcome from retained, composed source: authoritative
Tasks Now, Attention and Next views, readable priorities and dependencies, and
dispatch that requires actually integrated prerequisite source. Partial LZ-211
acceptance is retained, not substituted for the full feature.

The fixed implementation baseline is `7c5f3b4166eeeb1a0410e90252a73a00102bd071`,
whose tree equals the user-supplied `7e60cf6009589add13467524c9ea746e4b492950`.
It contains accepted LZ-211, final LZ-210 `565c1a8`, icon-only Tasks rows, and
main's Models/Trajectory changes through `d2c3c02`. LZ-210 is already integrated
and its worker was natively cleaned. Do not recreate the Tasks conflict merge.

The baseline passed quality, 1,000 tests / 12,598 assertions across 58 files,
diff check and GUI build. Independent review nevertheless found two further
material gaps. Those results are retained evidence, not full qualification.

## Full-scope Tasks completion

One coherent completion task owns related code corrections, regression tests,
and connected native product evidence. Reuse the implementation rather than
reimplementing it. Preserve the entire original acceptance boundary:

- The registered scheduling read provides stable identities, priority/ordinal
  order, eligibility versus lifecycle, readable reasons and typed prerequisite
  references. Next is known only from adequate authoritative coverage.
- Fresh reads remain truthful when source-guard authority changes without a
  database or Git update. Cached/coalesced projections must not advertise an
  eligible Next based on a guard that is no longer authoritative.
- Valid large dependency/reservation sets produce bounded schema-valid responses,
  truthful counts/completeness and scoped references. In particular, 101 waiting
  plan prerequisites must not break the public read. Preserve Session privacy,
  the project-wide blocker universe beyond 1,000 displayed plans, and complete
  versus partial fact capture.
- Real TaskRuntime selection and prompt admission agree with the read while
  retaining fresh owner, input, cancellation, scope, reservation, Git ancestry
  and integrated-source proof. Accepted-but-unintegrated source cannot dispatch
  dependents. Authorized same-plan dirty/committed/repeated resume remains
  usable; arbitrary first-prompt or mismatched predecessor injection is rejected.
  Pause/unpause and conditional integration proof remain consistent.
- Coherent read pages, authorization, aborted/stale requests and concurrent writes
  remain safe and read-only. Missing coverage is not fabricated success.
- The registered Tasks panel presents authoritative Now/Attention/Next and typed
  task/plan/reservation navigation, with priorities/order and dependency reasons.
  Keep icon-only row state indicators at every width, native appearance, full
  accessible labels and readable inspector explanations.
- Preserve filters, search/scope, completed/history access, selection, keyboard
  focus, Start behavior and independent list/inspector scrolling. A transient
  scheduling/topology failure retains valid rows with a truthful warning.
- Exercise the actual connected candidate at normal narrow/default and wide
  Desktop geometry. Compare visible groups/activity/holds/order/reasons with
  native/runtime facts; drive filters, selection, dependency/history navigation
  and independent scrolling. Retain actual screenshots and action/observation
  receipts for Root/Architect and Terra High review. Fixture DOM tests or a GUI
  build alone do not close this gate.

Focused findings are in `src/tasks/scheduling-read.ts`: live guard-dependent
reservation exclusion near 497 versus projection cache/coalescing near 937; and
unbounded waiting-plan propagation near 443 versus the contract's 100-reference
limit. Correct producer and consumer together wherever the representation changes.
Do not weaken native dispatch guards or hide Next merely to avoid valid inputs.

## Dependencies and acceptance composition

Use a new task/plan linked as same-original-goal completion of LZ-182. The original
cancelled LZ-182 plan, both attempts, artifacts/resources and all logical
dependency history remain unchanged. Do not call integrated, adoption or fulfilled
disposition to relabel that attempted cancelled plan.

The completion task starts from the fixed retained baseline, not a moving-main
worker integration loop. Architect establishes a usable native verification path
before dispatch. Use the existing product-verification runbook and ordinary
supported native interaction; no manufactured workers, shared-service restart,
global activation, private host calls or original native-producer recovery.
Separate owned verification tooling is not production activation. If the supported
native path is unavailable, report the exact infrastructure blocker; it is not a
passing probe or permission to waive live qualification.

The task produces real candidate-bound native observations and screenshots.
Root/Architect owns final source/interaction review and the existing required
Terra High screenshot review (`openai/gpt-6.1-terra`, `high`, confirmed in the
live catalog), rather than delegating from the implementation worker. User
Desktop validation is supplementary, not the sole functional driver.

Automated verification keeps the original full command enabled:

```sh
bun run verify && bun test src/runner src/tasks src/observability/topology.test.ts src/observability/task-reads.test.ts test/task-panel test/observation-panels/tasks-activity.test.ts test/observation-panels/tasks-scheduling.test.ts && git diff --check && bun run build:gui
```

## Integration and dependent release

1. Complete and accept the new full-scope task/plan with automated and connected
   evidence; close material source findings and Root/Terra review.
2. Architect, the sole main writer, composes with actual current main, preserves
   retained source and independent changes, performs appropriate combined checks
   and records the new completion plan's integration.
3. The actual LZ-211 owner records its accepted artifact's integration against
   that checked-out main and inspects only its own guarded native cleanup.
4. Only after the full replacement outcome is reviewed and integrated, revise
   the three direct prerequisite consumers through supported controls: shared
   queue, visible-stuck recovery and observation audit. Preserve other edges and
   the original logical prerequisite in durable history. Execution audit and
   native-package audit remain transitive dependents; do not erase their links.
5. LZ-213 stays explicitly dispatch-paused until full qualification and the parent
   release decision. Advance its wholly unstarted baseline to reviewed joint
   main before explicit unpause/run. LZ-211 acceptance alone cannot release it.

The native work-lifetime producer/consumer and the LZ-154/196/native-idle holds
are separate work. This plan grants neither dispatch nor native activation for
them, and creates no cross-project dependency edge.
