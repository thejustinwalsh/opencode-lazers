# Progress recorder integration review

Original task `01d89f85-5eeb-4797-a0a8-18b2521e1cfa` (`LZ-13`), native Luna Max
attempt `d543a0f7-670a-46eb-8a91-0ca590a0f848`, first candidate `b7f036b`.
At the initial review boundary the candidate had not been merged or activated.
The repaired merge and native activation are recorded below.

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

## Repairs, checked merge and activation

After the original worker stopped and native session readback confirmed it idle,
Architect repaired the returned source in descendant `9d341de`; accepted
`b7f036b` remains unchanged in history. The same candidate was merged normally as
`a6e05e3`, retaining Root's startup guard, grouped Tasks identity, Radar inspector,
reference/search, speech, native scope/outcome and package fixes. No replacement
task, attempt, worker or route was created.

- Structured tool output is omitted at write/read; JSON-shaped structured tool
  content is omitted, bounded visible prose is retained, and error reads permit
  only public type/message fields. Hook/event/recovery plus legacy-read canary
  regressions close the reproduced privacy path.
- Cumulative payload and observation time are now replaced together only by a
  newer/equal observation; stale recovery contributes provenance, not stale values.
- Terminal events and idle messages coalesce using pinned OpenCode's exact
  event-to-message ID mapping (`packages/core/src/session/message-updater.ts:65-76`,
  `@opencode/schema` 2.2.5 `SessionMessage.ID.fromEvent`). No timestamp-only turn
  identity is invented. Session aggregate outcomes expose no event identity and
  native `time.idle` may advance within one millisecond; they are therefore kept
  as one explicitly non-additive latest outcome snapshot, separate from execution
  facts and independent of unrelated `time.updated` changes.

Checks: 20 progress tests / 117 assertions; merged focused suite **127 passed /
1,715 assertions**; merged full suite **376 passed / 3,449 assertions / 75 files**;
formatter, lint and strict types passed.

A single supported public `location.reload()` rebuilt all three already-loaded
locations from repaired merged source before whole-plan integration. The pinned
endpoint rebuilds all loaded locations, not one per call. All directories existed;
none was recreated. Service PID stayed **16786**. Original worker and Architect
model routes and busy/idle timestamps remained unchanged. Actual trajectory
readback now exposes **49 automatic facts**, 13 additive step measurements, one
cumulative usage snapshot and two explicit recovery gaps for the original attempt.
This is native automatic-fact/recovery observation, not successful commentary
or complete lifecycle proof.

Normal task-level command `progress-reviewed-source-landed-b7f036b-9d341de-v1`
recorded source landing at v13 → v14 without plan finalization. The original
attempt was already accepted before server activation, so its tool correctly
requires an active assignment rather than permitting new reports on closed work.
When asked explicitly, the user selected **Lifecycle dogfood (Recommended)**:
integrate the activated repaired source, dispatch the existing dependent lifecycle
worker, then observe its real registered report-tool call plus automatic facts.
That positive live tool roundtrip remains explicitly pending until observed; it
is not replaced by registered-host stubs, automatically recovered facts or this
authorized change in verification order.
