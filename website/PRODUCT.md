# Product

<!-- impeccable:product-schema 1 -->

> Inferred from `design/brief.md`, `../README.md` and `../docs/` without an interview: this session had no question channel. Every line below is either quoted product truth from those files or marked **Assumption**.

## Platform

web

## Stack

Brief-pinned: static Preact + Vite site in `website/`, StyleX for styling (CSS extracted at build), `@chenglou/pretext` for text wrapping, native scrolling with CSS scroll-driven animations for motion (no smooth-scroll library). Output `website/dist`, portable, no server.

## Users

**Assumption:** developers who already use OpenCode (Desktop 2.2.6 is the tested host) and want feature requests turned into tracked, checked work rather than one long chat session. They arrive from GitHub or a link, decide in a minute whether LAZERS fits, then install from a release archive.

## Product Purpose

"Turn a feature request into tracked work in OpenCode." LAZERS adds an Architect agent, a task runtime, and Desktop panels to OpenCode. Architect defines the work. The runtime schedules native OpenCode workers, records checks, and returns results for review.

## Positioning

Judgment and task state are separate. Architect makes decisions that need context; the runtime owns scheduling and lifecycle transitions, and routine transitions do not call a model. A worker report is not acceptance, and LAZERS does not merge or publish because a worker says it is done.

## Operating Context

- Runs inside OpenCode's service and Desktop; no separate LAZERS service.
- Panels: Tasks (`/lz-tasks`), Radar (`/lz-radar`), Trajectory (`/lz-trajectory`), Models (`/lz-models`).
- Independent tasks can use OpenCode-managed worktrees; conflicting write scopes serialize.
- Local WebGPU inference is optional and off by default in the product. The website's Local section is the exception: it runs the real Omni model in the visitor's browser, but only after the visitor acts (see Live local chat).
- Local inference (`../docs/reference/user-controls.md`, `../src/webgpu/`): it runs inside the OpenCode Desktop window's renderer on WebGPU (`navigator.gpu`) through [ruNNtime](https://docs.swmansion.com/runntime/) and [TypeGPU](https://docs.swmansion.com/TypeGPU/) (`../src/webgpu/runtime.ts`, `runntime-adapter.ts`); the plugin server reaches it by RPC. Nothing is spawned or listening in `src/webgpu/`: no separate process, server, port, native binary, Python or llama runtime, account or API key. Weights download once from [Hugging Face](https://huggingface.co) into the plugin cache (`../src/webgpu/cache.ts`) and can be removed; inference itself uses no network. Say "inside the Desktop window", not "sandboxed". One switch, "Run local models on this device", in Settings, LAZERS. Five features, each its own switch: local questions, System One decisions, task review (advisory, needs decisions), dictation, read aloud. Two [Liquid AI](https://www.liquid.ai) models, each downloaded on first use into its own cache: [D1](https://huggingface.co/LiquidAI/d1-omni-600M) (`LiquidAI/d1-omni-600M`, about 625 MB) for typed System One decisions and advisory pre-submit task review (single forward pass, zero output tokens), and [Omni](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) (`LiquidAI/LFM3-Omni-2B-GGUF`, about 1.6 GB) for local questions, Speech-to-Text microphone dictation, and Text-to-Speech read aloud. Decisions are typed: yes or no, a choice from a list, or a score in a range (`../src/webgpu/decisions.ts`). "Keep model loaded" sets how long an idle model stays in GPU memory. Turning it off releases GPU memory; downloaded models stay on disk until removed. The session-header icon (`../src/webgpu/indicator.tsx`) reads Loading, Available, Working or Error while on. Workers do not run on the local model: they are native OpenCode sessions on routed models.
- Purposeful upstream tools and technologies referenced in the copy link to their project or model pages: [OpenCode](https://opencode.ai), [XState](https://stately.ai/docs/xstate), [Fallow](https://fallow.tools), [OpenRouter](https://openrouter.ai), [Liquid AI](https://www.liquid.ai), [D1 (`LiquidAI/d1-omni-600M`)](https://huggingface.co/LiquidAI/d1-omni-600M), [LFM3-Omni-2B (`LiquidAI/LFM3-Omni-2B-GGUF`)](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF), [ruNNtime](https://docs.swmansion.com/runntime/), [TypeGPU](https://docs.swmansion.com/TypeGPU/), and [Hugging Face](https://huggingface.co).

## Capabilities and Constraints

- Published release: v0.1.0, tested with OpenCode Desktop 2.2.6. This test does not promise compatibility with other versions.
- Install: release archive via `bun add --ignore-scripts`, then one global `plugins` entry in OpenCode config.
- v0.1.0 does not dispatch dedicated investigator or researcher roles.
- Cost estimates depend on measured usage and configured price sources; missing usage or prices stay unknown. The provider budget indicator reports usage and does not enforce a budget.
- "Scheduler" is the runtime's scheduling role (`docs/reference/contributor-contracts.md`); the docs call the whole thing "the runtime".

## Brand Commitments

- Name: LAZERS (all caps). Repository: https://github.com/thejustinwalsh/opencode-lazers.
- Supplied art: `design/cat.png` (pixel cat with cyan and magenta eyes), `design/marks.png` (flag, halftone corner, sparkle, speed stripes).
- The marketing site is separate from the LAZERS Desktop panels and their DESIGN.md.

## Evidence on Hand

README, install guide, workflow explanation, first-task tutorial and user-controls reference in `../docs/`. No testimonials, users, benchmarks, pricing or adoption numbers exist; do not invent them.

## Product Principles

1. You set the goal and decide when to publish.
2. Judgment goes to Architect; state transitions go to the runtime.
3. Evidence over claims: checks, attempts and usage are recorded; unknowns stay unknown.
4. Live inside OpenCode, not beside it.

## Accessibility & Inclusion

**Assumption:** WCAG 2.2 AA. Brief requires reduced-motion parity, keyboard navigation, real HTML text, and original text available to assistive technology when enhanced layout runs.

## Live panel demos

The page shows the real panels, not mock-ups. `Demo` (`src/Demo.tsx`) lazily creates an iframe of `/demo/`, which mounts one real SolidJS panel from `../src/` (Tasks, Radar, Trajectory, Models, and the local-inference indicator) inside a stand-in OpenCode host, answering the panel's reads from a recorded story and performing simulated user actions as real DOM events.

- Source: `demo/` (entry `demo/src/main.tsx`, stand-in host `demo/src/host.tsx` and `ui.tsx`, replay engine `demo/src/engine.ts`, per-panel answers `demo/src/panels/*-answers.ts`, stories `demo/stories/*.ts`).
- Build: `bun scripts/build-website-demo.ts` from the repo root (`bun run demo` in `website/`; `bun run build` runs it first). It uses the repo's `solid-js` and the real panels, validates every story state's reads against the panels' contract schemas (a contract change a story no longer satisfies fails the build), builds with a relative base into `public/demo/` (git-ignored) and writes the compiled stories as JSON beside it. The homepage has no new runtime dependency.
- Stories are TypeScript (`defineStory`): timed steps with a data patch and user actions (`hover`, `click`, `type`, `key`, `scroll`, `wheel`, `wait`) on CSS selectors of the real panel DOM, plus chapters with captions. Chapters declare `setup` actions so seeking to a chapter reproduces the same UI state. Data is invented: project code LZ, references LZ-2xx, fictional models and prices; nothing comes from a real machine or database.
- Page copy that must show without the iframe (step captions, size) lives in `src/demos.ts`; the demo build fails if it differs from the stories.
- Protocol (`src/lib/demo-protocol.ts`): the iframe posts `ready`, `chapter`, `pointer`, `view`, `end`; the page sends `play`, `pause`, `seek`. Both sides check origin, source and a `demo` tag.
- Motion: the iframe is created one viewport early and plays only while a third of it is visible. With reduced motion it shows the final state of the last step, does not autoplay, and a step button jumps to that step's result. The iframe is `inert` and `aria-hidden`; a text summary and the step list sit beside it.
- Smoke test: `bun test website/demo/test/stories.test.ts` mounts every chapter of every story in a DOM and fails if an action's selector matches nothing.

## Live local chat

The Local section holds a chat that really runs the local model in the visitor's browser: text chat, speech to text and text to speech on WebGPU through ruNNtime. It is real page UI (`src/live/`), drawn with the same host tokens as the panel demos; it replaces the earlier status-icon replay.

- Nothing heavy loads until the visitor acts. The page ships only the chat UI and its state machine (`src/live/machine.ts`, a pure reducer with unit tests in `test/live-machine.test.ts`). The first message, or the first microphone click, dynamically imports `controller.ts` and starts a module Worker (`worker.ts`) that holds ruNNtime and typegpu. The homepage bundle contains no ruNNtime code and no weights.
- The opening assistant message states what will happen: the [LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) weights (`MODEL_BYTES` from `../src/webgpu/manifest.ts`, about 1.6 GB) download once into this browser's storage, then text, speech-to-text and text-to-speech run on this device's GPU through [ruNNtime](https://docs.swmansion.com/runntime/). Model constants (repository, pinned revision, file names, sizes, SHA-256) are imported from the product's manifest, not copied.
- Cache: the Origin Private File System, in a worker. Each file is fetched in 32 MiB ranged requests straight into an OPFS file through a sync access handle, hashed while streaming (`sha256.ts`) and checked against the manifest's SHA-256; an interrupted download resumes at its last whole segment. ruNNtime reads the weights through `RangeSource`s over `File.slice`, so the weights are never held in memory. Only the tokenizer JSON goes through ruNNtime's own `createOpfsCache`.
- Progress is the assistant's working turn: per-file bytes and percent, then "Loading onto the GPU", then the streamed answer. Messages typed meanwhile queue behind the first. Stop pauses the download (resumable) or stops generation and drops the queue; failures offer Retry; a returning visitor sees "Loaded from this browser's cache".
- Automatic read aloud is on by default. The speaker pill mirrors the product's: click stops or re-reads, Shift-click toggles automatic read aloud (a long press does it on touch). The microphone pill records on click and transcribes on click, shows the product's level meter and timer, and, like the product's dictation, inserts the text into the composer without sending it.
- Hidden tabs release GPU memory after two minutes (`HIDDEN_UNLOAD_MS`); the Unload control does it on demand. Weights stay in browser storage.
- No WebGPU: the chat shows the dimmed frame with one play button. A click plays a recorded session of the same chat (`public/live/session.json` plus audio in WebM Opus and MP4 AAC), captured from a real run of the model by `scripts/capture-live-session.ts`; nothing is fetched before the click. The same recording is offered, never forced, when the live path fails.
- Privacy: prompts, answers, audio and transcripts stay in the page and its worker. The only network use is the weight and tokenizer download from Hugging Face; `test/e2e/live-chat.mjs` records every request. No analytics.
- Safari: WebGPU is on by default from Safari 26; earlier versions show the recording. Not run in this repository's checks.
- Real-browser test: `test/e2e/live-chat.mjs` (Playwright, headless Chromium with WebGPU) fulfils the Hugging Face requests from the product's on-disk model files, so the page's real download path runs without a network download. It is not part of `bun test`.
