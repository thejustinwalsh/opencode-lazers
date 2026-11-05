# Original LZ135: repair real native timestamps first

Root reproduced a live-shape defect: `src/progress/native.ts` passes native context
directly to `reconcileMessages`; Effect DateTime timestamps have a non-plain
prototype and the recovery fingerprint encoder rejects them, bypassing warm memos.
`/private/tmp/lazers-recorder-native-time-regression-20261105.ts` produced append
attempts `[3,0,0]` for numeric timestamps versus `[3,3,3]` for identical native
DateTime passes. Architect rerun at1793857664575/610 reproduced both sequences
using disposable fixtures, without production writes.

Repair this in existing135's original worker/tree/attempt, within `recorder.ts`
and its tests. It takes priority over the broader diagnostics proposal and needs
no `native.ts` edit or127 reservation release. Do not introduce counters/RPCs or
change99/133/127 scopes or priorities to solve it.

Recognize supported real native temporal values safely and fingerprint their
legitimate timestamp semantics stably; changed timestamps must not reuse stale
facts. Use the actual installed Effect API and existing recorder timestamp
semantics, not arbitrary `toJSON`, prototype flattening or a general non-plain
object exemption. Preserve the conservative unsafe-object/cyclic/getter fallback.

Add a discriminating native DateTime regression that fails on current source,
warms once then avoids repeated unchanged per-message append work, including fresh
instances representing unchanged native time. Changed/native late timestamps and
new/late facts must still project correctly; existing unsafe-input, numeric replay,
multi-session/revision/reopen and recovery tests must remain meaningful. Keep
legitimate UTC/zoned semantics consistent with the recorder, and distinguish real
native values from unsafe lookalikes. Do not waive assertions for a green counter.

Run the registered recovery/quality checks, commit the scoped correction and report
the exact artifact/results. Root will activate at a coordinated boundary and
remeasure actual native recovery afterward. `native-performance:human` remains
held: the earlier30.92%→30.16% CPU comparison is inconclusive, and a fixture pass
alone is not native qualification. No certificate prompt or ownership transfer.

## Installed API findings delivered during the same repair

Luna's read-only check found Effect4.0.6: public DateTime is UTC or Zoned, both
with epoch milliseconds. `isDateTime` checks the presence of `~effect/DateTime`;
it is not an authenticity check, and `toEpochMillis` directly reads the epoch
property. Guard unsafe lookalikes/accessors, while preserving legitimate native
host instances; exact prototype identity across module instances is not proven.
Do not blindly turn a conservative prototype suggestion into another native miss.
Test UTC/zoned equivalents, changed instants and late native fact retention, not
just same-instance repeats. No dependency source or production data was changed.

This advice was delivered/read back through native instruction context at
1793858041682, key `lazers.review.lz135.datetime-public-api-and-fallback.20261105.v1`.
The original worker's assigned input remained
`msg_b86cf7dcc9af417abb54ebf23481fe6c` before/after; no extra prompt was sent.
Consumption and final correction are not yet verified. Existing symbol-key handling
is a separate boundary to document/test rather than silently broaden in this fix.

## Proportionality review: supported semantics, not a private validator

Root's draft observation found roughly110 lines inspecting private Effect
DateTime/timezone prototypes and caches. Prefer the existing supported timestamp
semantics and small correct normalization; the brand-guard research is not an
authentication requirement or justification for a private Effect validator.
Preserve unsafe-object fallback and meaningful payload/time changes without adding
an unrelated security gate. Acceptance remains native warm reuse plus correct
changed/late facts, followed by Root's actual native qualification.

This advice was delivered/read back through instruction context at1793858848152,
key `lazers.review.lz135.proportionate-supported-timestamp-semantics.20261105.v1`.
The original assigned input stayed `msg_b86cf7dcc9af417abb54ebf23481fe6c`; no
prompt or worker mutation occurred. Independent Luna provisional draft review is
running as `ses_e55aeb8cbffeBEO3CpWmM70vZe`; no final source clearance is claimed.
Root observes c10 idle with an empty inbox and only original99/135 implementors
active; preserve them and133's queued repair. No new owner input was sent.

The provisional Luna review found a semantic risk: recursively normalizing every
DateTime in the retained message tree can hide a non-timestamp payload change.
Limit normalization to supported timestamp positions consumed by the existing
projection semantics, or prove that other occurrences cannot affect durable facts.
Keep conservative fallback elsewhere; add a discriminating non-timestamp DateTime
case alongside the useful native UTC/zoned, changed/late, getter and cycle cases.
Do not couple product correctness to tests of private Effect marker acceptance.

These provisional findings were delivered/read back at1793859125087, key
`lazers.review.lz135.non-timestamp-datetime-and-proportionality.20261105.v1`.
The assigned input stayed unchanged; no prompt or new scope/gate was added.
The review ran no tests and was not a final-artifact clearance. Final source
correction, checks and native remeasurement remain outstanding.

## Committed candidate and remaining native proof hold

Original135 committed clean candidate
`374a5997d665ad13d7eb3828933e2b3e09b1ce13`. Native shell message
`msg_1aa5af9d2001Cs0f5Ot9IXTkGu` confirms the exact recovery suite exited0:
69pass/0fail/660 assertions in11.96s; `msg_1aa5aac74001QswlRB7n4W7nsC` confirms
`bun run verify` exited0. These are worker check results, not runtime acceptance.

The Architect ran the Root-shaped disposable probe against that exact worker
recorder: numeric timestamps `[3,0,0]` at1793859672290; Effect DateTime `[3,0,0]`
at1793859672313. No production data was written. Probe:
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lz135-final-candidate-native-time-probe.ts`.
This addresses the demonstrated representation-specific miss at component level,
not live plugin performance acceptance.

Authenticated SDK1793859562007 reports the original session succeeded, idle at
1793859547774, with no pending permissions/forms. One supported fresh-terminal
reconcile atversion16→17 still ended blocked atversion18: native execution success
does not match the current `experimental.idle` execution. All six effects are
completed, none pending/uncertain; the new artifact has not entered ordinary
runtime verification. Preserve that unknown proof; no repeated unchanged reconcile,
certificate prompt, replacement or fabricated idle was used.

Independent final-artifact Luna review `ses_e55a2bb57ffeCH4USt7r0t1031` is running.
Final source clearance, native completion proof and Root's actual post-activation
recovery/performance observations remain separate outstanding requirements.

### Root integration and observed live listener replacement

Root merged `374a599` as `26f0825`; post-merge recovery69tests/660 assertions,
lint and types passed. Independent final Luna review confirmed timestamp-position
restriction and changed/late/unsafe-input coverage. It still flags manual Effect
prototype/tag/descriptor validation at `recorder.ts:237–265` as a proportionality
concern. Keep that advice visible without inventing an additional acceptance gate
or waking the finished worker for a certificate turn.

Root identified concrete live proof loss:135 recorded a genuine idle-entered
hook with backgroundCount0 at1793859547643, followed by idle-lineage-unavailable
at1793859547760 for current input `msg_b86cf7dcc9af417abb54ebf23481fe6c`, start1455.
The worktree listener changed from `d9633764` at1793857963626 to `a48b967b` at
final idle. `runner_native_idle` retained the old start7/input118166 report; new
success2860 invalidated it. A zero hook alone is not a historical replacement
certificate. Investigate supported host identity/lifecycle APIs first, then safe
preservation of genuinely live lineage across replacement within existing native
progress/127 follow-through; cold/gapped/missing-start states must remain unknown.
Root coordinates canonical activation only when workers are idle.

Root subsequently resolved the remaining source-review proportionality advice in
canonical `934c03b`: private Effect prototype/tag checks were removed, retaining
the supported DateTime guard, safe data-property reads, `dateMillis` and timestamp
slots. Root reports recorder20tests/375 assertions, lint/types and the original
numeric/Effect `[3,0,0]` repro passing. No additional135 worker repair turn is
needed. Continue only real listener-lifecycle investigation and the native
performance gate; timings and proof-loss facts are recorded separately in
`design/reviews/native-completion-blockers-20261105.md`. Listener replacement's
trigger remains unproven; do not assume the observed local-map loss explains why
replacement occurred or grants historical proof.
