# Working on LAZERS

Read [README.md](README.md) for the product overview. Read [the contributor contracts](docs/reference/contributor-contracts.md) for product contracts and task acceptance boundaries. Read .agents/docs/opencode-api.md before changing OpenCode integration. Use the pinned V2 API and keep host adapters small.

Use strict TypeScript and Bun's native formatter, linter, and typechecker. Keep their command names unshadowed by package scripts. Use `bun test` when behavior tests are introduced. LAZERS is one reusable plugin package.

Define workflow states and transitions in XState. Reuse `lifecycleMachines` for
runner lifecycles; do not introduce SQL-only transitions or implicit workflow
states. See [runtime state machines](design/runtime-state-machines.md).

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

## Product cost basis

Product costs and estimates use configured ordered price sources, independent of execution provider or subscription. Initially offer OpenRouter then OpenCode by default, reusing access configured in OpenCode. Skip unavailable sources; missing applicable prices remain unknown. Preserve chosen-source provenance, exact execution provider/model/effort and measured tokens. Published zeros require source support; session-reported charges are diagnostics, not market rates. Refresh reprices unchanged usage. Price lookup does not authorize inference.

## Development and verification servers

Before launching or restarting a development, preview, documentation, Storybook, application, or networked verification server, load and follow `$portless-dev-servers`. Route project servers through Portless with a stable HTTPS `.localhost` URL. Never silently fall back to a numbered HTTP port. One-shot tests without a listening socket are exempt.

This applies to project-owned servers. OpenCode Desktop and its service are third-party developer tooling and follow the skill's developer-tool exclusion. Project previews inside them still use Portless.

### Codex dogfood operator workflow

When Codex operates this repository's dogfood loop, LAZERS Architect owns worker coordination, integration and validation. Codex loads the current integrated plugin in the regular OpenCode Desktop session and exercises the changed behavior there. These instructions govern this repository's operator session. Build the GUI bundle and reload the regular Desktop when GUI code changes. Reload the regular service for server changes at a quiet point and confirm the changed behavior in the app. If a walkthrough finds a defect, give the worker the reproduction and ask it to update its branch. Integrate the follow-up and rerun the affected walkthrough in the same session. Launch a separate Desktop verification profile only when the user explicitly asks for one, and close the profile and its service when finished.

## Stacked pull requests

When stacked pull requests are requested, use the real `gh stack` workflow and applicable repository skill. Root the stack on the current remote default branch. Use non-interactive commands, submit with `gh stack submit --auto`, inspect with `gh stack view --json`, and merge only with `gh stack merge`. Do not substitute ordinary push or PR creation/merge commands.
