# 005 — Architect feasibility and definition audit

Question: Can one installed plugin supply a precise native Desktop Architect and support the planned orchestration through public APIs?

Increment: Source-backed capability audit, a shorter packaged agent definition, and self-contained native agent registration. Preserve the current inspection/submission boundary.

Scope: Unborn `main`; extend spikes 001–004. Write the agent definition/registration, plugin setup, focused tests, and source-linked documentation. No execution engine, research/delegation implementation, paid calls, or new dependency framework.

Acceptance: Pinned source establishes the API path and gaps for each requested capability. A packed plugin registers Architect without a repository agent file. The prompt omits schema/policy duplication and unsupported tools. Existing validation/persistence behavior passes. Keep actual Desktop model behavior distinct from package/host validation.

Execution: One Codex worker; skill-creator authoring guidance, official prompting/tool/evaluation research, pinned OpenCode source, Bun tools, and Portless for any listening host. No delegated agents.

Budget: 30 minutes, 70 tool calls, 20,000 generated tokens, $0 paid provider spend, one bounded repair.

Verification: Frozen install, native checks, behavior tests, package contents, and one isolated host probe of the packed plugin. Inspect Desktop through native UI without treating a dropdown alone as model/task acceptance. Prompt quality requires representative model trials; static checks do not prove it.

Outcome: Retain. The [source-linked audit](../architect-validation.md) maps the requested flow to public APIs and identifies unimplemented/runtime verification boundaries. Architect is now packaged and registered without a repository agent file; a clean-project probe against the extracted tarball verified the primary agent, three tools, and native permission decisions. The prompt body is 138 words / 1,057 UTF-8 bytes, down from 529 / 3,807. Sixteen behavior tests (75 assertions) and native checks pass. One bounded test type repair handled readonly matcher types; the temporary RPC probe also needed its required empty events map, now covered by typechecking. No model calls or paid provider spend. Desktop dropdown inspection is limited evidence because `/` was selected. Real Desktop task/question/restart trials and comparative model evaluations remain acceptance gates; the audit does not label prompt quality empirically proven.
