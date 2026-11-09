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
and resumed its model turn. This proves input consumption; changed behavior
remains unproven.
