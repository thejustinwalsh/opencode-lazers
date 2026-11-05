# Pinned host retention and retained-candidate completion

Read-only native Luna Max research `ses_e554abce2ffepW80B70Gm20QSC`, pinned OpenCode
2.2.5 commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`. Real server.info confirmed
2.2.5, PID95968; no service/config/state changes were made for this investigation.

## What the source and actual host establish

- `packages/core/src/bus.ts:187–208` defaults event payload persistence off.
  Lines397–431 advance `event_sequence` independently of optional `event` insertion.
  Lines786–884 read retained payloads then emit log.synced from the sequence table.
  `packages/core/test/bus.test.ts:281–299` explicitly covers sequence0 with no
  retained event row. Thus a sync watermark does not prove replay history exists.
- `packages/server/src/routes.ts:124–128` passes `options.events?.persist`;
  `packages/cli/src/server-process.ts:101–145` omits events. Persistence is a server
  construction option (`server/src/options.ts:21–25`), not ordinary OpenCode config
  (`schema/src/config.ts:26–117`). Embedder/workerd may enable it. A future opt-in
  would not backfill absent payloads. No routine log-pruning limit was found;
  aggregate removal and state-reset migrations are separate deletion paths.
- Root's completed137 and active127 public log probes returned no events plus
  log.synced, including explicit after0/after1. Raw authenticated GET returned200
  text/event-stream with only that marker: not SDK filtering. This is strongly
  consistent with the stock default-off path, but the actual process construction
  option is not exposed by server.info and was **not proven directly**.
- Actual header-only probes exported no bodies. Session metadata contained only
  lazersAttemptID; assistant native keys only responseId/serviceTier. These
  observed session/message surfaces expose no exact execution-start sequence.

## Supported identity and limits

`session.execution.started` supplies exact `durable.seq` but only sessionID in its
data (`schema/src/session-event.ts:244–247`). Public `ctx.event.subscribe` observes
it live only (`plugin/src/effect/event.ts:6–10`, `core/src/plugin/host.ts:266–282`,
`core/src/bus.ts:126–130`). Fresh idle contains only sessionID/background; current
input ID is a separate public read, not an atomic native start/input tuple.

When a listener missed the start and payloads were not retained, the inspected
public APIs cannot reconstruct it. Do not infer it from timestamps, message order,
sync watermarks, private DB reads or a proof-only worker turn. Keep historical
completion and cleanup evidence unknown. Preserve useful replay code/tests, but
do not claim it repairs native recovery on this stock host.

## Delivered LZ127 code

Original127 produced accepted artifact `af6dd111b8e33940cf03f51205cdc1bfb59fe533`.
Independent review `ses_e5546f0aeffeVg5LUEi27cLgrr` found no scoped code-correctness
blocker: realistic created→start→inbox→sync→genuine-idle→success repro passes and is
permanent at progress/native.test.ts1068–1169; empty/malformed replay remains
fail-closed; validated cached native transport is reused. External repro1 test,
focused82 tests and typecheck pass. This is source review, not a working native
recovery observation on the actual zero-payload host. Original artifact/work and
history remain preserved; no deployment is claimed.

## Proportional roadmap outcome

The user directs reuse of the existing retained-verification lane and current
owner, not ownership transfers or replacement tasks. Fold in Astra's review
`/private/tmp/lazers-astra-lifecycle-coupling-review-20261104.md`:

1. Candidate correctness comes from ordinary required tests and live probes bound
   to an exact committed candidate. Neither hash identity nor old idle proves it.
2. If old writer exclusion cannot be established, verify in a runtime-owned context
   actually isolated from the old checkout **and shared mutable resources**. A new
   Git directory alone does not isolate a profile/service or an old child process.
3. Preserve old execution, uncertain-effect receipts, reservations and cleanup.
   Fresh independent checks must not overwrite or certify unknown old checks.
4. Use existing LZ57 accepted-work repair and LZ58 zero-turn retained verification.
   Fresh read finds both cancelled with zero attempts in plan `d0ce36bb`,version16,
   owned by `ses_c59b85e3559c47a8a6f8191eb3b47eae`; Astra's queued state is historical.
   Research their current admission and the supported amendment needed for58's
   existing no-worktree assertion; do not silently contradict immutable specs.
5. Regression: lost historical lineage plus safe isolation can reach normal checks
   and acceptance while old cleanup remains blocked. Shared active writers cannot;
   failed checks still fail and late old results cannot accept a newer candidate.

This is an authorized plan outcome, not a prescribed patch or permission to weaken
resource guards. Current eligibility and proportional decomposition are under
read-only investigation in the existing lane.
