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
