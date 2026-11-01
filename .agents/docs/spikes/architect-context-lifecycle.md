# Architect lifecycle follow-up — implementation and dogfood gate

Task `239f45a9-3247-4cba-b339-19c8267d0800` (LZ-28) is implementing the lifecycle
increment from the reviewed `d9ef198` baseline, after scheduler plan
`6ed421e4-88cc-4324-b521-8f9a32d5de43` integrated. This does not redispatch
scheduler or worker-progress work.

The user selected a configurable **30-minute** idle default; busy/recent Architects
are reused. Durable handoff and current-owner transfer precede native archival.
No automatic old-transcript summary or replay is permitted. The pinned OpenCode
2.2.5 prompt hook records prompt IDs, but queued synthetic input with `resume:false`
can bypass that hook. The public host API exposes inbox snapshots and
`session.update({ archived })`, but no atomic admission/archive barrier. Therefore
the native adapter explicitly reports input-admission safety as unsupported and
automatic idle renewal is disabled on this host; snapshots do not close the race.
Hosts without an explicit all-input barrier must fail closed without transferring
ownership or archiving. Conversation-only decisions and open questions are
recorded explicitly through `lazers_record_architect_continuity` and copied into the
durable successor handoff; no transcript replay or automatic summary is used.
Automated race, reopen and multi-scheduler coverage is recorded in
`.agents/docs/evidence/architect-context-lifecycle/implementation.md`.

**Native dogfood remains unresolved.** Root must verify the exact committed
artifact against live sessions: busy reuse, idle renewal, visible archived
predecessor, current-owner outcome routing, input arriving during transfer/archive,
and workers continuing. No such native observations are claimed here. The handoff
byte count is measured from the exact wake text; wake-attributed tokens and cache
read/write categories remain unknown unless a public native observation proves
them. Cumulative session usage must not be presented as wake-attributed.

## Pinned host input/archive behavior

At OpenCode commit `9bbb8ce18c80f099e0e448775f59d965ead40a21` (2.2.5), the
session prompt hook exposes readonly `sessionID`/`messageID`; it cannot retarget
input. This is not a complete admission observer: `session.synthetic` can enqueue
with `resume:false` directly through `SessionInbox`, bypassing the prompt hook.
Inbox listing is a snapshot, not an atomic barrier with archival, so repeated
snapshots and prompt-hook checks cannot prove that no input arrived between the
last snapshot and archive. The native adapter does not claim that guarantee and
does not start automatic renewal. Recovery remains fail-closed for an already
persisted renewal on an unsafe host: queued IDs are durably observed when possible,
ownership is rolled back, the predecessor is left live, and the handoff is
suppressed. Conversation continuity is separate from transcript history: Architect
records exact decisions and unresolved questions in a project database checkpoint,
which is snapshotted into the renewal/outbox before transfer.

- [Pinned `session.ts`](https://raw.githubusercontent.com/anomalyco/opencode/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/session.ts)
- [Pinned `inbox.ts`](https://raw.githubusercontent.com/anomalyco/opencode/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/inbox.ts)
- [Pinned `prompt.ts`](https://raw.githubusercontent.com/anomalyco/opencode/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/prompt.ts)
- [Pinned plugin `SessionPrompt`](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/plugin/src/effect/session.ts)

## Cache research, checked 2026-10-31

[Official OpenAI prompt caching, cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime)
states that GPT-5.6 and later, including GPT-6.1 Sol, use a default `30m` minimum
cache lifetime in the Responses API; a qualifying 30-minute read refreshes that
coverage. It also states that maintaining a session does not guarantee a cache
hit and that minimum lifetime does not guarantee tensor reuse or lower latency.
This supports the initial timing heuristic, not an exact idle expiry/cache miss
equivalence. ChatGPT/subscription-route retention remains **unverified**. Do not
change inference configuration or claim API billing rates apply to that route.
