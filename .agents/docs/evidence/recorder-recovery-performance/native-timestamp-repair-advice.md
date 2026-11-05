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
