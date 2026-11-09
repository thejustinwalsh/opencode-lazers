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
