# OpenCode session hooks: how `context`, `compaction`, `experimental.idle` treat edits

Read-only trace. Pin check and sources below. Paths: `T` = LAZERS typings `node_modules/@opencode/plugin/dist/effect/session.d.ts`; `N` = `/Users/tjw/Documents/ChatGPT/opencode-native-settlement/packages`.

## Version check

| Item                                          | Value                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| LAZERS pin (`.agents/docs/opencode-api.md:5`) | `dc2ffcf`, release v2.3.0                                                                         |
| Checkout HEAD                                 | `22e48b17`, 8 commits after `dc2ffcf`; `dc2ffcf` is an ancestor (`merge-base --is-ancestor` true) |
| Installed `@opencode/plugin`                  | 2.3.0                                                                                             |
| Hook-relevant files changed in the 8 commits  | none, except `packages/core/src/plugin/host.ts` (+3 lines: `experimental.session.settlement`)     |

Files checked as unchanged in the range: `plugin/src/effect/session.ts`, `core/src/session/model-request.ts`, `core/src/session/runner/llm.ts`, `core/src/session/compaction.ts`, `core/src/plugin/hooks.ts`, `core/src/session/runner/to-llm-message.ts`, `ai/src/cache-policy.ts`. Installed typings were not diffed byte for byte against the checkout; the 2.3.0 match is inferred from the version number.

## Shape of the hooks (T)

```
T:26-35  SessionRequest { readonly sessionID; readonly model; system: SystemPart[]; messages: SessionRequestMessage[]; options }
T:37     SessionContext extends SessionRequest { readonly agent; tools: Record<name,{description,input}> }
T:44-52  SessionCompactionResult { summary; native?; metadata?; tokens? }   SessionCompaction { result? "skip the model request" }
T:204    "experimental.idle": SessionIdle
```

Mutable on `context`: `system` (array and parts), `messages` (array), `options`, `tools` (record). `sessionID`, `model`, `agent` are readonly in the type.

## 1. `context` hook

**When.** Once per model request built by the primary flow. The call sits in the step loop, so it runs on every step, on each retry attempt, and on each continuation (`N/core/src/session/runner/llm.ts:242-260`: `prepareContext` then `context.request.primary(...)` inside `while (true)`). Dispatch: `N/core/src/session/model-request.ts:445` `primary: prepare("primary", input, agentHook("context", agent))`. Compaction, title and generate use their own hooks (`:446-448`).

**Input.** The `event` is `{ sessionID, model, system, messages, options, agent, tools }` (`N/core/src/session/model-request.ts:282-291`, `hooks.trigger(...)` at `:442`). `messages` is `toLLMMessages(...)` output (`N/core/src/session/model-request.ts:126`, `:290`), i.e. canonical LLM messages rebuilt from stored history every attempt. Tool entries are deep copies (`:277-280`).

**Where the output goes.** Traced end to end:

```
llm.ts:260   const prepared = yield* context.request.primary({...})
llm.ts:279   Effect.map((prepared) => ({ request, options, retry, executeTool }))   <- event dropped
model-request.ts:320-335  request = ai.request({ system: shaped.system, messages: shaped.messages, tools: hooked, ... })
```

`prepared.event` is discarded at `llm.ts:279-284`. `event.messages` is never published to the bus, never written to the store, and never read back except by the compaction and title paths, which use their own `event.result`. Each attempt rebuilds `transcript.messages` from `loaded.messages` (`llm.ts:255-258`, `model-request.ts:126`). Hook edits last for one request.

**Caveat (aliasing).** `trigger` passes the same object to each callback and does not copy (`N/core/src/plugin/hooks.ts:89-93`). Top-level message and array edits are per request. Edits to nested objects that `toLLMMessages` shares by reference (tool `input` via `toolInput`, `providerMetadata` via `item.native`, `to-llm-message.ts:96-100`, `:153-200`) can change the in-memory `loaded.messages` of the same attempt. Nothing in the code writes that memory back to the store.

**Verdict on persistence.** Edits are request-only. The only way state persists is a new event: `session.synthetic`, `session.prompt`, or a compaction result (section 5).

## 2. Cache breakpoints

**Order.** The hook runs before the cache policy. `ai.request(...)` is built in `model-request.ts:320-335` with `cache: { ttl }` (`:328`). Markers are applied later, at request compile, in `N/ai/src/route/client.ts:550` (`applyCachePolicy(...)`). So breakpoints land on whatever the hook left.

**Placement** (`N/ai/src/cache-policy.ts:27-34`, cap at `:34`):

```
AUTO = { tools: true, system: true, messages: { tail: 1 } }    BREAKPOINT_CAP = 4
  - last tool definition            (markLastTool)
  - first and last system part      (markSystemBoundaries)
  - last text part of tail message  (markMessageAt)
```

Other routes use other rules (`:83` QWEN; gateway rules `:80-82`).

**Does editing old content move the cached prefix?** Yes. The repo's own code depends on this:

- `N/core/src/session/model-request.ts:229-230`: a stable cut "keeps the replaced prefix, and with it the provider's prompt cache, stable between cuts".
- `N/core/src/session/compaction.ts:341-342`: swapping a summary early "would rewrite the prefix and throw away the cache for every step".
- `N/core/src/session/runner/llm.ts:270`: tool definitions are kept on the final step "to preserve the provider's cached prefix".

Consequence for LAZERS: `roles.ts:101-106` deletes delegation tools from `context.tools` while an attempt is active. Tools sit at the front of the cached prefix, so the tool set changing at attempt start or end invalidates the cache from that point. Within an attempt the set is stable.

## 3. Ids, tool names, input and output, metadata

| Wanted                                          | Visible to `context` hook            | Source                                                                |
| ----------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| message id                                      | yes, `Message.id`                    | `to-llm-message.ts:236-280` (`Message.make({ id: message.id, ... })`) |
| tool call id and name                           | yes                                  | `to-llm-message.ts:96-102` `ToolCallPart { id, name, input }`         |
| tool result id, name, content                   | yes                                  | `to-llm-message.ts:113-133` `ToolResultPart { id, name, result }`     |
| tool error                                      | yes                                  | `:126-134` `resultType: "error"`                                      |
| timestamps                                      | no                                   | `Message` carries no time field                                       |
| tool-state `metadata` (e.g. subagent sessionID) | no                                   | `llm.ts:419-430` stores it on tool state; `toolResult` drops it       |
| stored `metadata` on the message                | declared, not populated on this path | see below                                                             |

`SessionRequestMessage.metadata` is typed as "the stored Session message's metadata, for reading only" (`T:23-25`). `toLLMMessage` never copies metadata onto the output (`to-llm-message.ts:206-301`). The one metadata read in core is `message.metadata?.background` at `:263`, which runs on stored messages before conversion. So a plugin can attach metadata to `synthetic` or `prompt` input (`prompt.ts:30`, `:51`; `session-message.ts:33`), but the `context` hook does not see it. To recognise its own notices, a plugin has to match by message id or text, provided it kept the id that `synthetic` returned (not traced).

## 4. Token counts, cache statistics, cache freshness

- The hook gets none of: token counts, cache read or write counts, time since last request, or cache TTL. Its `options.maxTokens` is set from an internal `inputTokens` estimate (`model-request.ts:288-296`), which the hook does not get.
- Stored usage: per-message `tokens.cache.read/write` (`N/core/src/session/usage.ts:15-17`); session totals `tokens_cache_read` (`N/core/src/session/sql.ts:55-56`); `SessionEvent.UsageRecorded` published (`compaction.ts:902`, similar for steps).
- Plugin read paths in the pinned API index: `session.message.list`, `session.diff`, `session.context`, and `experimental.session.stats` (pinned doc `.agents/docs/opencode-api.md:179`, `:223`). The pinned doc lists `usage/step/tool events` as subscribable; the typings for `ctx.event` were not inspected for a usage event name.
- Cache lifetime: `model.cache.ttl` (`model-request.ts:328`), `cacheLifetime` (`compaction.ts:987`), `CACHE_MARGIN = 30_000` (`:162`). The code derives cold-cache age from the last assistant message's `time.created` (`compaction.ts:388-389`). No API hands that to a plugin directly; a plugin must compute it from stored messages and the model's TTL from `ctx.model.list()` (`N/core/src/plugin/optimize.ts:66-72`).

## 5. `compaction` hook

**When.** `summarize` builds the request with `requests.compaction` (`compaction.ts:857`), inside `deliver` (`:615`). Triggered by auto-compaction when due (`:306`), by overflow, by a background precompute (`:348-400`), or by manual `/compact`.

**Input.** Same shape as `context`, plus `result?` (`T:51-52`). The hook sees the request before the summary prompt is appended (`compaction.ts:492`).

**`result` effect.** Setting it skips the model call. `deliver` returns `fromHook(...)` before any send (`compaction.ts:632`), and `fromHook` builds the result from `summary`, `native`, `metadata`, `tokens` (`:870-882`). Request building (including the `compaction` hook itself) still runs first.

**Stored afterwards.** `publish` emits `SessionEvent.Compaction.Ended` with `text`, `native`, `model` and `metadata` (`compaction.ts:905-930`, emit at `:926`; `keepID` in metadata at `:546-547`). History then renders a `<conversation-checkpoint>` user message (`N/core/src/session/runner/to-llm-message.ts:273-285`) and keeps messages from `metadata.keepID` on (`N/core/src/session/history.ts:237-274`). The compaction summary is stored; the hook's other edits to the summary message are rebuilt from storage and dropped (`compaction.ts:726-728`, marked TODO).

**Plugin-triggered compaction.** Yes. `session.compact` is in the typed API (`T` `SessionDomain`; `N/core/src/plugin/host.ts:596`).

## 6. `experimental.idle`

- Fires in `llm.ts:176-185` only when the model work finished, there is no pending input, and the session would go idle. Not after interruption, failure, or control-only drains such as manual compaction (`T` comment on `SessionIdle`).
- Payload: `{ sessionID, background }`, where `background` lists running shell, subagent, or image jobs, owned by this session or a descendant (`T:` `SessionIdleBackground`).
- Can keep the run alive by admitting input. After the hook, the loop continues only if the inbox has an `input` item (`llm.ts:182-183`). A hook that admits nothing does not keep the run alive.
- Limits: returns void; no way to cancel the idle transition. `resume: false` notices wait for the next wake (typings comment).

## 7. Ordering, isolation, errors

- **Order.** Callbacks run in registration order, sequentially, one `yield*` each (`N/core/src/plugin/hooks.ts:75`, `:89-93`). Plugin load order was not traced.
- **Isolation.** None. All callbacks receive the same event object. `optimize.ts:85-100` mutates `event.system[0]` in place, so later hooks see it. Use `providerID` filter (`hooks.ts:90`) to restrict.
- **Errors.** Session hook failure type is `never` (`hooks.ts:26`). `trigger` does not catch; a thrown error or defect propagates to the code that triggered the hook. `optimize.ts:98` catches locally with `Effect.catch`, which shows no upstream guard exists. Effect of a defect on the step outcome was not traced.

## LAZERS usage

LAZERS side, `src/runner/roles.ts:101-106`:

```
timedHooks(ctx.session, "session").hook("context", (context) =>
  Effect.sync(() => {
    if (!attempt(context.sessionID)) return
    for (const tool of Object.keys(context.tools)) if (delegationTool(tool)) delete context.tools[tool]
  }))
```

This is a per-request tool filter. It does not change stored state. It does change the cached tool prefix (section 2).

## Could not determine

1. Whether `SessionRequestMessage.metadata` is ever populated in any path (no assignment found on the primary path).
2. Whether `session.synthetic` and `session.prompt` return the stored message id to the caller.
3. What a throwing `context` or `compaction` hook does to the step outcome (propagation traced, retry or failure not).
4. Plugin load and registration order across packages.
5. Whether `SessionContext.load` returns fresh objects on each attempt. This decides whether aliasing edits (section 1 caveat) can reach precompute.
6. Whether the pinned typings expose any usage or step event by name.
7. Cache hit behaviour for the real providers in use. Only code paths were read; no requests were run.
8. Whether the installed `@opencode/plugin` 2.3.0 typings match the `dc2ffcf` source byte for byte.

## Answer

**context-hook edits are request-only and never persisted: YES.** Traced: `llm.ts:279` drops `prepared.event`; messages are rebuilt from storage each attempt (`llm.ts:255-258`); nothing publishes or writes `event.messages`. Caveat: nested shared objects can be mutated in memory for the same attempt (section 1).
