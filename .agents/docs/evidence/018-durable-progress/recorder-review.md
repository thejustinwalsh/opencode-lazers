# Progress recorder integration review

Original task `01d89f85-5eeb-4797-a0a8-18b2521e1cfa` (`LZ-13`), native Luna Max
attempt `d543a0f7-670a-46eb-8a91-0ca590a0f848`, first candidate `b7f036b`.
The candidate has not been merged or activated in the live server.

Root's independent `/private/tmp/lazers-progress-final-review.md` records 17
passing focused tests and confirms the prior reminder delivery, exact identity,
completion and early-commentary findings are resolved. The old missing ignored
engine-cache failure is obsolete: the worker's later full run passed 357 tests /
3,314 assertions, and its formatter/lint/types passed. Those results do not prove
the separate recorder cases below.

## Independently reproduced recorder findings

Read-only source review found three additional material defects. Architect then
executed an isolated temporary SQLite fixture using the candidate recorder and
the existing `test/trajectory/fixture.ts`, without modifying the active checkout,
native worker, model or application database:

1. `recordToolHook` persists arbitrary structured output through `safeValue`.
   Output containing `messages: [{type: "assistant", content: [{type:
   "reasoning", text: "PRIVATE_CONTEXT_CANARY"}]}]` and nested
   `state.input: "FULL_INPUT_CANARY"` retained both canaries in the durable facts.
   `projectProgressFact` also copies that output through the same permissive
   recursive helper. The write and read boundaries must omit hidden context and
   full inputs, not merely rely on credential-key filtering.
2. Cumulative live usage at 5000 with input 20 / cost 0.75 followed by recovered
   usage at 4000 with input 10 / cost 0.50 retained timestamp 5000 but replaced the
   payload with input 10 / cost 0.50. Timestamp and cumulative payload must remain
   one coherent latest observation while provenance may still merge.
3. One interruption at 6000 observed as native event, retained idle marker and
   session snapshot produced **three** execution-outcome rows. Re-reading the
   same session outcome after only `time.updated` changed to 7000 produced a
   **fourth**, although `time.idle` stayed 6000. Correlate the actual same turn
   across these paths; unrelated session updates are not new executions.

Native coordination message `msg_c98702092dcb4be092f3c5cfc62a5617` delivered these
concrete repairs to the same original worker with `steer` / no idle resume. Native
admission was confirmed; model consumption was not inferred. No replacement task,
attempt, worker, route, acceptance or scope expansion was requested.

Before integration, review the worker's fixes and exact regressions, preserve
current main, and activate the reviewed merged server through supported native
location reload. The actual registered progress-tool plus automatic-fact round
trip remains separate from mocked registration tests; lifecycle retains its
existing progress-integration prerequisite.
