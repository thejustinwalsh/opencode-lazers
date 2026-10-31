# 001 — Effect host setup

Question: Does the project-local plugin load in the pinned OpenCode host using its Effect runtime?

Increment: Migrate the loaded marker to the Effect entry point and align host-provided peer/dev dependencies.

Scope: Unborn `main` (no HEAD); preserve the untracked scaffold. Writes are limited to the entry point, package manifest/lockfile, and relevant documentation. OpenCode 2.2.5 and Effect 4.0.6 are fixed. Exclude task contracts, persistence, Architect, and paid generation until this slice is retained.

Acceptance: Frozen dependency installation and native quality checks pass. The actual OpenCode host discovers `.opencode/plugins/lazers`, completes Effect setup, and reports the plugin without errors. Record host evidence; an import alone is insufficient.

Execution: One Codex worker using repository instructions, the API lookup, pinned declarations/source, shell tools, and the portless-dev-servers skill. No delegated workers or model calls.

Budget: 25 minutes, 60 tool calls, 20,000 generated tokens, $0 provider spend, and at most one repair attempt. Stop with the concrete unresolved prerequisite if host verification cannot run.

Verification: `bun install --frozen-lockfile`, then `bun run verify`, followed by a host discovery probe. A listening verification host must run through Portless. Source/dependency changes invalidate those checks.

Outcome: Retain. On 2026-10-31, frozen installation, native formatting, lint, and typechecking passed on Bun revision `1.4.4-canary.1+da867c60b`. OpenCode 2.2.5 ran with isolated XDG data/config through `https://lazers-host.localhost:1355`. Its log recorded `LAZERS loaded` with `host=2.2.5`; `GET /api/plugin` at this repository's location returned `lazers`, local loader path, `features.server: true`, and `state.status: active`. The first inventory response preceded asynchronous initialization; a subsequent read confirmed activation. No implementation repair and no model/provider calls. Host log: `/private/tmp/lazers-host-check/data/opencode/log/opencode.log` (temporary evidence). Verification took approximately 8 minutes and used no provider spend.
