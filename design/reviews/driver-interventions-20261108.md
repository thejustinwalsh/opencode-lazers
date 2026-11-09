# Dogfood intervention review

Goal resumed at Unix 1794182232. Architect builds, reviews, integrates and
cleans up native work. The driver observes delivery, diagnoses failures and
repairs the dogfood system. Driver assistance is not autonomous delivery.

For each intervention, record the task/attempt, observation time, trigger,
action, subsequent behavior and unresolved cause. Treat it as a potential
system failure; distinguish required human authorization from a product defect.
Prefer an existing correction or feature over another overlapping task.
Verify corrections through subsequent native behavior. Message delivery alone
does not demonstrate recovery. Never reconstruct missing measurements as fact.

## Recording check

Read-only SQLite inspection after goal resumption found 1,477 durable progress
records for LZ-181 attempt `4d691f62-10c6-456f-b862-72cf665c4bb6`.
Their event times span Unix milliseconds 1794174681247–1794182244295;
persistence times span 1794174684534–1794182244350. Records include 505 tools,
440 steps, 517 native observations, four execution outcomes and five gaps.
These counts establish recorded activity, not completion or recording coverage.

No dedicated intervention/overhead table was found by table-name inspection.
That does not establish whether existing progress payloads or session messages
capture interventions. Native steering messages are known to have reached the
same worker transcript; attribution and measured assistance remain to inspect.
External Codex usage has not been shown captured by OpenCode accounting.

## Observed interventions to investigate

| Trigger                                                                            | Assistance                                                                | Observed outcome                                                           | Remaining analysis                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| LZ-181 implemented rejected hash/config baseline machinery from stale requirements | Requirement correction and promotion of queued correction to native steer | Same worker consumed correction; rejected draft machinery removed          | Why stale requirements survived; whether ordinary recovery selects urgent delivery correctly |
| Long owned verification setup produced no real worker run                          | Driver took over UI and exercised synthetic Tasks disclosures             | Hold, failed-state filter and activity clicks observed; no real canary run | Setup overhead, ownership transfer and verification-agent guidance                           |
| Driver delegated monitoring/diagnosis back to Architect                            | User corrected role allocation; driver resumed direct inspection          | Architect and original worker both observed running                        | Ensure further interventions resolve causes rather than add coordination loops               |

Historical assistance above is a retrospective summary. Exact elapsed effort,
token cost and intervention timestamps are not inferred from it. Native worker
tests, final commit and integration for LZ-181 remain unproven at this checkpoint.

## Recording repair

The progress recorder's retained-message reconciliation omitted user and
synthetic input text. The two known steering message IDs had no matching progress
rows. Reconciliation now saves public inputs with native message identity and
creation time, using the existing recorder, redaction and idempotent storage.
Instruction-file context and native continuation notes remain excluded through
the existing native-input classifier. Missing creation time stays unknown in the
projected timeline. Input records are not labeled worker output, and their type
does not imply a particular author or a successful intervention.

Validation: 116 progress/native/input/privacy/read tests passed, then 22 recorder
tests and 15 registered-tool/panel tests passed after projection adjustments.
Automatic quality checks pass. This repairs retained reconstruction; it does not
claim immediate live-event capture, complete historical recovery, cost attribution
or native activation. Production data was inspected read-only and not backfilled
by the driver. Current Architect and original worker remained active afterward.

## Native activation and subsequent behavior

`efc0752` repairs worker registration overwriting native permissions with only
delegation denials. Live inspection confirmed ordinary source reads required
approval before the fix. Registration now preserves native defaults, existing
configured rules and delegation denials without accumulating duplicates. The
role test checks configured-rule preservation and replay; automatic quality
checks pass.

After checking active tools and pending worker requests, the driver used the
supported server-wide `location.reload`. The first agent lookup returned
AgentNotFound during re-registration; a subsequent read confirmed LAZERS active
and normal worker permissions. At Unix1794182835792 both updated agent definitions
were effective, the original worker remained running and no permissions were
pending. It subsequently completed grep and read calls; pending requests were
still zero at1794183170964. This establishes recovery of ordinary reads, not
completion of LZ-181.

The two historical steering messages remain available through native message
lookup with creation times1794178689056 and1794178996780. Current context had23
messages and no user/synthetic inputs after compaction, so context reconstruction
alone cannot recover those older inputs. The driver did not backfill production
rows. Durable capture across compaction remains a known gap.

Desktop reported renderer crash code5. Exported logs locate it at19:01:54.402
America/Detroit, before the server reload, with no causal exception in renderer
logs. The driver exported `/Users/tjw/Downloads/opencode-debug-20261109T000921.zip`
and relaunched through the native alert. Computer Use attached to the paused
canary afterward; the driver quit only that test Desktop and reattached to main.
Native workers continued. Main settings still reported inference detach timeout;
no inference flags or model files were changed. Crash cause remains unproven.

Driver message `msg_1bda6484f001tSl2tUpuRiGGt8`, created1794183162285,
reported activated fixes and a concrete LZ-181 test finding: many of56 failures
originated in a fixture expecting acceptance after five synchronous ticks despite
new asynchronous verification. Architect received this for same-worker steering,
not as a new task. Subsequent correction and full-suite success remain unproven.

## Subsequent repairs

`4cf173b` repairs a reproduced inference reconnect dead end after polling and
detachment both fail. The existing backoff can reattach the retained owner after
GPU disposal; no new timer or ownership bypass is added. The fault-injection
fixture failed before the change and passed afterward. Fifteen lifecycle/broker/
lease tests, automatic quality checks and GUI build passed. After native Reload
Webview, Run locally returned `local GPU ready.` with19input/4output tokens;
Ask for decision switched to d1 and returned boolean true. [Live capture](webgpu-live-recovery-20261108.png).
These are real post-activation requests; actual transport-fault recovery is
covered by fault injection, not claimed observed live. Crash cause is unresolved.

The latest worker steering input `msg_1bda6b6330015jiedi67OdUkPh` has a durable
progress row: native creation1794183186604, recorded1794183186667, messageType
user. This confirms new capture without claiming historical compaction recovery.

`29ee18b` consolidates worker startup into `lz-get-task`: readable task, effective
advice, skill summaries and focused Repomix source. The old instructions tool is
removed. The unused packet builder's mandatory-context rejection is removed;
snapshot absence does not reject task retrieval. Tests cover a single registered
worker call, cached content rather than live drift, file permissions, shared
Architect publication across real worktrees, structured reads and dispatch.
Native activation/use and comparative token savings remain to observe. Architect
already has a published snapshot for the current project. Original LZ-181 worker
continues, most recently running its broad retained-verification suite.

At Unix1794184290178, supported source activation confirmed `29ee18b` effective:
LAZERS server/GUI active, worker guidance uses the canonical single fetch, and
the original LZ-181 session remained running. Actual new worker-bundle consumption
and comparative savings remain unproven. The remote-repository research feature
was subsequently submitted through the existing Desktop Architect chat, with
pinned Repomix remote-action source findings and official docs; no duplicate
worker or custom remote-clone service was created by the driver.

Subsequent observer discovery failures were rechecked against the same service,
not treated as terminal. An authenticated `/api/info` request returned HTTP200
in3ms for existing PID1754/version2.2.6. A later normal observer call recovered:
Architect was actively reading remote/context integration code, and original
LZ-181 worker was patching retained-reverify.test.ts. This shows continued work;
it does not establish why the earlier discovery probes failed or prove the
remaining test failures resolved.

## Native single-fetch use and parallel remote-source feature

Architect submitted LZ-193, task1f8714b6-38d5-42da-8347-39ffc513c813,
and started plane8bf7885-fd38-4170-8ce6-cbb1d68cb2c4 through native controls.
The new worker ses_dd92813879ab4e0da0f5d1c8b5a197d4 started at
Unix1794184771769 and uses OpenAI gpt-6-luna/max. It ran concurrently with the
original LZ-181 worker; neither was replaced by the driver.

Its first completed Code Mode call, msg_1bdbef93c001haDoyWUCxmtBOb,
returned a7160-character readable task bundle: objective/acceptance, guidance,
verification, references, optional skills, and cached source context for
src/context/index.ts, processor.ts, tools.ts and src/index.ts. Source included
focused original lines and compressed outlines. This proves live consumption
of the consolidated startup path, not measured token savings or completion.
Subsequent direct source reads proceeded normally. Both workers remained active
at the next native session observation. Remote-source implementation, real
upstream probe, acceptance and integration are still pending.

## Radar acceptance/integration gap observed during parallel work

Opening Project Radar while both implementers were natively active showed
`[object Object]`, no operational rows and a Refresh action; Refresh reproduced.
[Desktop capture](radar-project-overflow-20261108.png). The authenticated location
lookup succeeded. Calling Radar with its actual scoped session input reproduced
rpc.internal; service logs at2026-11-09T00:42:50Z and00:44:06Z disclose the cause:
`Observation scope is too large; narrow it`, also from snapshot. Main panel still
uses the legacy readers. This is not a worker execution failure.

Read-only task inspection located the existing remedy: LZ-184 plan
ebea76ad-f3bd-4f6b-9d3f-1e356e032b9c,
accepted attemptacb55d57-bd3e-42fe-8459-42a97309f2fd/artifact
89edd14b0cadad49b8b3cb84d733ce56ff82f549. Its plan is blocked on the authored
connected-radar-agent-monitor:human live acceptance, not integrated. Its task
already requires legacy-fails/live-succeeds and readable RPC errors. Driver
reported the actual defect through Desktop and asked Architect to finish that
existing product acceptance/integration path while preserving181/193. No cap was
raised, acceptance recorded, or new duplicate task created by the driver.

## Early LZ-193 rejection-gate steering

While the original worker was actively writing LZ-193, driver inspection found
its first repo-processor.ts draft rejected more than20 path patterns or5000
files, and rejected the whole result when Repomix skipped any size-limit file.
The product ask called for useful one-call compressed research; it did not supply
those count limits. Treating an upstream omission as a complete tool failure
would reintroduce the rejected narrow-and-retry interaction. The task's bounded
response wording did not justify those implementation gates.

Driver reported the concrete draft behavior to Architect through Desktop and
requested same-worker steering: useful returned source and saved artifact,
explicit omissions, and resource handling grounded in actual transport/memory
constraints. No new task, stopped worker, or System One change. At the next native
observation Architect was researching that exact draft and the same worker was
still writing. The same worker subsequently received native user input
msg_1bdca3f6d001hiq44jRVDw0V5n at Unix1794185534829 with the concrete correction
and resumed its model turn. Subsequent source inspection confirmed removal of those count gates and whole-result
size-omission rejection. The worker now streams produced source into the retained
artifact and records skipped-file reasons. Executable and native behavior remain
unproven until its tests and real upstream call finish.

## Delivered Radar native interaction after source landing

Architect composed/reviewed the retained Radar source and landed it asbd2896d;
its composed checks passed206tests/1747assertions, quality and GUI build. The
reviewer's earlier primary-wiring concern was explicitly retracted after exact
tree inspection; it must not be treated as a product defect. Delivery was the gap.

Driver found the live monitor already visible in main Desktop after landing.
Command search was opened and escaped; no extra reload command was executed.
Project view showed connected updates and both original Luna Max workers with
correct task/attempt associations. Selecting LZ-193 exposed15recent tool calls
with durations; current patch calls had requested-file targets. Selecting
src/context/repository-snapshots.test.ts updated the lower Selected call detail.
[Actual selected-worker capture](radar-live-worker-20261108.png). Observations
were relayed to Architect through Desktop for its existing acceptance flow.

This resolves the observed legacy-reader blank default view; it is not full
layout/reconnect/history qualification. Raw IDs, noisy coverage labels and
unavailable historical rows remain visible polish issues. No narrow/short-size,
divider keyboard or scroll-stability claim is made. Both original workers kept
running; no additional inference or fixture was launched for this observation.

The subsequent native Radar walkthrough exercised keyboard Up/Down on the
focused divider (split value changed with focus retained), expanded LZ-193
history and loaded older records (30to40returned), switched to Session scope
(exactly1returned Current Architect) and restored Project activity. Driver
reported these observations through Desktop. No server disconnect or worker
interruption. Narrow/short dimensions, independent scroll retention and
reconnect/reset remain unobserved; no full qualification claim follows.

## Approved isolated verification authentication completed

User explicitly approved isolated OpenCode access and ChatGPT test usage. Driver
renewed the expired OAuth attempt through that existing instance's native
integration API and opened its returned OpenAI URL in Chrome. OpenAI displayed
Authorization successful. A native integration read confirmed one OpenAI OAuth
connection labeled LAZERS owned verification in root
lazers-full-instance-9TcU4T. No main credentials were copied or provider settings
changed. No screenshot containing the callback authorization code was retained;
the completed browser tab was closed.

Driver handed the existing service, paused probe agent and retained fixtures back
to Architect through main Desktop, explicitly yielding isolated-window ownership.
Its Desktop had previously been quit; reopening and candidate refresh/qualification
remain native probe work. No model test was invoked by Driver during sign-in.

## LZ-181 remaining failures traced to missing canonical repair

The retained suite reached60pass/2fail. Comparing exact source showed main's
4abb300 retained-repair admission helper was absent from the original worker
runtime: main invokes retainedRepairAttemptAccepted, while its worktree still
requires attempt.state accepted. The newer failed-history tests were present.
The worker's public progress report treated this as a separate guard to preserve;
older coordination input had requested incorporating the existing fix but had
not resulted in that source change.

Driver reported the precise source discrepancy through Desktop and requested
same-worker reconciliation of existing4abb300, including its atomic recheck.
This is integration drift, not justification for weakening tests, changing the
acceptance policy or adding a task/gate. No worker source or production DB was
changed by Driver. Delivery and post-correction results remain to observe.

## Native steering admission blocked the completed LZ-193 handoff

LZ-193 delivered5acc7fb with24context tests/191assertions and a reported actual
GitHub fetch/reuse probe. Runtime then held it on unknown native background,
not test/hash failure. Its genuine idle callback recorded zero background at
Unix1794187189488, followed by idle-lineage-unavailable for current steering
inputmsg_1bde053ff001Esip43JUMxyo4g and native success sequence1559. The input
was already durably captured under attemptc49fbc65-db5c-44ca-bd42-e142dca7fb09.

Exact source identified a narrower defect than a generic stream-gap hypothesis:
ProgressRecorder.matchesAssignedInput recognized only the original prompt and
admitted progress reminders, rejecting captured user/Architect steering. Driver
reproduced that producer failure in a native-hook regression before fixing the
shared matcher. It now recognizes trusted captured native user/synthetic input
rows bound to the same session/attempt/project; worker commentary and instruction
context do not qualify. Current-input, attempt, location and terminal observations
are unchanged. One older negative test called an actual same-session user input
wrong; it now exercises instruction-only context, while new positive steering
and foreign-session/attempt tests cover the intended distinction.

Quality and102recorder/native/idle tests/787assertions pass. Source activation
and recovery of the actual held193 attempt remain to observe. No durable idle
report was fabricated or production DB edited by Driver.

## Follow-up: native recovery and Desktop input loss (2026-11-09)

Architect reviewed and activated f27cc71. Its retained native transcript at
Unix1794188155983 reports that LZ-193's fresh idle handoff succeeded. The existing
candidate then reached broader checks and repair; this proves recovery past the
idle association defect, not final task acceptance or integration. LZ-181's
original worker and the owned-instance verifier remained active.

At approximately 01:44–01:48 UTC, Driver attempted to relay the user's OpenRouter
clarification through main Desktop. Composer click/paste and accessibility value
assignment left it empty. Read-only transcript and inbox checks found no submitted
correction, so delivery was not credited. The accessibility body also lost most
message content and the local inference indicator showed Error. Driver used the
native View → Reload action for the renderer only; backend sessions remained
running. Recovery and cause remain unproven. No GPU setting, model route, service,
worker or task state was changed. A process sample showed the main renderer at
56.9% CPU and service at19.2%; this single sample does not establish causality.

View Reload left a blank renderer. Driver captured a three-second stack sample
at /private/tmp/lz-renderer-20261109.sample.txt, then used OpenCode → Restart.
The relaunched main Desktop restored editable composer input: Driver observed
the full correction in the field before Return, then the submitted user bubble
and empty composer. The local model indicator resumed Loading. Backend workers
were not stopped. This establishes UI/input recovery, not the root cause or GPU
qualification. Earlier failed submissions were not resent until their absence
was confirmed in both transcript and inbox.
The sample is retained as renderer-reload-stall-20261109.txt.gz beside this log.
It reports a3.4GB physical footprint and9.6GB peak; symbolication does not identify
the JavaScript source responsible, so no particular plugin component is blamed.

The separate user-requested Sol audit found durable tool history limited to
assigned workers and missing distinct Code Mode inner calls. Its pre-change
findings are in tool-call-failures-20261109.md. The proportional hook/guidance
repair is being implemented separately; no native activation is claimed yet.

## Owned reopen: existing process log prevented launch

The same native verifier exercised9d367b0 and recorded an EEXIST failure before
spawn: SystemLaunchDependencies.launchDesktop opened desktop-process.log with
exclusive creation, although a previous launch retained that file. Root's earlier
mock lifecycle tests did not exercise real log allocation. Service25100, account,
fixtures, candidate and old output were preserved; no replacement instance was
created. Receipt: lz182-review-recovered/.cache/review/
native182184-main9d367-reopen-failure.json in the sibling worktrees directory.

Driver corrected allocation to create a unique exclusive process log on each
launch. A real-filesystem regression allocates two reopen logs alongside an old
log and confirms all three contents survive independently. Quality passes;
33owned-lifecycle tests/180assertions pass. Native reopen and product walkthrough
remain to observe after Architect resumes the same verifier. No worker code or
production DB was changed for this repair.

Follow-up native execution: main e3077d4's supported reopen command succeeded at
2026-11-09 01:58:51UTC, retaining root9TcU4T and service25100, and recording
Desktop55511. The native bridge returned the existing verification-only canary
and its four disposable tasks. Root opened the actual State menu (Open, Queued,
Running, Blocked/waiting, Completed, Failed/exhausted, Cancelled, All) and changed
Failed/exhausted to Completed. The empty completed list matched the fixture's
lack of completed work; this does not qualify completed-row navigation.

Later input was refused because the owned window was not focused, even after
focus plus a fresh snapshot. Snapshot confirmed the filter remained Completed;
no uncertain input was replayed, fixture work dispatched, or probe accepted.
The supported launcher defect is recovered natively. Focus reliability and the
full Tasks/Radar walkthrough remain open. The bridge snapshot is retained only
in ignored .cache/driver/owned-current-snapshot.json; no full product completion
is claimed from this fixture interaction.

Main Desktop coordination follow-up: repeated paste left the composer unchanged,
but native typeText inserted a concise correction, which was verified in the
field before Return and then in the submitted user bubble. Architect resumed
and received373e296 plus the successful owned reopen result. Prefer verified
typing for now; the paste-specific failure is not proof the entire renderer is
frozen. No additional restart was needed for this recovery.
