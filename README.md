# LAZERS

Turn a feature request into tracked work in OpenCode.

LAZERS adds an Architect agent, a task runtime, and Desktop panels to OpenCode. Architect defines the work. The runtime schedules native OpenCode workers, records checks, and returns results for review. An optional per-project limit in Settings caps delegated agents (Implementors, Auditors and native subagents); Architect work is not counted.

LAZERS is developed and tested against OpenCode 2.3.0, the version pinned in this repository. The published v0.1.0 release was tested with OpenCode Desktop 2.2.6. These tests do not promise compatibility with other versions.

## Start here

- [Complete a first task](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/tutorials/first-task.md) in an OpenCode project.
- [Install or upgrade LAZERS](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/how-to/install.md) with OpenCode's plugin installer.
- [Find the user controls](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/reference/user-controls.md) for tasks, models, and local features.
- [Roll out and probe delegated-agent capacity](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/how-to/delegated-agent-capacity-rollout.md) across worktrees and native helpers.
- [Understand the workflow](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/explanation/workflow.md) across Architect, the runtime, workers, and you.

LAZERS runs through OpenCode's service and Desktop. It does not need a separate LAZERS service. Local inference is optional.

## For contributors

Read the [contributor contracts](https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/reference/contributor-contracts.md) before changing product behavior. Use [DESIGN.md](https://github.com/thejustinwalsh/opencode-lazers/blob/main/DESIGN.md) for panel design work.
