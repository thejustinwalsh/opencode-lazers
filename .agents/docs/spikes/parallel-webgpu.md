# Parallel WebGPU experiment

Question: Can the same optional LAZERS package host cached local LiquidAI chat, speech, and genuine System One decisions in OpenCode Desktop's renderer, exposed through native typed RPC and agent tools?

Authority and boundary: The user authorized direct implementation here while the main Architect dogfood sequence continues independently. This is an opt-in experiment (`options.webgpu: true`), not the next numbered main spike. The user expanded the initial bounded chat spike to include genuine d1, single-GPU switching, autoload, recovery, speech, compact dictation, read aloud, and settings. No cloud inference, paid API evaluation, deployment, or PR submission is included. Original initial-spike time allowance no longer describes this expanded scope; no acceptance is inferred from elapsed effort.

Implementation: One reusable package; thin Desktop main cache/IPC, renderer model lifecycle and UI, server queue/RPC/tools. Immutable pinned chat Q4_K_M + Q8 speech projector and d1 Q4f16 weights are verified in plugin storage. Both bundles may be cached; only one model is allocated on the GPU. Autoload and demand loading, optional idle unload disabled by default, transient load retry, and bounded device recovery are implemented. The API reference is `../webgpu-api.md`.

Acceptance boundary:

- Native Desktop startup/request autoload, reusable verified disk cache, settings cleanup, and exactly one resident GPU model.
- Real general question from a native chat tool, genuine noul/choice/score answers through the System One-compatible API and native agent tool, with explicit unresolved failures.
- Actual GPU-device destruction followed by automatic reload and a subsequent successful decision.
- Native composer microphone icon, real RMS terminal-block meter in monospace, hold/release and click recording, draft transcription without autosend.
- Icon-only latest-response read aloud, persisted documented voice directions, cancellation, and usable TTS/STT diagnostics.
- Real Architect request using local decisions; outcomes recorded separately from schema/unit checks.

Live evidence on 2026-10-31, isolated OpenCode 2.2.5 test profile:

- Autoload, Never idle default, combined 3.19GB verified disk cache, collapsed diagnostics, and native chat question passed. Native `lazers_local_ask` returned `agent GPU path works.` with 20 input / 5 output tokens.
- Genuine d1 boolean positive returned true; explicit rejection returned false. Chat-to-d1 switching completed in roughly five seconds in this environment.
- Destroyed d1 GPU device via diagnostic, observed resident `none`/Loading then `decision`/Ready, and reran the rejected-request decision successfully (`false`).
- Control+Shift+Space started recording and releasing moved to transcription. Replaced Command+Shift+Space after the user reported its Siri conflict. Idle mic and speaker icons show without text; recording uses a real RMS-derived monospace history.
- Default local TTS generated playable 1.92-second speech for `The local model is ready.`
- PCM WAV fixture `The blue bicycle is beside the red gate.` transcribed exactly. AIFF failed Chromium decoding explicitly; converted the same fixture to WAV for the successful test.
- Earlier Flint 40B Free native System One attempts emitted malformed JSON or empty arguments before tool execution. These are failures, not d1 results. A different free host model is being tested.
- Main dogfood work rebuilds the shared GUI bundle concurrently; hot reload sometimes invalidates the test queue owner. Live tests must distinguish development reloads from model/device loss.

Verification so far: Bun typecheck and lint pass; full suite 44 tests / 260 assertions passed before the final evidence updates. GUI build succeeds with upstream ONNX Runtime CommonJS `import.meta` warnings; explicit local WASM paths are configured and genuine d1 inference ran successfully.

Subsequent live checks passed: DeepSeek V4.1 Flash Free called the native System One tool with a JSON question collection, returning blue probability 0.9276, export `missing` probability 0.9896, urgency score 0.0247, and 126 input / 0 output tokens. Architect used two local questions about absent destination/latency and opened a native clarification. Speaker-icon playback reached the reading state and click-to-stop returned idle. British English male voice selection survived renderer reload, then the default American English female voice was restored.

## Retained increment: bounded task hardening

Question: Can a weaker primary agent use one known tool to receive specific local feedback, revise structured task state, and terminate without an endless review loop?

Increment and authority: The user directly specified and authorized the optional hardening state machine in this conversation. `lazers_verify_task` runs structural checks plus fixed System One questions, returns one focused concern, advances equal-or-better revised scores, and continues with recorded concerns after at most three rounds total. The [complete contract](../task-hardening.md) records this advisory policy and its limits. This does not implement task execution or alter baseline submission behavior.

Scope: `src/webgpu/review-questions.ts`, `task-review.ts`, `review-tool.ts`, their tests, optional server registration/Architect guidance, and documentation/evidence. Starting checkout remains the shared scaffold with concurrent main dogfood changes; no unrelated source files were reset. Direct implementation here follows the user's explicit override of Architect-only building for this parallel experiment.

Acceptance: Strict structural validation first; concrete question-level findings; one feedback target; three-round cap preserved across host storage resumption; non-regression advancement and limit continuation visibly distinct from resolution; permission before reads/inference; no implicit submission or execution; actual Desktop agent correction loop and retained tool payloads.

Live result: Architect / DeepSeek V4.1 Flash Free made exactly three successful calls under one review ID. Round 1 returned behavior-coverage feedback, round 2 cancellation-coverage feedback, and round 3 `completed_with_concerns`. The agent revised acceptance and the proposed test plan in memory, honestly marked tests unexecuted, and did not submit. The final no-auto-send verification concern was retained at score 0.6578 with disposition `limit`. Input-token counts were 709, 1,287, and 1,300; each returned zero output tokens. [Actual synthetic tool evidence](../../evidence/task-hardening/live-2026-10-31.json).

Outcome: Retain the working advisory loop and its evidence. It demonstrates orchestration and targeted correction, not improved production acceptance rates. The [next parallel phase](../parallel-task-review-evaluation.md) measures defects repaired, false alarms, regressions, and latency against agent-only baselines. Training remains deferred until independently reviewed labels exist.

Completion checks for this increment: `bun test` passed 53 tests / 313 assertions across 17 files; `bun fmt --check`, `bun lint`, and `bun check` passed. Nine tests specifically cover the review state machine and native permission boundary. The retained live tool calls took 6,463ms, 2,780ms, and 3,121ms from execution to completion, including the local service path. These timings describe this fixture/environment only. No paid model calls, submitted tasks, or worker dispatch occurred in the review-loop trial.

## Final-response speech and presentation follow-up

The user requested ordinary review replies without internal dispositions, automatic supported repairs, and native clarification only for missing information or a material decision. Tool descriptions/results and Architect guidance now carry that policy. The [fresh-context trial](../../evidence/task-hardening/presentation-2026-10-31.json) shows three review calls followed by a two-sentence final reply with no internal identifiers, scores, or status names. Primary-agent reporting quality is still measured separately: this host model generalized some remaining verification/scope concerns too broadly, and the strengthened guidance plus evaluation handoff explicitly address that failure.

Read aloud now requires a successfully settled native turn and a completed final assistant step. It honors explicit final-answer/commentary phases, excludes tools/reasoning, and avoids falling back to old answers during active or failed turns. Speech strips code blocks and presentation markup. Dates and numbers stay as written for now.

Sentence playback replaces 120-character cuts with complete sentences up to 320 characters / 48 words, splitting unusually long sentences at clauses or words as needed. One chunk is synthesized/decoded ahead during current playback, preserving order with bounded memory and cancellation. A prefetched failure does not cut off the currently playing audio. The same retained final reply changes from four chunks to two complete sentences (258 and 144 characters). Each chunk still completes synthesis before playback; raw audio-event streaming is a separate transport enhancement.

Verification: `bun test` passed 61 tests / 341 assertions in 18 files; native Bun formatting, lint, and typechecking passed. The GUI bundle builds successfully with the previously recorded upstream ONNX Runtime CommonJS warnings. Desktop selected exactly the final visible reply and reached playback. The first request immediately after the development reload failed explicitly on an old renderer heartbeat; the runtime subsequently became ready and the manual playback retry used the new sentence pipeline. This does not establish failure-free hot reload or automatic replay of active requests.

The [sentence-playback trace](../../evidence/task-hardening/sentence-speech-2026-10-31.json) records the exact new chunks and observed preparation, playback, and return to idle. A subsequent live cancellation check observed speech playing while the GPU was busy preparing the next sentence; clicking the speaker stopped playback and returned the GPU to Ready. Unit checks cover exact ordering, one-chunk lookahead, prefetched-error deferral, and cancellation of both current playback and upcoming synthesis.

## Plugin-wide settings and local feature controls

User-authorized increment: Keep Settings → LAZERS available for the entire plugin, with a master switch for local WebGPU inference and independent switches for local questions, System One decisions, task review, dictation/transcription, and read aloud/speech. Core Architect, task persistence, and the Tasks panel remain available independently. Existing `options.webgpu: true` seeds initial enablement; persisted user settings override it, and an unset preference otherwise starts off.

Implementation: Native settings switches use one server-owned persisted policy, strict partial updates, serialized writes, and shared effective dependency rules. Public RPCs forward to the default-location authority. Jobs carry capability identity so disabling one capability cancels its work without discarding unrelated queued work. Tool registries, Architect permissions, and review instructions reload from current settings. Renderer and location adapters poll preferences every second; microphone/shortcut/speaker, diagnostics, model loading, family selection, download cancellation, recovery, and unloading respect those settings. Turning off everything frees the GPU; cached files and other preferences remain intact. The settings page includes a task-workflow section, capability controls, cache cleanup, voice/idle preferences, and collapsed diagnostics. It also remains registered outside Desktop, where local inference is described as Desktop-only.

Acceptance and evidence: [Retained live settings snapshots](../../evidence/task-hardening/feature-switches-2026-10-31.json) verify master off, questions only, raw decisions with review off, and restored original settings. Desktop confirmed the off preference survived renderer reload, plugin settings stayed accessible, local icons disappeared, disabled push-to-talk did not record, and all-capabilities-off released the runtime. Decision-only configuration autoloaded d1. A typed settings-API master-off call during visibly active speech stopped playback and removed the controls. Cache still displayed 3.19GB; the selected British English female voice and Never idle preference were preserved. Original enabled choices were restored after testing. No cached model deletion or production task mutation was performed.

Verification: The final shared-checkout run passed 65 tests / 386 assertions across 20 files, including settings persistence/dependency/concurrent-write tests and a native server-adapter test covering all disabled inference RPC families, selective cancellation and acknowledgement, tool removal, stale tool execution, and Architect guidance. Bun formatting, lint, and typechecking pass. GUI build succeeds with the previously documented upstream ONNX Runtime CommonJS warnings. The final test profile was restored to all original enabled choices and observed Ready on the final bundle. Model-quality and reporting-quality evaluation remains the separately bounded next phase.

## Adversarial lifecycle and inference hardening

User-authorized production-readiness review: [findings, fixes, verification, trust boundaries and remaining release gates](../webgpu-adversarial-review.md). The retained increment hardens ONNX resource ownership, main cache leases and cleanup, cache mutation detection, stream cancellation, failed-disposal quarantine, concurrent teardown, recovery circuit breaking, queue reconnection, decision response correspondence, microphone resource isolation, and monitoring bounds. The advisory policy and model identities are unchanged.

The final shared suite passed 88 tests / 532 assertions in 26 files, including concurrent main-workflow additions. The GUI builds; native final-bundle System One execution returned noul, choice and score in one agent tool call. Real device destruction/recovery was verified on the initial hardened build. [Synthetic evidence](../../evidence/task-hardening/adversarial-2026-10-31.json) distinguishes those checks and records restored preferences. The isolated test app and its service were closed; the other OpenCode instance was left running. Broad production release remains gated on the pinned host's two moderate dependency advisories and the documented hardware/soak coverage; this is hardened controlled dogfooding, not production certification.
