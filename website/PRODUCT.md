# Product

<!-- impeccable:product-schema 1 -->

> Inferred from `design/brief.md`, `../README.md` and `../docs/` without an interview: this session had no question channel. Every line below is either quoted product truth from those files or marked **Assumption**.

## Platform

web

## Stack

Brief-pinned: static Preact + Vite site in `website/`, StyleX for styling (CSS extracted at build), `@chenglou/pretext` for text wrapping, Lenis for scroll motion. Output `website/dist`, portable, no server.

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
