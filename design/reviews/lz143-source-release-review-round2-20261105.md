## Result: one proportionality blocker remains

**Inspected `fdadbf371d12549e6a87dffc47f53dc6bfa97df0`**, clean at both checks. The exact delta from `71fbf4a` touches only `src/runner/runtime.ts`, `src/runner/source-quarantine.ts`, and `src/runner/runtime.test.ts`; native/archive and guard-lifecycle code is unchanged.

### Admission await gap: addressed

`runtime.ts:1616-1631` now rereads and validates the current owner and worker after the worktree and guard awaits. The transaction still rechecks plan version, owner, assignment, and installed guard (`:1679-1684`, `:1703-1721`). The new barrier tests mutate input, tag, route, and owner at both await points and assert no quarantine or plan mutation (`runtime.test.ts:1147-1183`). This closes the concrete admission gap I previously raised.

### Sealed fast path: retract the source-write concern; recovery check is overstrict

I found **no source-write counterexample** from a changed current input/tag while the exact guard remains installed. The healthy path validates the stored pin’s structure, then skips native session polling (`runtime.ts:4470-4480`). The installed tool hook denies non-read/handoff tools by quarantined session, independent of current input metadata (`roles.ts:72-92`; `source-quarantine.ts:188-206`). LAZERS also refuses to prompt a quarantined attempt (`runtime.ts:5491-5567`). Thus a later input does not undo the write fence.

However, **the lost-guard recovery path still requires the old review to be the current completed foreground**: `requireForeground = pending || review !== undefined` and the subsequent `sourceWorkerWait` checks run at `runtime.ts:4534-4540` and `:4566-4568`. The new test explicitly holds recovery when the pin’s request metadata changes (`runtime.test.ts:1213-1233`). A legitimate later handoff input can therefore leave `hold_reason` set and `sourceReservationExcluded` false indefinitely; a new quarantine command cannot retarget a sealed row.

That is an **availability/proportionality failure, not a write-safety hole**. Keep validating pin structure, the durable attempt/session/assignment/workspace binding, and the exact replacement guard before restoring exclusion. Do not require the old review message/tag to remain current after sealing. The current hook still fences writes; reads and handoff tools remain allowed. No full native-session scans are needed while the guard is healthy.

### Explicit pending-pin supersession

The explicit version-bound supersession looks sound by inspection: caller/version checks run before admission and again inside the write transaction; the transaction is SQLite-immediate (`storage.ts:247-249`). The supersession event records `supersedesRequestID` while retaining the earlier transition (`runtime.ts:1746-1754`). Exact old-request replay returns its saved receipt without running the mutation; changed payload under the same request ID conflicts (`store.ts:2915-2948`). A sealed row returns before the upsert (`runtime.ts:1722-1723`), so it cannot be retargeted.

The added test covers sequential supersession, retained histories, and old replay nonmutation (`runtime.test.ts:1235-1287`). It does **not** directly race two supersessions or attempt a sealed retarget; the transaction/version checks appear to fence those cases, but dedicated discriminators would strengthen evidence.

Root’s **35 focused tests** are reported, not independently run. The **569-test / 7,185-assertion result was for the previous candidate**, not `fdadbf3`; I did not read or poll the active full-suite run.
