# Native log replay boundary — 2026-11-07

Root tested the existing public session-log API read-only for original174.
Both omitted `after` and explicit `after:0`, with `follow:false`, returned zero
events and one synced watermark at4051. No event bodies were printed or replayed
into LAZERS storage. Explicit cursor zero does **not** repair the missing history.

The installed Desktop service is2.2.6; LAZERS remains pinned to the2.2.5 client.
Primary2.2.6 source confirms:

- [Session.log](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/session.ts)
  forwards `after`/`follow` to Bus.log, then filters to durable session events.
- [Bus](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/bus.ts)
  defaults `persist` tofalse in `configured`; its exported default node uses
  that configuration. Sequence advancement is distinct from retaining event
  payloads. A source configuration default is not proof of every live override,
  but a synced watermark alone cannot establish available replay history.
- The installed plugin API's `experimental.idle` contract states that it runs
  before successful idle and supplies actual remaining background work. Inputs
  admitted by the hook continue in that execution. It does not run on failure,
  interruption or manual compaction.

`src/progress/native.ts` additionally requires a current module/live-peer start
witness or a successful historical-log replay before persisting the hook report.
After replacement, a real hook can therefore reach `idle-lineage-unavailable`
despite a stored start sequence and an actual background list. This boundary
needs a focused lifecycle review against native hook/execution semantics; it is
not permission to invent past zero counts, remove current-input checks, or
reinterpret old failures as successful completion.

The175bootstrap repair deliberately leaves idle capture unchanged. It qualifies
the exact committed repair in isolated resources while retaining original
background uncertainty. Do not fold retrospective idle reconstruction into175
or add another proof-only implementation turn.
