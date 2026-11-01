# Architect lifecycle follow-up — implementation and dogfood gate

Task `239f45a9-3247-4cba-b339-19c8267d0800` (LZ-28) is implementing the lifecycle
increment from the reviewed `d9ef198` baseline, after scheduler plan
`6ed421e4-88cc-4324-b521-8f9a32d5de43` integrated. This does not redispatch
scheduler or worker-progress work.

The user selected a configurable **30-minute** idle default; busy/recent Architects
are reused. Durable handoff and current-owner transfer precede native archival.
No automatic old-transcript summary or replay is permitted. The implementation
uses the pinned OpenCode 2.2.5 prompt hook to record native input IDs before inbox
admission and `session.update({ archived })` for native archival/recovery. It fails
closed when prompt observation or native update is unavailable. Automated race,
reopen and multi-scheduler coverage is recorded in
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
session prompt hook runs before native inbox admission and exposes readonly
`sessionID`/`messageID`; it cannot retarget input. `Session.prompt` does not reject
an archived session. Consequently, the hook durably marks the input ID and
unarchives the predecessor before returning; the scheduler then recovers/rolls
back ownership and suppresses an unconsumed handoff. The scheduler checks the
input marker on both sides of native archival. The implementation never copies
prompt text into its lifecycle input table.

- [Pinned `session.ts`](https://raw.githubusercontent.com/anomalyco/opencode/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/session.ts)
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
