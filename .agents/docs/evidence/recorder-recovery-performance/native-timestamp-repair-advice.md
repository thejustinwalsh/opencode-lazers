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
