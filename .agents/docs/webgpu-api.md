# Optional local WebGPU API

LAZERS is one plugin package with server, Electron-main, and renderer adapters, using OpenCode 2.2.5's public typed APIs. Enable optional local inference in **Settings → LAZERS**. `options.webgpu: true` seeds the initial master preference for existing installations; saved settings take precedence. It does not advance the main task-execution dogfood sequence.

## Enable and operate

Run `bun run build:gui`, then add the package to Desktop's **global** `opencode.json(c)`, so both server and GUI entries load:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-lazers",
      "options": { "webgpu": true }
    }
  ]
}
```

With the master preference on, the renderer downloads/verifies the bundles needed by enabled features, then autoloads chat/speech if any enabled capability uses it, otherwise d1. With the initial configuration above all capabilities are enabled, so both bundles are cached and chat/speech loads first. Requests arriving during startup wait in the bounded queue. A request after unloading wakes the runtime automatically. The session-header SVG shows downloading, loading, ready, running, unloaded, or error; movement honors reduced-motion preferences. Click it to open **Settings → LAZERS**.

Settings → LAZERS is the entire plugin's page, available even with local inference off. Its task-workflow section explains that Architect, saved tasks, and the Tasks panel use the ordinary OpenCode workflow independently of local inference. The local-inference section contains the master and capability switches, runtime status, cache cleanup, voice selection, and optional idle unload. **Never** is the default. Collapsed diagnostics retain manual unload/reload, GPU recovery, questions, decisions, speech, and transcription tests; inference tests respect the same capability switches. Cleanup stays available while local inference is off and removes only the named model files after confirmation.

The chat/audio route selector defaults to **Liquid WebGPU**. The selectable **ruNNtime Omni** candidate uses the pinned public `runntime/zoo` API and is explicitly unqualified until its retained Desktop qualification is complete. Switching routes cancels active work, disposes the old runner before allocating the next, and reloads from the same verified model cache. Load or runtime failures stay visible; they never fall back to Liquid. System One remains on d1 regardless of the chat/audio route. ruNNtime's public speech API currently fixes TTS to American English female; the existing voice menu applies only to Liquid.

The native OpenCode model picker also exposes **LAZERS Local WebGPU** with separate Liquid and ruNNtime LFM3 Omni text models. Selecting a native model pins that request to its backend, exact language/projector precision, and manifest revision; it does not change the Settings route or the next native selection. Native conversations forward ordered system, user, and assistant text history and stream text through the renderer-owned mailbox into OpenCode's conversation events. These models are text-only and do not support tools, media, sampling controls, or JSON output; unsupported requests fail explicitly. Native conversation behavior is not qualified by Settings diagnostics and must be tested in the native composer.

The generation result requires both usage fields and accepts either measured nonnegative integers or `null` when an engine does not report usage; legacy numeric results remain valid. Renderer and service negotiate `webgpu-generation-result-nullable-usage-v2` before attaching. This revision includes the native conversation stream mailbox in addition to nullable usage. A missing or different contract keeps the runtime out of `ready`; a completion-delivery error is shown in diagnostics, fails the waiting mailbox request when possible, and requires a fresh contract check before readiness. After rebuilding the GUI, reload the OpenCode service first and then reopen Desktop so the service and renderer use the same contract. Do not probe an unverified pairing.

### Feature controls

`local.settings({})` returns the persisted booleans below. `local.configure(patch)` accepts any strict partial subset and returns the resulting complete settings. The default-location server owns these preferences in plugin storage under `webgpu.features`; writes are serialized, and project/location adapters read the same authority. An unset master starts off unless seeded with `options.webgpu: true`; child preferences initially start on.

| Setting     | Controls                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`   | Master: all local inference, autoload, downloads, microphone/speaker controls, and local agent tools |
| `questions` | General-question API, native ask tool, and question diagnostics                                      |
| `decisions` | Typed decision and System One APIs, both decision tools, and decision diagnostics                    |
| `review`    | Advisory task verification and its Architect guidance; requires `decisions`                          |
| `dictation` | Microphone, push-to-talk command, transcription API, and transcription diagnostics                   |
| `readAloud` | Speaker, speech API, voice control, and speech diagnostics                                           |

```ts
await local.configure({ enabled: false })
await local.configure({ enabled: true, dictation: false, review: false })
const settings = await local.settings({})
```

Turning off a parent masks its children without erasing their choices. Turning everything off releases GPU resources even if the master preference remains on. Disabled features reject new public and worker RPC calls before queueing; their queued/active jobs are cancelled, with renderer acknowledgement required before unrelated work advances. Master off stops loading/downloads/recovery, cancels dictation and speech including prefetched audio, and unloads the model. Cache files, tasks, voice/idle preferences, and child choices remain intact. Disabled model families are not prefetched; enabling another family loads it on demand, preserving one GPU resident model.

The microphone and speaker disappear when their capabilities are off, and disabled push-to-talk does not record. Local tool registrations, Architect permissions, and review instructions are reloaded from current preferences; other location adapters and renderer controls synchronize within the one-second settings poll. Backend RPC admission uses the authority immediately, including calls from an older agent context. These are feature preferences, not a replacement for native permissions. `LocalModel.enabled(feature)` exposes the effective state to GUI contract consumers.

The `review` RPC runs the same System One input/output contract through the separate review capability gate. The native verifier uses it so disabling review cancels its inference without disabling independent decision requests. Ordinary callers should use `systemOne` for general decisions.

## One GPU model, two disk bundles

| Job                                      | Checkpoint   | Cached format                              |    Disk bytes |
| ---------------------------------------- | ------------ | ------------------------------------------ | ------------: |
| General questions, transcription, speech | LFM3-Omni-2B | Q4_K_M GGUF + Q8 projector                 | 1,606,472,608 |
| Native System One decisions              | d1-Omni-2B   | Q4f16 ONNX decoder + tokenizer/calibration | 1,585,665,210 |

d1 is separately decision-trained on the Omni backbone; it does not generate chat, transcripts, or speech. The ONNX Q4f16 graph uses INT4 MLP gate/up weights, INT8 other weights, and FP16 activations. Its vision/audio side graphs are not downloaded: this increment supports text/JSON decisions.

**Only one model may occupy GPU memory.** The FIFO job selects its required model; the previous model's disposal must complete before the next allocation. Cleanup failure prevents allocation. The last model stays warm indefinitely by default. Switching has a cold-load cost that counts toward the request deadline. CPU staging memory is still needed while loading weights.

The Liquid engine remains the default. ruNNtime chat loads the exact `LFM3-Omni-2B-Q4_K_M.gguf` language source; its public audio runner loads that file with the exact `mmproj-LFM3-Omni-2B-Q8_0.gguf` projector. Both are pinned to `LiquidAI/LFM3-Omni-2B-GGUF` revision `3d29af2ad166f8299c2d820937e47dc0add20ffc` and read only through the renderer's existing lease-protected verified cache. The ruNNtime implementation source is pinned in LAZERS diagnostics to commit `4bec7104f2e70290982864963f6b194e6d5439fe`; the tokenizer is pinned separately to Liquid revision `21d75123f86c1f7ffb4bef1ea202710c4e7ebe67`. Its non-weight tokenizer JSON is retained in a bounded in-memory cache, while ruNNtime's weight-range cache adapter streams ranges from the verified disk files without duplicating GGUF ranges in a second weight cache. Chat generation reports the public API's measured token counts. The audio APIs do not expose token counts, so their usage remains explicitly unknown rather than reported as zero.

Displayed model identity and request traces describe the resident backend and its actual sources. Liquid's loader supplies both the Q4_K_M language GGUF and Q8_0 projector, and diagnostics identify both with separate precision labels plus the pinned Liquid engine bundle. ruNNtime text reports its language GGUF and tokenizer; ruNNtime audio reports the language/projector pair, their distinct Q4_K_M/Q8_0 precision, and tokenizer. d1 reports its ONNX decoder, weights, tokenizer, configuration and calibration sources rather than the selected chat route.

Electron main owns the disk cache at `${XDG_DATA_HOME:-~/.local/share}/opencode/plugins/lazers/models/<revision>/`. `options.dataDirectory` changes the existing plugin data root. Binary weights are separate from JSON metadata and `tasks.sqlite`. Files are size/SHA-256 verified, fsynced, then atomically renamed; cached files are reverified on startup and model-family loading. Reads open without following a leaf symlink and compare the file identity/size/timestamps against verification, including a check after reading. A replaced or modified file requires verification again. This detects ordinary replacement/mutation; it is not a sandbox against a privileged filesystem attacker. There is no automatic disk eviction.

Weights stream from disk through typed IPC in reads of at most 2 MiB, with four reads prefetched (8 MiB). Cancelling a response or encountering a failed range aborts outstanding sibling reads. Cache cancellation requires the owning window/token. Cleanup and owner retirement exclude new acquisitions until asynchronous cache work drains. Main-process plugin teardown also awaits that drain. There is no renderer weight download fallback or second browser weight cache. The Liquid engine and ONNX runtime/WASM are bundled locally; ruNNtime code is bundled through its package and its pinned tokenizer JSON may be fetched from the immutable source URL on first load. GPU buffers cannot be persisted to disk; normal driver shader caches remain host-managed. Prompt/KV snapshots and microphone recordings are not persisted.

## Transport, queue, and recovery

Server plugin modules are location-isolated. Public `LocalInference` methods route through the discovered local service's authenticated public client to the separate `RendererInference` mailbox at its default location, matching Desktop's root client. Project chat calls therefore reach the same queue as the GUI. A module-global singleton does not cross these locations.

The renderer polls that mailbox, renews its 15-second heartbeat, claims one job at a time, and completes it through typed RPC. Electron main grants one cache/model-owner lease across Desktop windows. GPU handles never cross RPC. Prompt text, bounded PCM audio, and results necessarily cross the local service; LAZERS does not add them to its logs.

The FIFO holds at most eight queued/running requests. Queue time and model switching count toward the caller's **1–120 second** deadline; tools default to **60 seconds**. A full queue, cancellation, timeout, lost renderer during delivered work, invalid result, or transport failure is an error, never a negative judgment. A cancelled active job must acknowledge completion before the next job starts. An idle unload or expired renderer preserves unstarted queued requests and their original deadlines; delivered work is never replayed. A renderer reporting a failed model load explicitly fails its waiting requests. All work remains ephemeral and is lost when the server plugin is disposed.

Transient network/transport/device-loading errors get one retry, after an abortable 750 ms backoff, within the existing loading deadline. Invalid formats/checksums and unsupported capabilities fail explicitly. Background initial download has a ten-minute ceiling; GPU loading/recovery has a two-minute ceiling. User cancellation interrupts loading and recovery.

`GPUDevice.lost` and either chat engine's device-loss promise abort active work and reload the affected model from verified cache. Recovery is bounded to two recovery attempts per minute; a third loss opens a circuit breaker that background polling cannot bypass. A new explicit request can attempt loading again. Inference is not silently replayed. Native ONNX forward passes cannot be preempted in the middle of GPU execution; the queue waits for cleanup before reallocating. Client deadlines still return an explicit failure. Concurrent unload/dispose callers await the same cleanup. Failed model disposal quarantines that model, retains ownership, blocks reuse/allocation, and exposes a manual cleanup retry even while the master switch is off. Decision tensors are disposed on success, failed execution, cancellation and partial construction. A crashed/reloaded renderer starts eager loading afresh.

Settings refresh and mailbox service calls have five-second transport bounds so a stalled request cannot permanently prevent reconnect polling. Startup load failures have a five-second retry cooldown; successful loading clears it. These bounds do not make the underlying driver preemptible.

Use Desktop's own local service. A remote server cannot access this Electron-main cache.

The authenticated OpenCode service and installed plugins are trusted. The renderer mailbox is an internal transport convention, not a separate authorization sandbox for hostile authenticated clients. Native agent tools enforce permissions before inference. Do not expose this local worker service to untrusted remote clients. See the [adversarial review and release gates](webgpu-adversarial-review.md).

## Explicit renderer CPU capture

Settings → LAZERS → Diagnostics can arm a temporary Electron-main-process CPU
profiler for the next local inference job in that caller window. It is independent
of the local-inference switches: arming does not start, cancel, or reconfigure
inference. Main-process IPC exposes caller-window-scoped status, arm, and
stop/disarm operations. A repeated arm while preparation or capture is active is
idempotent. The UI may close without ending the capture; the main process owns its
deadlines and cleanup.

Arming reports success only after `Profiler.enable`, the 10,000 μs sampling
interval, and `Profiler.start` are acknowledged. DevTools or an existing debugger
attachment is refused without detaching that owner. The profiler waits at most
60 seconds for a new job with request and job IDs in that window; already active
jobs, runtime-only events, and other windows are not candidates. The first target
is immutable. If a job starts during preparation, the capture is explicitly a
preparation-race failure rather than a full profile. Up to 64 target-job stages
are retained (plus a dropped-stage count).

Capture stops on the target's terminal trace, manual stop, renderer
unresponsiveness, a 120-second recording deadline, a 60-second next-job deadline,
or renderer/plugin lifecycle cleanup. Stop is bounded to two seconds. A successful
profile and its metadata are saved separately as `.cpuprofile` and `.json` in the
diagnostics directory. The bounded sanitizer accepts at most 8,192 profile nodes
and 20,000 samples, and the standalone profile is capped at 2 MB; invalid, empty,
oversized, stop-timeout, cleanup-failure, and persistence-failure cases remain
failed metadata and never claim a successful artifact. Metadata correlates
window/PID, request/job, bounded stage history and timing, trigger time, each
profiler command's outcome and timestamps, debugger-cleanup outcome and
timestamps, and capture outcome. A stop failure is not replaced by `job-not-seen`,
and a failed detach cannot be reported as a successful capture.

A timeout or diagnostic disarm does not cancel Electron's native CDP command.
Its result records whether the command remains pending, and the same debugger
transport stays reserved until that command settles; a later explicit capture
cannot overlap it. A late reply updates only the original capture's metadata and
does not change its timeout/abort outcome or detach a later owner. If a late
start acknowledgement or failed stop leaves the profiler not confirmed stopped,
the transport remains reserved even after the command settles. Disarm cancels
diagnostic intent only; it does not cancel inference. If explicit profiler
startup fails, the main process suppresses automatic unresponsive CDP capture in
that window. Explicit retry is possible only after native ownership is resolved.
If a late metadata refresh itself cannot be written, status reports that update
failure separately while retaining the original capture reason and failure.
Metadata does not retain prompt/context contents, audio, scopes, source text, or
arbitrary object dumps.

The existing automatic unresponsive-renderer capture continues when no explicit
capture has failed startup or owns that window. An armed capture handles
unresponsiveness itself so the two profiler paths cannot compete; a failed armed
startup does not trigger a competing automatic fallback.

## General questions

```ts
import { LocalInference } from "opencode-lazers/webgpu/rpc"

const local = client.rpc(LocalInference)
const result = await local.ask(
  {
    prompt: "Summarize this evidence: …",
    maxTokens: 256,
    timeoutMs: 60_000,
  },
  { signal },
)
if (!result.ok) throw new Error(result.error)
console.log(result.text, result.promptTokens, result.completionTokens)
```

`prompt` is 1–8,000 UTF-16 code units; output is 1–512 generated tokens. Chat context is 4,096 tokens, so tokenization may reject a prompt within the character bound. Each call gets an isolated session on the warm model. Usage comes from the engine. Server plugins can `yield* ctx.rpc(LocalInference).ask(input)`; Effect interruption cancels the queue entry.

## System One / JEV core primitives

```ts
import { systemOneClient } from "opencode-lazers/webgpu/system-one"

const decisions = systemOneClient(local)
const result = await decisions.systemOne(
  {
    model: "d1-omni-2b",
    state: { user_request: "Export tasks as Markdown to GitHub issues." },
    questions: {
      destination_named: {
        type: "noul",
        instructions: "Does user_request identify the destination application?",
      },
      feature: {
        type: "choice",
        instructions: "What feature does user_request ask for?",
        criteria: { export: "Exporting task data", deletion: "Deleting tasks" },
      },
      specificity: {
        type: "score",
        instructions: "How specific is the requested export format?",
        criteria: [
          "No format identified",
          "A format family identified",
          "An exact format identified",
        ],
      },
    },
  },
  { signal },
)

result.answers.destination_named.noul // number, probability of yes
result.answers.feature.choice // inferred: "export" | "deletion"
result.answers.specificity.score // expected zero-based rubric position
```

This uses the real d1 decoder logits, not chat generation/JSON parsing or self-reported confidence. The port follows the pinned Liquid `prompt.py`, attention packing, option-token readout, `api.py`, and `calibration.json` temperature. Questions share a packed state; each has an answer slot. Usage reports measured packed input tokens and zero generated output tokens. Score uses the probability-weighted mean (explicitly selected rather than the Python runner's median default).

The local API supports the **text core subset** of System One's request/response shapes: `model`, `state`, named `questions`, `answers`, `usage`, Noul yes probabilities, Choice distributions/top option/confidence, and Score distributions/legend/confidence. Both the server and typed client validate exact question names/types, declared options, normalized distributions, winning choice/confidence, and score/legend consistency with the requested rubric. Non-finite calibration/logits and unexpected decoder output dimensions fail explicitly. The typed client preserves inferred choice labels and throws on errors. Direct `local.systemOne()` instead returns either that response or `{ error }`.

Limits: 1–16 questions; 2–20 choice options; 2–10 score levels; 8,000 serialized request characters; 8,192 packed tokens. `timeoutMs` is a local optional extension. Structured content is serialized as JSON; plain string instructions/criteria are recommended. Unsupported media, boxes, extraction, multi-select, and foreign model IDs are rejected. This is typed **OpenCode RPC**, not an HTTP `/v1/systemone` service or a drop-in TypeSafe SDK base URL.

`local.decide({question, context, decision, timeoutMs})` remains a small convenience API: boolean, exact choice, or score between explicit minimum/maximum. It now calls d1. Boolean uses provisional 0.3/0.7 thresholds, keeping the middle unresolved. Convenience scores map a two-level rubric onto the requested bounds; use `systemOne` for meaningful multi-level scoring. These thresholds are starting points, not calibrated task-admission policy.

## Agent tools and prompt evaluation

`lz-local-ask`, `lz-local-decide`, and **`lz-local-system-one`** are native tools with explicit permission checks before RPC. The opted-in Architect receives these three read-only actions and guidance about atomic questions and unresolved evidence. Disabled experiments leave Architect unchanged.

Following the [official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) and [Liquid decision-model skill](https://docs.liquid.ai/.well-known/skills/decision-model/skill.md): provide the original request, explicit answers, and relevant evidence; ask narrow observable judgments separately; keep actions, arithmetic, permissions, and acceptance in code. Bundle independent questions over shared state. A vague proposal alone cannot establish user intent.

Probe complete, incomplete, contradictory, and negative cases. Retain exact requests and individual probabilities, not only an aggregate score. Uncertain results and missing evidence require clarification. A successful tiny live trial establishes integration feasibility, not model quality or reliable automated admission. The current experiment does not automatically gate `lz-submit-task` or register a native host decision provider.

## Advisory pre-submission hardening

`lz-verify-task({task, request, evidence?, reviewID?})` combines structural validation and the fixed local System One question set. It selects one concern for correction/clarification, preserves review history, and caps a review at three rounds total. Equal-or-better revised scores advance under the user's advisory policy; exhaustion continues with concerns recorded. See the [complete contract and state machine](task-hardening.md). Ordinary submission retains its structural checks and persistence boundary. The [next parallel phase](parallel-task-review-evaluation.md) measures whether this improves task quality.

## Speech and native composer dictation

The native `ComposerPill` contribution shows only a microphone when idle. Recording adds a compact monospace `▁▂▃▄▅▆▇█` history driven by the microphone's RMS level and an elapsed timer. Click to start/stop, or hold **Control+Shift+Space** and release to transcribe. The native `LAZERS → Push to talk locally` command can be rebound in OpenCode's keyboard settings; Command+Shift+Space conflicts with Siri on macOS. Escape, window blur, and session navigation cancel capture. Recordings stop after 30 seconds, release the microphone, resample to mono PCM16 at 16 kHz, and request local transcription through the same FIFO. Generated text deltas enter the native draft using `screen.composer.insert`; the final result reconciles a missed tail. Existing text, mentions, and attachments are not replaced. Nothing is sent automatically; already inserted partial text remains editable.

`local.transcribe({audioBase64, requestID, timeoutMs}, {signal})` returns the normal text/usage result. `audioBase64` is bounded mono PCM16 at 16 kHz, at most 30 seconds. The in-renderer `LocalModel` contract exposes `transcribe(audioBase64, onText, signal)` for streaming into that same window. Remote RPC callers receive the final transcript.

`local.speak({prompt, voice?, maxTokens, timeoutMs}, {signal})` returns text/usage plus optional WAV `audioBase64` (24 kHz, at most 30 seconds). `voice` is `american-female` (default), `american-male`, `british-female`, or `british-male`. These map to LiquidAI's [documented TTS language/gender system prompts](https://huggingface.co/LiquidAI/LFM3-Omni-2B#usage-examples); they are voice directions rather than named speaker identities. Speech uses audio-only generation with depth-decoder temperature 0.4 and repetition penalty 1.2. A segment hitting its generation budget fails explicitly rather than silently playing truncated speech.

The compact speaker icon beside the microphone reads the final assistant step from the latest successfully settled native turn. The chronological session data's `idle` marker closes the turn; `finish: stop`, completed time, and no error are required. Explicit text `native.phase: final_answer` takes priority; `commentary`, reasoning, and tool payloads are excluded. Unmarked providers use final-step text after its last tool. Active, failed, interrupted, and tool-only turns do not fall back to older answers. This follows the pinned host's [phase and commentary convention](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/session-ui/src/timeline/projection.ts#L713), with stricter successful-turn selection for speech.

Speech removes fenced code, Markdown comments, image references, list numbering, and link destinations while keeping readable labels and inline code words. Code-only answers have no speakable control. Dates and numbers remain as written; dedicated locale-aware verbalization is deferred. Sentence segmentation uses `Intl.Segmenter` and preserves complete sentences up to 320 characters / 48 words, replacing the original 120-character cuts. Longer sentences prefer clause boundaries, then words when necessary. All words remain in order.

Playback prepares and decodes one chunk ahead while the current chunk plays; only two chunks are held at once. A prefetched failure waits until current playback ends before reporting the error. This is a sentence audio pipeline: each chunk still completes its bounded RPC synthesis before playback, rather than exposing raw codec/PCM events. Generation retains the 512-token / 30-second audio bound and may buffer when synthesis is slower than playback. Click again to stop both playback and prefetched generation. Navigation and plugin disposal cancel both. Both icons use 28px controls with 15px glyphs; accessible names and tooltips provide labels. The persistent voice picker is in the main LAZERS settings section and applies to read aloud and diagnostics.

Diagnostics provide playback and audio-file STT tests (formats must be decodable by Chromium, such as PCM WAV). Speech is generated by Omni, never by d1. Audio stays in memory unless the user separately saves it.

OpenCode 2.2.5's built-in live voice remains a separate host limitation: its [voice transport](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/voice/transport.ts) hardcodes `gpt-live-1` and WebRTC delegation, and its [core service](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/voice.ts) uses a fixed realtime engine catalog. No public plugin voice-backend hook exists. Dictation integrates with the native composer; this plugin does not claim to replace native live voice.

## Pinned sources

All filenames, sizes, and SHA-256 values are in `src/webgpu/manifest.ts`. The chat engine is checksum-verified at build time; runtime code and WASM are bundled, with no CDN runtime dependency.

- [Omni GGUF](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/tree/3d29af2ad166f8299c2d820937e47dc0add20ffc): `3d29af2ad166f8299c2d820937e47dc0add20ffc`.
- [Official WebGPU engine](https://huggingface.co/spaces/LiquidAI/LFM3-Omni-2B-WebGPU/blob/9c2fb176f4c222da394e8037d3c0d0837f70b978/Lfm3OmniForConditionalGeneration.js): `9c2fb176f4c222da394e8037d3c0d0837f70b978`, SHA-256 `77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb`.
- [d1 Omni ONNX](https://huggingface.co/LiquidAI/d1-Omni-2B-ONNX/tree/2552a495cd0fc6d82f7911110f07bca7a05c11c6): `2552a495cd0fc6d82f7911110f07bca7a05c11c6`.
- ONNX Runtime Web `1.31.1` (WebGPU/Asyncify companion), Hugging Face tokenizers `0.2.0`.
- [System One API](https://docs.typesafe.ai/api/system-one), [Liquid decision guide](https://docs.liquid.ai/guides/decision-model-guide), [model distinctions](https://huggingface.co/LiquidAI/d1-Omni-2B).

Keep upstream runtime attribution and the checkpoints' LFM license with any distribution. This remains a private experiment.
