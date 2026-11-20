# Mock model server for LAZERS end-to-end tests: groundwork

Read-only research. No servers run, no tests run, nothing changed. OpenCode source: `/Users/tjw/Documents/ChatGPT/opencode-native-settlement/packages`. Reference mock: pine baseline `tests/mock.mjs`.

## 1. Pointing a model at a local OpenAI-compatible endpoint

Verified path: a custom provider using the `openai-compatible` package. It speaks `POST {baseURL}/chat/completions`.

```json
{
  "provider": {
    "mock": {
      "npm": "@opencode/ai/providers/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "test" },
      "models": { "mock-model": {} }
    }
  },
  "agents": { "architect": { "model": "mock/mock-model" } }
}
```

Evidence:

- Provider schema: `opencode-native-settlement/packages/core/src/config/plugin/provider.ts:82-89` (`npm`, `options.baseURL`, `apiKey`); `core/src/v1/config/provider.ts:77-90`.
- Compatible package wiring: `core/src/plugin/provider/local.ts:69-74` (`package = "@opencode/ai/providers/openai-compatible"`, `settings.baseURL`).
- Compatible route is chat completions: `ai/src/protocols/openai-compatible-chat.ts:14-19`.
- The built-in `openai` provider defaults to the Responses route, not chat: `ai/src/providers/openai.ts:~100-108` (routes `[Responses, Chat]`, `model: responses`). A fake for the `openai` provider must serve `/v1/responses`, or the test must use a custom provider id as above. Not verified in depth.
- Anthropic provider uses `AnthropicMessages.DEFAULT_BASE_URL` when no `baseURL` is set: `ai/src/providers/anthropic.ts:39`. Not analysed further.
- LAZERS currently sets only `agents.lazers-implementor.model = "openai/gpt-6-luna#max"`: `opencode.json`.

Per-test isolation:

| Mechanism                                                            | Where                                                               | Notes                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `XDG_CONFIG_HOME/opencode/opencode.json`                             | `util/src/global-roots.ts:7,15`; `util/src/global.ts` (config root) | Global config. Owned launch already writes this file under the owned root.                                       |
| `OPENCODE_TEST_HOME` overrides `home`                                | `util/src/global.ts` (`get home()`)                                 | Not needed; LAZERS already sets `HOME`.                                                                          |
| `OPENCODE_CONFIG_CONTENT` (inline JSON)                              | `cli/src/server-process.ts:133`; `core/src/config.ts:291-295`       | Lets a test start a service with a provider and no file write. Not passed by owned launch today.                 |
| `OPENCODE_CONFIG` (file), `OPENCODE_CONFIG_DIR`                      | `cli/src/server-process.ts:125-134`                                 | Explicit file or directory.                                                                                      |
| `OPENCODE_CONFIG_PROJECT_DISABLE`                                    | `cli/src/server-process.ts:124-127`                                 | Stops project `opencode.json` loading.                                                                           |
| `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_MODELS_PATH`              | `cli/src/server-process.ts:118-121`                                 | Stops the live catalog fetch and points at a fixture (LAZERS has `src/models/fixtures/models-dev.excerpt.json`). |
| Discovery order (global, project, `.claude`, `.agents`, `.opencode`) | `core/src/config/discovery.ts:71-79`                                | Project config is walked up from `location.directory`.                                                           |

LAZERS owned launch already isolates config:

- `src/verification/opencode/owned-launch.ts:194-217` `isolatedEnvironment` sets `HOME`, `XDG_*`, `TMPDIR`, `OPENCODE_DESKTOP_TEST_ROOT`.
- `owned-launch.ts:187` `globalConfig = <root>/config/opencode/opencode.json`.
- `owned-launch.ts:823-848` writes that file with `default_agent: "architect"` and `plugins: [{package: candidatePlugin}]`. A `provider` block can be added here.

Headless service and SDK:

- `opencode serve --service --hostname 127.0.0.1 --port N`: `cli/src/commands/commands.ts:578-590`; LAZERS spawns it at `owned-launch.ts:24` (`SERVICE_ARGS`) and `:895`.
- Default port constant `DEFAULT_SERVICE_PORT = 49374`: `owned-launch.ts:21`. This is a fixed numbered port (see section 5).
- SDK `OpenCode.make({baseUrl, headers, fetch})` and `Service.ensure` (can start a local server): `.agents/docs/opencode-api.md:15,146`.

Caveat for LAZERS workers: runner sessions get `provider/model/variant` from the plan route (`ctx.session.create`, `src/runner/native.ts:1068-1102`; `docs/reference/contributor-contracts.md:47`). Test routes must name `mock/...`. The auditor default route is OpenCode Go (`docs/reference/contributor-contracts.md:53`, `src/runner/roles.ts`).

## 2. Minimal wire protocol (OpenAI chat completions, streamed)

Request (`ai/src/protocols/openai-chat.ts`):

- `POST /v1/chat/completions`, `Authorization: Bearer <apiKey>`.
- Body: `model`, `messages` (`system`, `user`, `assistant` with optional `tool_calls`, `tool` with `tool_call_id`), `tools`, `tool_choice`, `stream: true` (always, `:882`), `stream_options.include_usage: true` (`:883`, unless the model sets `streamUsage` false), `max_tokens` or `max_completion_tokens` (`:744-780`), `parallel_tool_calls` only when tools are present (`:827-842`), optional `reasoning_effort` (`:232`).

Streamed response (SSE, `Framing.sseWithDone`, `ai/src/route/framing.ts:86-89`; terminal `data: [DONE]`, `openai-chat.ts:345,1359-1365`):

```
data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello"}}]}
data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":5,"total_tokens":125}}
data: [DONE]
```

Tool call (one chunk is enough; arguments are accumulated by `index`, `openai-chat.ts:907`):

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lz-submit-task","arguments":"{\"x\":1}"}}]}}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":30,"total_tokens":230}}
data: [DONE]
```

Schema facts (`openai-chat.ts`):

- Tool-call delta fields: `index`, `id`, `function.{name,arguments}`, `custom`, `extra_content` (`:295-302`).
- Choice fields: `delta`, `finish_reason`, `native_finish_reason`, `usage` (`:317-324`). Top-level `usage` in `OpenAIChatEvent` (`:332-340`).
- Usage: `prompt_tokens`, `completion_tokens`, `total_tokens`, optional `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` (`:255-280`; `mapUsage` ~`:945-970`). Missing usage is allowed (`usage` optional).

Finish reasons (`mapFinishReason`, `openai-chat.ts:~907-938`):

| finish_reason                 | OpenCode result          |
| ----------------------------- | ------------------------ |
| `stop`, `end`                 | stop                     |
| `length`                      | length                   |
| `tool_calls`, `function_call` | tool-calls               |
| `content_filter`              | content-filter           |
| `error` / `network_error`     | AIError (fails the turn) |
| other                         | unknown                  |

Minimal fake: answer text as `delta.content` chunks, then one finish chunk, then optional usage chunk with `choices: []`, then `[DONE]`. Tool turns use `delta.tool_calls` and `finish_reason: "tool_calls"`. Pine's mock already emits this shape (`pine/.../baseline/tests/mock.mjs:145-175`).

Not verified: the Responses and Anthropic Messages wire forms (`ai/src/protocols/openai-responses.ts`, `anthropic-messages.ts`). Use the chat route unless a test needs them.

## 3. What LAZERS already has

Launcher and harnesses:

- `src/verification/opencode/owned-launch.ts`: owned Desktop plus owned service. `startOwnedDesktop` (`:380`), `startService` (`:~880-930`, spawns `serve --service` on a reserved loopback port), `reserveLoopbackPort` (`:~1790-1802`, avoids 49374), `cleanupOwnedDesktop` (`:592`), `reopenOwnedDesktop` (`:1395`), `verifyOwnedLaunch` (`:1444`). macOS only (`:~1662`).
- `src/verification/opencode/native-interaction-{contract,server,main,cli}.ts`: native input broker and main-process adapter. `setupNativeInteractionMain` (`native-interaction-main.ts:1193`) reads `OPENCODE_DESKTOP_TEST_ROOT`.
- `src/verification/opencode/audio-fixture*.ts`: audio fixture for dictation/playback.
- `test/runner/verification-driver.ts`: `settleVerification` completion-boundary driver.
- Tests: `test/product-verification/owned-launch.test.ts` (1091 lines; `dependencies()` at `:123` fakes launcher side effects), `native-interaction*.test.ts`, `audio-fixture.test.ts`.

Stub helpers (in-process fakes):

| Helper                                            | Location                                                | Fakes                                             |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `fakeContext`                                     | `src/models/agent-routes.test.ts:9`                     | `ctx.agent.get`                                   |
| `toolContext`                                     | `src/tasks/rpc.test.ts`                                 | tool context                                      |
| `scriptedReview`                                  | `src/runner/runtime.test.ts:5539`                       | Fallow review results (a scripted-result pattern) |
| `fakeHost`                                        | `src/radar/pulse-loop.test.ts:20`                       | DOM host                                          |
| `fakeTransport`                                   | `src/radar/monitor-state.test.ts:87`                    | radar transport                                   |
| `validProposal`, `keyedProposal`                  | `test/proposal.ts:3,7`                                  | task proposals                                    |
| `makeFixture`                                     | `test/trajectory/fixture.ts:149`                        | trajectory data                                   |
| `makeLedgerFixture`                               | `test/models-observation-ledger/fixtures/ledger.ts:256` | ledger                                            |
| `createReactiveStore`, `createTestUI`             | `test/models-panel/fixtures/dom-host.ts:12,60`          | Solid-like UI                                     |
| `mock.module` for `solid-js` and runntime adapter | `test/webgpu-*.fixture.ts`, `src/webgpu/*.fixture.ts`   | module substitution                               |
| `HostSession` type                                | `src/runner/host.ts:41`                                 | the host seam for OpenCode sessions               |

Real OpenCode seam: `src/runner/native.ts` calls `client.session.*` (`:166-1220`) and `ctx.session.create`/`ctx.session.prompt` (`:1077,1102,1176`). A fake at the `HostSession` / client boundary is the in-process option.

No mock provider exists. Grep for `mock.module`, `fake`, and `stub` found no provider fake. OpenCode's own fakes are in-process `TestLLM` (`ai/src/testing.ts`, Responder queue) and http-recorder cassettes (`packages/http-recorder`). Neither crosses a process boundary, so neither serves a separately launched Desktop service.

No `test` script in `package.json`; the scripts are `verify`, `build`, `build:server`, `build:gui`, `build:fallow-wasm` (`package.json:20-24`). AGENTS.md says `bun test`.

## 4. Pine's mock in 10 lines

Source: `pine/repo/baseline/tests/mock.mjs`.

1. The script rides in the last user message as `<<MOCK {"steps":[...]}>>` (`mock.mjs:2,120`); `mockMsg(steps)` builds it (`mock.mjs` last export).
2. Step index is the count of assistant messages after that user message (`mock.mjs:115,139`). Stateless: history carries the position.
3. Step fields: `tools:[{name,args|rawArgs,id?}]`, `text`, `delayMs`, `chunkDelayMs`, `stall`, `reasoning`, `finishReason` (`mock.mjs:3,145-175`).
4. Past the end of the script, it replies `FINAL:: <tool results>` (`mock.mjs:139-141`).
5. Named scripts via `@@REF:name@@` plus `state.scripts` for reuse (`mock.mjs:22,121-125`).
6. Every request is recorded: `{t,url,auth,body,reply,aborted}` into `state.requests` (`mock.mjs:75-78`); `reset()` clears it.
7. Failures: `state.failNext` consumed per request, with `status`/`body`/`headers` (`mock.mjs:96-102`).
8. `stall: true` holds the connection open (`mock.mjs:~164`); the client must abort.
9. Usage: prompt tokens `ceil(rawLength/4)` unless `opts.promptTokens`; `prefixCache` counts shared prefixes as cached (`mock.mjs:~176-205`).
10. Listens on `127.0.0.1` port 0 and returns `{port, baseUrl, state, reset, close}` (`mock.mjs:~235-250`). `opts.strip` removes host-added text before parsing (`mock.mjs:112-113`).

For LAZERS, the directive must reach the Architect (user text, works) and worker sessions (their prompt is runtime-built; open question 5).

## 5. Constraints from AGENTS.md that apply

- Portless rule (`AGENTS.md:56-60`; also `docs/reference/contributor-contracts.md:125`): "Before launching ... a networked verification server, load and follow `$portless-dev-servers`. Route project servers through Portless ... Never silently fall back to a numbered HTTP port. One-shot tests without a listening socket are exempt." OpenCode Desktop and its service are third-party developer tooling (`AGENTS.md:60`).
  - A loopback mock that listens on a socket is not "one-shot without a listening socket", so it is not exempt on its face. It is a project-owned networked test server. The rule calls for Portless unless a decision says otherwise. I did not locate the `portless-dev-servers` skill file (a search was started and stopped).
  - The owned OpenCode service on `127.0.0.1:49374` (`owned-launch.ts:21`) is a numbered port. It is covered by the developer-tool exclusion only as far as AGENTS.md's wording goes; decide explicitly.
- No native binaries (user memory: `no-native-binaries-rule.md`). A Bun or Node `http` mock is plain TypeScript and passes. `scripts/native-binary-check.ts` exists to enforce the rule.
- Strict TypeScript, `bun test`, auto-format and lint via `bun run verify` (`AGENTS.md:19-27` region).
- Shared machine (user memory: `shared-machine-with-product.md`): check `scripts/reload-safe.ts` before long test runs and service reloads.
- Models without a price source: AGENTS.md says a missing applicable price is a defect and the price UI is omitted when no source prices a model (`AGENTS.md:54`). Mock models will have no price. The mock fixture must either price itself through a test price source or expect the omitted-price path.

## 6. Open questions

1. Wire route: custom `mock` provider on chat completions (verified path, recommended) versus faking the `openai` provider's Responses route. Which models do tests use?
2. Architect model key: `agents.architect.model` is the assumed key (LAZERS sets `default_agent: "architect"`). Confirm against `.agents/docs/opencode-api.md` and the Architect agent definition before writing fixtures.
3. Mock lifetime: in-process Bun test (loopback, ephemeral port) versus a separately launched process. This decides whether Portless applies.
4. Port policy for the owned service: keep `DEFAULT_SERVICE_PORT 49374` (`owned-launch.ts:21`) or route through Portless? Same question for the mock.
5. Worker directive: worker prompts are built by the runtime, so `<<MOCK>>` cannot ride in them unchanged. Options: a per-session route keyed by session ID, or a directive in the task instruction that the runtime passes through. Decide which.
6. Injection point: add the `provider` block in `owned-launch.ts:823-848` (file, already isolated) or use `OPENCODE_CONFIG_CONTENT` (`server-process.ts:133`) when the test starts its own `serve`?
7. Models fetch: set `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_CONFIG_PROJECT_DISABLE=1` in the owned env so tests make no network calls. Confirm the owned env does not already do this.
8. Pricing: mock usage will be unpriced. Choose between a test price source and an explicit "unpriced fixture" expectation.
9. Desktop GUI: the Desktop talks to the service, not the provider. The mock is needed only behind the service. Confirm no GUI path calls providers directly.
10. Scope of the mock's replies for Fallow and auditor routes: they need a provider only if a route is set to `mock/...`. Decide whether the auditor is mocked too.
