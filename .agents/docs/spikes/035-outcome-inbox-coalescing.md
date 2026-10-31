# Narrow repair: queued outcome wake coalescing

## Confirmed cause

Read `.agents/docs/evidence/033-completed-task-audit/wake-churn.md` at
`e10bf91`. Go plan `8d505ab3` retained resumable task-accepted v7 and accepted
v8 notices before non-resumable integrated v10; obsolete queued inputs later
caused no-op Architect turns. Durable history is correct and must remain.

`src/runner/runtime.ts:589-608,1760-1841` fingerprints full versioned payloads,
then admits every undelivered row without native-queue supersession. The stable
message ID protects exact retry, not semantic obsolescence. `nativeHost.notify`
only sends queued synthetic input; `outcome.ts` supplies the human action.
The runtime test starting `accepted task handoff resumes review...` currently
expects both task and combined acceptance to resume, even for one task.

Preserve useful partial-task wakes: speech was reviewed/merged while projection
remained active. Do not solve the churn by waiting for all feature tasks or
silencing every task-level acceptance. A completed single-task plan needs one
queued review wake; a genuinely actionable partial result still needs timely
handoff. Consumed messages cannot be retracted and must never be misreported as
prevented wakes.

## Pinned native boundary

OpenCode 2.2.5 installed public client types expose:

- `session.synthetic({sessionID,id,text,metadata,delivery,resume})`;
- `session.inbox.list({sessionID})`,
  `session.inbox.cancel({sessionID,inboxID})`, and
  `session.inbox.update({sessionID,inboxID,delivery})`.

`update` changes delivery only, not text/metadata/resume; do not invent an
in-place resume rewrite. Pinned core `session/inbox.ts` serializes cancellation
and consumption; a racing cancellation may return a lifecycle conflict.

**The server-plugin `SessionDomain` does not expose `inbox`.** See installed
`@opencode/plugin/dist/effect/session.d.ts:186` and the pinned public host at
OpenCode commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`. No cast can create
that capability. The public `@opencode/client/service` can discover an existing
authenticated local service without starting it. Public `server.info` returns
`pid` and `version`; a local plugin adapter can verify the discovered service
is its own process before using the client inbox API. Wrong/unavailable host
must remain a visible unsupported/uncertain delivery, not a guessed endpoint or
silent claim of queue coalescing. Never call `ensure`, restart a service, bypass
authentication or modify the host package to make this task pass.

## Target boundary

Tag new native outcomes with durable project/plan/outbox identity. Cancel only
positively identified still-queued older synthetic LAZERS outcomes for the same
Architect and plan, never user/worker input, foreign plans, unowned metadata or
transcript messages. Retain all durable outbox rows/IDs and explicit supersession
or cancellation evidence; host admission is not model consumption. A cancellation
failure must preserve the current outcome for stable-ID recovery, not discard it
or mark uncertain delivery as success. Race/reopen/lost-response tests and actual
pinned native queue observation are required; fixtures alone do not prove native
suppression. No historical inbox sweep or new scheduler/polling/lifecycle system.
