# Working on LAZERS

Follow the progressive dogfood order in README.md. Read .agents/docs/opencode-api.md before changing OpenCode integration. Use the pinned V2 API and keep host adapters small.

Use strict TypeScript and Bun's native formatter, linter, and typechecker. Keep their command names unshadowed by package scripts. Use `bun test` when behavior tests are introduced. LAZERS is one reusable plugin package.

Always auto-fix formatting and lint as part of checks. Use `bun run verify`
(`bun fmt && bun lint --fix && bun fmt && bun check`) plus relevant behavior
tests. Commit mechanical fixes with the change; do not ask a model to repair
formatting or fixable lint failures.

Once our Architect is available in OpenCode Desktop, use it to specify subsequent plugin spikes. Each spike follows the task record and acceptance boundary in README.md. Implement only the current increment.

## Dogfood driver role

The external driver (Codex) acts as the human developer using OpenCode. Present
feature requests, answer Architect's questions, observe trajectories and evaluate
outcomes. Do not proactively steer or take over Architect or worker execution.
Architect owns repair, advice, reassessment and takeover decisions. When stuck or
uncertain about a material decision outside the original plan and prompts,
Architect asks the human through native question prompts, with follow-up questions
as needed. Evaluate whether advice produced progress and whether escalation
worked; delivery alone is not success. Record user-requested driver interventions
as exceptions and potential system failures, not proof of autonomous recovery.

## Product cost basis

Product costs and estimates use configured ordered price sources, independent of execution provider or subscription. Initially offer OpenRouter then OpenCode by default, reusing access configured in OpenCode. Skip unavailable sources; missing applicable prices remain unknown. Preserve chosen-source provenance, exact execution provider/model/effort and measured tokens. Published zeros require source support; session-reported charges are diagnostics, not market rates. Refresh reprices unchanged usage. Price lookup does not authorize inference.

## Development and verification servers

Before launching or restarting a development, preview, documentation, Storybook, application, or networked verification server, load and follow `$portless-dev-servers`. Route project servers through Portless with a stable HTTPS `.localhost` URL. Never silently fall back to a numbered HTTP port. One-shot tests without a listening socket are exempt.

This applies to project-owned servers. OpenCode Desktop and its service are third-party developer tooling: use their supported lifecycle, including the candidate-owned verification launcher. They follow the skill's developer-tool exclusion; project previews inside them still use Portless.

## Stacked pull requests

When stacked pull requests are requested, use the real `gh stack` workflow and applicable repository skill. Root the stack on the current remote default branch. Use non-interactive commands, submit with `gh stack submit --auto`, inspect with `gh stack view --json`, and merge only with `gh stack merge`. Do not substitute ordinary push or PR creation/merge commands.
