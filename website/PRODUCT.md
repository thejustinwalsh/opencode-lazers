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
- Local WebGPU inference is optional and off by default.
- Local inference (`../docs/reference/user-controls.md`, `../src/webgpu/`): one switch, "Run local models on this device", in Settings, LAZERS. Five features, each its own switch: local questions, System One decisions, task review (advisory, needs decisions), dictation, read aloud. Two models, each downloaded on first use into its own cache: D1 (about 625 MB) for decisions, Omni (about 1.6 GB) for questions, dictation and read aloud. Decisions are typed: yes or no, a choice from a list, or a score in a range (`../src/webgpu/decisions.ts`). "Keep model loaded" sets how long an idle model stays in GPU memory. Turning it off releases GPU memory; downloaded models stay on disk until removed. The session-header icon (`../src/webgpu/indicator.tsx`) reads Loading, Available, Working or Error while on. Workers do not run on the local model: they are native OpenCode sessions on routed models.

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
