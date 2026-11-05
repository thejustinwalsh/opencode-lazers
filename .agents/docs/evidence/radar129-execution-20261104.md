# Original LZ129: post-Astra bounded-live execution

User released the quiet hold and authorized nonoverlapping native execution.
Reuse original task `91c6c95d-9965-421f-9b35-49da50f84979`, revision1; no clone or
immutable specification rewrite. Its earlier planning-only wording refers to the
earlier request, not this later execution authorization.

- Plan `243f8093-7c3c-44e3-bda5-e06870e4f680`, priority1790, native isolated mode,
  Systems persona, inherited exact implementor `openai/gpt-6-luna` / `max`.
- Baseline `f06a65ebc0aba37e0c9204a86677973651f8efdd` contains integrated8aed4ea
  plus roadmap/evidence only. Snapshot2444bdbb as-of1793832975691 includes that
  baseline. Later authoring notes are not claimed present in that snapshot.
- Original attempt `58d8d699-6a12-44c3-a5af-954b2b5564bc`, worker
  `ses_aeff3e9ac5d24c6c944d35e31b050963`, started1793833121829. Actual native
  worktree is the runner-owned directory ending in that attempt ID.
- Initial inspection observed native permission wait; a subsequent exact worker
  read found zero pending requests. Architect changed no permissions or task state
  to clear it; don't confuse the transient plan hold with source failure.

## Research and delivered guidance

Native read-only researcher ses_e573b2b2effeEr2hfbaySt640k confirmed129's outcome
unfulfilled after Astra. Existing registered contract exposes only legacy reads;
read197–425 examines history before selecting5001rows,538–752 resolves retained
session associations, and Radar state130 still requests legacy Radar/lifecycle.
Landings optimize those paths but do not supply bounded source work or a live API.

Reuse rpc56–86 authorization before reader/cache access, metadata-only inventory,
safe progress export and exact session assignment. Do not blindly reuse change
stamp changes23–44 (historical associations) or trajectoryHistory read1817 (native
context). Recovery journal constructor/page/advance mutates; any useful journal
access here is read-only indexed SELECTs with explicit legacy coverage. Missing
Architect/unassigned telemetry stays explicit; no context fallback.

No direct write-scope intersection with Root's runner bootstrap or131 backend;
adapter/tracker/schema-initialization changes remain outside129's original scope.
If indispensable, amend the original task narrowly under runtime authority—never
silently expand or create a duplicate. No file preview ingestion, runtime controls,
GUI build/activation, profiling, restart or settings change belongs to129.

Keyed native instructions `lazers.architect.radar129.after-astra.20261104.v1` were
put and read back at1793833267131 after exact project/agent/attempt/location checks,
with identity rechecked afterward. This adds readable context, not a new turn or
proof that the worker already consumed it. The1854-character guidance contains the
research pitfalls, unchanged safety boundaries and corrected compatibility paths.

## Verification boundary and known plan-path mistake

Original task checks remain:

```
bun test src/observability test/observability src/progress
bun fmt --check && bun lint && bun check && git diff --check
```

The added plan compatibility command mistakenly names two nonexistent
`test/radar/{transport,state}.test.ts` paths; Bun can skip them while running the
other supplied paths. **A green command cannot establish their coverage.** Preserve
the record, do not fabricate paths or claim waived coverage. Delivered worker
guidance and independent source-review checks require the actual files instead:

```
bun test src/radar/transport.test.ts src/radar/state.test.ts test/trajectory-panel src/trajectory/privacy.test.ts
```

Retain actual output for that correct command on the delivered candidate before
integration. Registered RPC→actual reader tests must establish examined-work/native-
call/byte/retained-state limits, zero context loads, authorization including cache
hits, terminal enrichment/concurrent calls, cancellation/reset/scope races and
privacy/foreign decoys. Source/fixture acceptance does not complete later Radar B
consumer/Desktop narrow/wide/Tera gates. No implementation check has run yet in
this evidence note.

## Approval-only outcome reconciled, original work preserved

The native outcome reported planv10 blocked on six permissions/zero forms. At
1793833410343 an exact project/agent/attempt/location-bound native read instead
found **zero pending permissions, zero forms**, unarchived session and running
native execution. No permission replies or policy changes were made.

Compact inspection showed all three effects complete, no pending effects and no
reviewable candidate/checks. Allowed audit retainedv10; then allowed reconcile
advanced tov11. Follow-up inspection confirmed **plan and original node running,
reason null**, same58d8d699 attempt/session/worktree and three completed effects.
No retry, cancel, replacement, source mutation, effect replay or acceptance override
was used. This resolves that recorded hold, not implementation acceptance or proof
that future permission observations cannot recur.

## Root's actual connected Desktop observation

Root observed Project Open show129 **Running without Start**. Open trajectory
selected original LZ129 correctly, with **one attempt / 55 tool calls / updates
connected**. Actual native API routes were Architect
`openai/gpt-6.1-sol#high` and implementor `openai/gpt-6-luna#max` in its correct
owned native worktree. This is Root's live observation, not an inference from
fixtures, usage or task state. No backend attempt end is supplied or invented;
131 retains that boundary. Keep original129 cooking. Root candidate stays offline
while workers are active, independently of its remaining source-review blocker.

## Source findings and scope steer

The user requested review of long research intervals without treating elapsed time
as failure. [Concise task-linked guidance](radar129-source-guidance-20261104.md)
retains observed public activity, the let-continue decision and three actual source
findings. Selected history remains a small separate persisted-observation read in
the original129 boundary, not complete native conversation history or a UI rewrite.
Immutable task/acceptance and original worker are preserved.
