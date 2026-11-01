# Architect lifecycle implementation evidence

Task: LZ-28 (`239f45a9-3247-4cba-b339-19c8267d0800`). This records automated
implementation evidence only; it is not native Desktop dogfood or acceptance of
the live-session behavior.

## Retained-candidate finding and reconciliation repair

Review of retained candidate `e127d1a5836b65ca6d89dd19974f94249e9df1ed` found
that queued synthetic input (`resume:false`) can bypass the prompt hook and arrive
after the last inbox check. Candidate `8c8f86c` failed closed, but did not deliver
renewal and is not accepted. The current candidate replaces that assumption with
the user-approved retain-and-reconcile protocol. It registers the predecessor
source before native effects, journals inbox/history input IDs and dispositions,
transfers source responsibility with plan ownership, archives through the pinned
public client route, and requires archived-state readback. Original queued inputs
remain on the predecessor and are referenced—not copied—to the current owner with
`resume:false`. A lost/negative archive response leaves transfer state recoverable
without restoring predecessor authority. Previously observed queued rows that later
disappear without a transcript are marked unknown, not cancelled.

The Architect now explicitly records current conversation-only decisions and
unresolved questions. The structured checkpoint is persisted by project/session,
versioned, snapshotted into renewal state and the durable handoff, and included in
the successor wake without transcript replay or inferred summary. The tool is
restricted to the current Architect owner; the new database column migrates
existing stores safely.

## Automated lifecycle coverage

`src/runner/runtime.test.ts` covers the default 30-minute threshold, a configured
override, reuse before the threshold, and busy-session reuse. It asserts one
successor with the predecessor parent link, preserved model/variant, a labelled
small handoff, exact wake-text byte count with token/cache usage left unknown, and
worker sessions continuing unchanged. It also covers a shared successor for all
plans owned by one Architect and concurrent schedulers.

Deterministic races cover prompt input before transfer and queued synthetic input
after successor creation, after durable transfer, during archival, and after the
predecessor is archived. Tests assert unchanged original IDs/inbox rows, source
references with `resume:false`, no ownership rollback, no repeated notification,
and persistent paginated cursors. Two schedulers and process reopen exercise a
transferred source with late queued input. An archive failure remains visible and
retries the same successor without restoring old ownership. Existing cases cover
an outcome before transfer, an outcome admitted during archival, successor input,
unchanged workers, and explicit continuity across reopen. A retired predecessor
cannot reclaim a transferred plan through `reassign`, while the current owner can
still deliberately reassign it. Native adapter tests exercise the public archive
route/readback and paginated message-list contract using injected client responses.
The pinned OpenCode 2.2.5 message handler rejects `cursor` combined with `order`;
the adapter regression enforces that constraint, checks the ascending first-page
request and confirms cursor pages rely on the order embedded in the cursor. This
does not substitute for live-host evidence.

The retained-source review corrections also cover cancellation interrupting
workers while archival recovery continues to fail; continuity checkpoints bound to
the observed user-input IDs they cover; later plan admissions included atomically
in the successor transfer/handoff across concurrent schedulers and reopen; source
and recovery lookups isolated by canonical project in a shared database; and late
or mutable assistant/tool results referenced by safe IDs, revisions, status, and
aggregate tool counts only. No tool arguments, outputs, reasoning, or transcript
bodies enter successor references. The artifact-specific resumed-commit receipt
selection from `2536084` remains present in `runtime.ts` and its regression.

The final retained-source regressions also make cancellation advance while both
archive recovery and predecessor-history reads fail, and require each complete
pre-transfer preparation sweep to reach its last history page before ownership can
move. A user input found only on page three invalidates the uncovered checkpoint
before successor creation or predecessor archival; pagination cursors are checked
for cycles rather than silently looping.

`src/runner/store.test.ts` continues to cover legacy database migrations for
continuity and the old unique continuation-session constraint.

## Verification run

On reviewed merged source candidate `f6b0978` (including renewal repair `7f47913`):

- `bun test src/runner test/runner test/architect-lifecycle` — 165 passed, 0 failed across 15 files.
- `bun test` — 474 passed, 0 failed across 84 files.
- `bun run verify` — all 435 files formatted; lint found no problems in 210 files; typecheck found no errors in 202 files.
- `git diff --check` — passed.

## Still required: exact-artifact native dogfood

No live Desktop observations are claimed. Root must verify the exact committed
artifact against real sessions for busy reuse, idle renewal, visible predecessor
archival, late input/outcome reconciliation, current-owner routing, and unchanged
worker sessions. Wake bytes are measured from the exact handoff text. Wake-attributed
tokens and public cache read/write categories remain unknown until a native public
observation provides them; cumulative session totals are not wake-attributed, and
no cache hit or savings claim is made. Therefore native-dogfood acceptance remains
unresolved.
