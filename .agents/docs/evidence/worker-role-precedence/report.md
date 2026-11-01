# Effective worker role configuration

2026-11-01. Root inspected the native V2 `agent.get` result for
`lazers-implementor` at the main project and the live LZ-40 native worktree.
Both returned the intended `openai/gpt-6-luna#max`, hidden subagent identity and
an empty `system` string. This does not establish the contents of every historical
model request or explain earlier worker failures.

## Cause and correction

The tracked `.opencode/agents/lazers-implementor.md` contained only model
frontmatter. OpenCode's pinned loader always assigns the trimmed Markdown body
to `system`, including an empty body, and its configuration transform applies
that scalar when defined. It therefore overrode the packaged role with `""`.

The model-only preference now lives in `opencode.json` under
`agents.lazers-implementor.model`; `system` is omitted. The empty Markdown override
was removed. The packaged prompt stays in one source, `src/implementor.md`;
no copied prompt, new permission rule or model/provider change was introduced.

## Native observation and limits

After the configuration watcher updated the main location, native `agent.get`
returned 1,642 characters of system instructions, including task-instruction
retrieval, final evidence notes before verification/commit, and checks/observed
behavior as evidence. The model remained exactly `openai/gpt-6-luna#max`.
The already-created LZ-40 worktree initially still returned an empty system
because its checkout retained the old Markdown file. Architect then merged
reviewed main `54e4ecd` through normal worktree updates. Root independently read
the effective role in retained LZ-28, LZ-36, LZ-38 and LZ-40 locations: each
matched `src/implementor.md` exactly, with the same Luna Max route. No role body
was copied into a configuration file and no task was restarted for this repair.
These readbacks verify configuration, not a behavioral improvement or the
contents of every model request.

Quality checks passed after the configuration edit. No GUI build, inference,
background-service restart or feature toggle was used for this observation.

## Sources

- [Pinned Markdown decode and scalar application](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/config/plugin/agent.ts#L114): body assignment at lines 187/209; scalar application at 114. Fetched through the GitHub connector after web raw/blob fetch was unavailable.
- [Official agent formats and merging](https://opencode.ai/v2/docs/agents/): JSON configuration can specify only a model; Markdown bodies become system prompts and later scalar values replace earlier values.
