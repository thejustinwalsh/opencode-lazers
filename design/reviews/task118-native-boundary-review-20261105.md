# LZ118 native error-boundary review

In-progress original worker: `ses_8a19b036a82f42599a1d978220fb871a`, attempt
`50345fa1-fccf-4cb7-9e85-e459ec1f85d9`. This records a reproduced finding at
`1793876109068`; subsequent worker changes require fresh review.

The startup classifier accepts only the HTTP protocol `WorktreeError` envelope
(`name`, `_tag`, `data.message`). The native adapter calls in-process
`ctx.worktree.create`. The pinned [PluginHost](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts#L573)
directly forwards that call to the core worktree service. It does not map errors
through the HTTP handler. The [core service](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts)
can return core typed errors, including `Worktree.OperationError` and
`Worktree.DirectoryUnavailableError`.

Root's one-shot reproduction imports the installed `Worktree.OperationError`,
passes actual failures through `Effect.runPromise`, then calls the worker's actual
classifier. Results:

| Failure shape                                   | Recognized |
| ----------------------------------------------- | ---------- |
| Installed core `Worktree.OperationError`        | false      |
| Pinned directory-unavailable tagged-error shape | false      |
| HTTP `WorktreeError` envelope                   | true       |

Script: `/private/tmp/lazers-startup-native-error-shape-review-20261105.ts`.
This is a classifier/Effect boundary regression, not a live startup-settlement
qualification. Existing HTTP-only adapter tests do not cover the real plugin
boundary. Correct and test genuine native shapes before acceptance; keep unknown
transport/lossy cases honest. This finding does not reconstruct missing historical
fields or establish that old effects have settled.

Root sent the finding through Desktop; Architect attached blocking advice to the
original task and notified its owner. Delivery is not proof the worker consumed
or corrected it. Native source/behavior and final tests must establish correction.

## In-progress correction recheck

At `1793877427994`, Root reran the actual classifier after the worker added core
error handling. The installed canonical `Worktree.OperationError` still returned
`recognized: false`; a directory error with the exact pinned class name returned
true; HTTP returned false. The classifier uses `instanceof` against the worker's
separately installed schema package. The reproduction loads the canonical schema
package, so constructor identity differs across real package copies. This remains
a boundary regression; same-package unit fixtures alone cannot establish the
host/plugin behavior. Constructor names likewise should not establish terminal
operation identity. Preserve structured native failure information and unknown
transport outcomes.

Recheck script: `/private/tmp/lazers-startup-native-error-shape-recheck-20261105.ts`.
Root queued this finding in Desktop for the existing same-worker review flow;
no worker/canonical source edits or extra acceptance claims.

## Cache retirement review

The in-progress `nativeHost.retireWorktreeLocation` uses
`session.list({ archived: false, directory })` and treats any result as an active
session. Unarchived history is not active execution. At `1793878102319`, the
completed LZ133 worker `ses_9250c22e68da40ff86371b407b9c3c11` was still unarchived
and located at its legitimately removed checkout; the native active-session
observations exclude it. This is a real retained-history counterexample, not a
reason to archive or delete its history. The new fixture calls its session-list
entries `activeSessionDirectories`, hiding the distinction.

As written, routine completed-worker history prevents cache eviction, leaving the
stale-location problem unfixed for that normal lifecycle. Cache-retirement refusal
is recorded separately and does not invalidate cleanup or acceptance; preserve
that separation. Check actual native active execution for the location and retain
session history. This finding is from the in-progress source and requires fresh
review after the worker finishes.

## Structural classifier recheck

At `1793878175613`, the independent cross-package reproduction against the
worker's revised structural classifier returned true for the actual separately
loaded `Worktree.OperationError` and the pinned directory-unavailable class, and
false for the HTTP envelope. The constructor-identity regression is corrected
in this source revision. This narrow check does not establish adapter, recovery,
whole-suite or native-product acceptance; the cache-retirement finding remains
open pending later changes.

## Committed-worker continuation regression

The broad worker run at `1793878582019` returned 254 passes, four failures and
one error. Focused reruns reproduced the existing resumed-worker/new-commit and
lost-prompt-response/committed-worker tests. Root source review found that
`prepareWorker` unconditionally calls `startupWorkspaceReady`, whose completed
worktree-receipt branch requires current HEAD to equal `attempt.base_commit`.
That rejects legitimate worker-produced commits on continuation. Creation-time
source validation must remain scoped to creation/recovery; it must not become a
general attempt freshness gate. Preserve these regression expectations and old
attempt baselines. Root sent this diagnosis through Desktop's existing review
flow. Subsequent source and test results must establish the correction.

## Cross-package test portability

The added `native.test.ts` cross-package fixture derives canonical `node_modules`
from `git-common-dir`, then asserts its error constructor differs from the local
one. In a normal main checkout those paths identify the same package, so this
assertion fails after integration. Use a real independent temporary fixture in
either checkout, with ordinary cleanup; do not skip it on main. Root also verified
that Bun resolves a file URL with a query suffix to the same module/constructor,
so a query suffix alone does not create an independent copy here. Sent through
Desktop for the existing review.

## Actual legacy startup recovery decision

Native Luna Max research (`ses_e547cd8dfffe5Ly35RtxsaSECJ`) checked LZ139's
starting revision `2d5c550` and LZ141's `ed5cd6a`: the native adapter called
`Effect.runPromise(ctx.worktree.create(...))`, while the old runtime stored only
`errorText(error)`. Both existing uncertain effects retain exactly
`{ "error": "Worktree.DirectoryUnavailableError" }`. The original tag payload
and executing plugin-build field were not retained.

Root selected the researched narrow legacy compatibility case in existing118,
using the same settlement then explicit resume flow and its existing fresh
resource/session checks. Preserve the original receipt, bind a distinct legacy
classification to its effect/attempt/workspace/base, and keep inference/unknowns
honest. Do not fabricate a v2 failure payload or require an unavailable historical
build fingerprint. This is a source-grounded compatibility decision, not an
assertion that absent resources alone prove every unknown operation stopped.
Do not extend it to arbitrary errors, timeouts or lost responses.

Delivered through Desktop for the current original worker; actual LZ139/141
settlement, resumed execution and feature acceptance remain unobserved.

## Observed substantive continuation

Original worker committed `4cd3694`, reported passing44 focused and259 runner
tests plus quality checks, and reached native idle at `1793880221270`. The late
legacy review was initially delivered with `resume:false` while it was inactive.
Delivery did not wake it. Main then used supported `session.synthetic` with
`resume:true`; native busy at `1793880443616` and subsequent worker tool calls
confirm actual implementation resumed in the same session/attempt/tree. The
observed idle interval was222346ms (3m42.346s); this is elapsed coordination time,
not a claim that all of it was avoidable overhead. Legacy source changes and
actual139/141 recovery were not yet complete at this observation.

The native idle/input-lineage hold has existing `lz-plan-command reconcile`
`reviewInputID` support for an actually completed observed review. It is distinct
from reconstructing a missing historical idle event. A pending substantive
correction needs a real wake and execution before that reconciliation. Delivery,
wake, implementation, checks and acceptance remain separately observable facts.

## Repeated conclusive startup failure

Root's isolated `/private/tmp/lazers-startup-repeat-review-20261105.test.ts`
reproduces a second-failure dead end: first typed failure settles, explicit
resume creates a `worktree-recovery` operation, that creation fails conclusively
without resources or a worker prompt, and the next settlement rejects with
`Startup settlement requires the original uncertain worktree effect`. The
selector still finds only the already-failed original `worktree` operation.
The run returned one failure after six assertions; temporary fixtures were
cleaned normally and no production data/source was changed. This is a repeatable
behavior regression, not a request for another approval gate or retry budget.
Sent through Desktop for existing118 review and same-worker correction.

## Reusable legacy compatibility

The first legacy draft added a production allowlist containing the exact139/141
plan/task/attempt/effect/session/message IDs and source commits. Root rejected
that approach through Desktop. A reusable plugin must derive current identity
bindings from runtime records and classify a versioned historical receipt format,
not embed this backlog or use source revisions as admission fingerprints. New
untyped captures need a distinguishable format so a modern defect with similar
error text cannot become inferred legacy typed evidence. Preserve original raw
receipts, unknowns, fresh resource checks and tests with independent identities.
This is an open correction, not a qualified migration.

## Repeat recheck and dependent task bases

Root reran the independent repeated-failure regression after the operation-selection
change: one pass, seven assertions. The second conclusive creation failure can now
be settled through the current tool path. This is a narrow behavioral recheck.

`/private/tmp/lazers-startup-dependent-base-review-20261105.test.ts` then reproduced
a classifier rejection when a child attempt's source includes accepted prerequisite
artifacts and differs from the plan anchor. Existing `runtime.dependencySource`
explicitly constructs that normal source. The legacy classifier's extra
`planBase === attempt.base` condition is therefore not a valid generic invariant;
creation payload/base/attempt bindings still apply. The pure classifier test
returned one failure; it does not claim an end-to-end dependent-worker run.
Delivered through Desktop for the same implementation.

The expanded independent repeated-failure recheck also passed: after two failed
creations and two settlements, explicit continuation created the worktree and
admitted exactly one session/prompt in the original single attempt (ten
assertions). This exercises the complete repeated-recovery admission path in an
isolated Git/SQLite fixture; it is not a native OpenCode product observation.

After the dependent-base correction, both independent rechecks passed together:
the child-base classifier case (one assertion) and full repeated-recovery admission
case (ten assertions). The production-ID allowlist is absent from the current
helper. Broad current checks, final artifact review and native139/141 execution
remain open; these are source/fixture observations only.

## Recovery after coordinator reassignment

Root's `/private/tmp/lazers-startup-new-owner-review-20261105.test.ts` adds a
supported reassignment after the linked recovery creation fails conclusively.
The current same-project Architect then cannot settle it: the lookup requires
the historical recovery authorization's owner/epoch still to be current. The
run returned one failure after six assertions. The command's current-owner and
version checks already authorize settlement; historical operation identity and
fresh execution admission need distinct checks. Preserve stale-caller/callback
fences while proving the new owner's positive settlement/continuation path.
Sent to the same118 review; no production state changed by the fixture.

After the worker correction, the independent new-owner recheck passed: one test,
ten assertions, including settlement and continuation under the replacement
coordinator. This is isolated source verification; native recovery of139/141 and
final integration remain outstanding.

## Delivery priority and coordinator observation

At1793883198876, the native active-session API listed only the118 Luna worker.
Main Architect e568 was present, unarchived and idle. Retained coordinator5920
was archived at1793882713544 and replaced by4229, whose native parent is5920;
4229 was also idle. This was renewal, not a missing-session incident.

Current source already distinguishes invalid/missing owners from valid idle
owners: `ensureArchitectOwner` reuses or creates a native continuation, while
idle renewal uses a default30-minute window with a single plugin override.
The timeout selection is not provider/model-aware. A broader lifecycle
simplification must reuse this existing recovery machinery and queued work,
after overdue product delivery. Root relayed that order through Desktop:
finish the minimum118 blocker, recover the existing trajectory/Models workers,
and deliver visible features before expanding the foundation refactor.

## Combined-source integration verification

Luna completed53cc05d atop4cd3694 and became natively idle. Its branch passed
265 runner tests/3748 assertions and format/lint/types. Root independently
resolved adjacent additions against main in a temporary source copy, preserving
review-input reconciliation, quarantine and retained-work behavior. Integration
restored the record-shape helper required by the new recovery code and removed
a duplicate import. The combined source passed typecheck,61 focused tests and
the full current runner suite:424 tests/5764 assertions across23 files in118.83s.
These checks do not claim actual139/141 recovery or completed feature delivery.
Main reconciled the genuine completed worker review input through the native
control and is awaiting source activation for real startup settlement/resume.

## Native outcome and remaining real defects

Main44e313b integrated the reviewed source. Runtime recorded118 integrated/v43;
Root and Main both observed its native worktree absent, original session retained
and inactive, and134 still active. No forced removal or historical acceptance
reconstruction was used.

Real139/141 settlement then failed. Each original attempt has exactly one
runner_progress row: kind=gap, source=recovery, describing the assigned native
session as unavailable. The blanket progressFacts length check treats that
observation gap as execution. Root isolated the same failure on current main in
/private/tmp/lazers-startup-gap-review-20261105.test.ts, without production
writes. Preserve the gap history while distinguishing actual downstream work.
The separate reviewer also found cleanupWorktrees omits worktree-recovery from
both creation-effect lists. Recovery and eventual cleanup remain unproven for
139/141; no product worker start has occurred yet. Main received both findings
and is coordinating with active134, whose runtime scope overlaps the correction.

## Steering baseline correction

The134 worker started from b682992 before118 integration. Its public tools
repeatedly searched that checkout for the later startupSettlementCandidate
implementation. Root identified the mismatch and relayed the reviewed main
reference and existing reviewedScopeBase behavior through Desktop. Architect
steered the same worker; native tool output at1793884718258 confirmed a clean
advance to37ffe0b while retaining the admitted baseline as an ancestor. No
attempt restart, replacement worker or additional feature task was needed.
Root requested a focused blocker commit before the broader134 notification
work, so feature startup need not await that whole increment.

A temporary Desktop Radar inspection loaded the active Luna/max route and
matching attempt27727aaf, and distinguished the absent141 reserved session as
unavailable. The diagram still uses oversized/truncated cards and dense
relationship details; this observation is not visual acceptance of the planned
agent monitor. Root closed its temporary Radar tab after inspection.

## Real recovery achieved

Luna134's focused0a15077 was integrated byfec1008 after436 workflow tests/5893
assertions and format/lint/types. Its broader notification work continues; no
whole134 acceptance was claimed. The real retry still rejected because
samePhysicalWorkspace returnedtrue for a nonexistent139 reservation versus an
existing quarantined checkout. Root reproduced this directly on actual paths.

Root8d9182f resolves existing ancestors and appends missing path suffixes, preserving
symlink aliases and conservative failure behavior. Three path tests plus a full
startup-next-to-retained-source regression cover the defect.39 relevant tests/592
assertions and fmt/lint/types passed. No production SQL lifecycle writes or forced
cleanup were used.

At1793887191022, native active inventory contained134 and both original139/141
workers. Their attempt IDs, reserved session IDs and Luna/max OpenAI routes were
read back independently. Plans and attempts are running. Initial tools fetched
formatted tasks and began source discovery. This proves actual recovery/startup,
not successful implementation, live feature verification or eventual cleanup.

Their first shared-index reads failed because their current parent Architect c553
had no publication; Main's e568 publication belongs to another owner. Existing
publicationFor selects the worker parent. Root asked Main to have c553 refresh once
and let workers reuse that readonly snapshot. This remains to be read back.

The current owning Architect c553 published d46cbc14-84e1-499e-b1f2-bc0869c57219
at1793887377826. Root independently parsed139's completed native index response
msg_1ac0569bf001UihFdy2TodTK0W: exact same snapshot, root workspace and refresh
timestamp. This verifies shared readonly reuse across that private worktree.141
was notified; its successful reread is not yet observed. Both workers continued
source discovery without restart or an index-admission gate.
