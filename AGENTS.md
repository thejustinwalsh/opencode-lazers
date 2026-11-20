# Working on LAZERS

Read [README.md](README.md) for the product overview. Read [the contributor contracts](docs/reference/contributor-contracts.md) for product contracts and task acceptance boundaries. Read .agents/docs/opencode-api.md before changing OpenCode integration. Use the pinned V2 API and keep host adapters small.

Use strict TypeScript and Bun's native formatter, linter, and typechecker. Keep their command names unshadowed by package scripts. Run tests with `bun test --timeout 120000 <files>` or `bun run test <files>`, never bare `bun test`: Bun's 5 s per-test default fails correct work on a loaded machine, and on this Bun only the command-line flag applies to every test file (preloads, `bunfig.toml` and environment variables do not). The runtime adds the flag to `bun test` checks that lack one (`src/runner/test-hang-guard.ts`). LAZERS is one reusable plugin package.

Define workflow states and transitions in XState. Reuse `lifecycleMachines` for
runner lifecycles; do not introduce SQL-only transitions or implicit workflow
states. See [runtime state machines](design/runtime-state-machines.md).

Treat the database as the working set: query and page instead of loading history,
store derived views and update them incrementally, read the host by cursor, and own
per-project resources on the project core. See [data handling](design/data-handling.md).

New isolated runner, adoption, retained-verification and combined-check worktrees
use the OpenCode native API under `<canonical-project-root>.worktrees`. The canonical
root is the OpenCode project root, not the current participant checkout or plugin
data directory. Record and reuse the native API's returned directory, including a
collision-adjusted leaf. Existing recorded paths remain authoritative and are not
relocated; shared serial execution stays in its current checkout. Follow
[workspace lifecycle](.agents/docs/workspace-lifecycle.md) for native review,
recovery and non-forced cleanup.

Always auto-fix formatting and lint as part of checks. Use `bun run verify`
(`bun fmt && bun lint --fix && bun fmt && bun check`) plus relevant behavior
tests. Commit mechanical fixes with the change; do not ask a model to repair
formatting or fixable lint failures.

## Commits and the remote

Write atomic Conventional Commits (`type(scope): summary`), one coherent
change per commit. Never add AI attribution or `Co-Authored-By` trailers.
Commit only as the workspace's configured git identity: pass no
`-c user.name`/`-c user.email`, `--author`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
overrides and no fake dates. Keep signing as configured; never disable it with
`commit.gpgsign=false` or `--no-gpg-sign`. Signatures make commit SHAs
non-reproducible, so runtime code must memoize or compare tree OID plus ordered
parents, never rely on recomputing an identical commit SHA.
The remote is `github`; push `main` there when work is done and its checks
pass. Do not rebase or rewrite recorded history: the runtime stores commit
SHAs in integration proofs and plan artifacts, so reconcile with merges.
Change identity lives in git notes on `refs/notes/lazers`; after pushing `main`,
also push `refs/notes/lazers` (`git push github refs/notes/lazers:refs/notes/lazers`).
Bare `git push` is never reconfigured by the runtime.

## Server bundle

OpenCode loads the server plugin from `dist/server.js` (package export `.`), a single
bundle of `src/` with dependencies external, plus worker scripts beside it
(`processor.js`, `repo-worker.js`, `decision-worker.js`). Editing `src/` does not reload
live plugins; run `bun run build:server` (or `bun run build` for GUI too), then reload.
`bun run build:server --watch` rebuilds on every source edit for hot reload. New worker
threads must be added to `scripts/build-server.ts` and spawned via `workerURL`
(`src/worker-url.ts`). Generation is the bundle's content hash.

## Product cost basis

Product costs and estimates use configured ordered price sources, independent of execution provider or subscription. Initially offer OpenRouter then OpenCode by default, reusing access configured in OpenCode. Skip unavailable sources. A missing applicable price is a defect to investigate; when no source prices a model, omit the price UI rather than showing unknown. Preserve chosen-source provenance, exact execution provider/model/effort and measured tokens. Published zeros require source support; session-reported charges are diagnostics, not market rates. Refresh reprices unchanged usage. Price lookup does not authorize inference.

## Development and verification servers

Before launching or restarting a development, preview, documentation, Storybook, application, or networked verification server, load and follow `$portless-dev-servers`. Route project servers through Portless with a stable HTTPS `.localhost` URL. Never silently fall back to a numbered HTTP port. One-shot tests without a listening socket are exempt.

This applies to project-owned servers. OpenCode Desktop and its service are third-party developer tooling and follow the skill's developer-tool exclusion. Project previews inside them still use Portless.

### Dogfood operator workflow

When the external driver (currently Claude Code) operates this repository's dogfood loop, LAZERS Architect owns worker coordination, integration and validation. The driver loads the current integrated plugin in the regular OpenCode Desktop session and exercises the changed behavior there. These instructions govern this repository's operator session. Before dispatching work, check the regular Desktop for pending Architect questions, answer what the existing user decisions cover, and confirm the form cleared. Build the GUI bundle and reload the regular Desktop when GUI code changes. Reload the regular service for server changes at a quiet point and confirm the changed behavior in the app. If a walkthrough finds a defect, give the worker the reproduction and ask it to update its branch. Integrate the follow-up and rerun the affected walkthrough in the same session. Launch a separate Desktop verification profile only when the user explicitly asks for one, and close the profile and its service when finished.

## Stacked pull requests

When stacked pull requests are requested, use the real `gh stack` workflow and applicable repository skill. Root the stack on the current remote default branch. Use non-interactive commands, submit with `gh stack submit --auto`, inspect with `gh stack view --json`, and merge only with `gh stack merge`. Do not substitute ordinary push or PR creation/merge commands.
