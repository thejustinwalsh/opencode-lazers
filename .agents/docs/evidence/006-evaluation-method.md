# Desktop trial method and limits

All model prompts and answers were entered through native OpenCode Desktop computer interaction, using the connected ChatGPT subscription. Native session Export supplied the retained focused traces. Reasoning content, encrypted metadata, and repository-read outputs are omitted. No paid OpenRouter calls were made.

Each scored session started before the first user message. Forks retained model-switch metadata but no previous task discussion or interview answers. The feature-only input was:

> Make LAZERS task submission safe to retry when submission succeeds but its response is lost. Retrying the same logical submission must return the original task ID, including after a host restart, without creating duplicate tasks.

The Luna Max, Luna Low, and final Sol High interviews received this controlled answer:

> Require a caller-supplied idempotency key scoped to the repository, reusable across sessions and host restarts. The same key and validated task content return the original task ID; changed content with the same key returns a conflict. A different key may intentionally create an identical task. Preserve validation and repository isolation. Limit this increment to task submission; exclude workers, dispatch, scheduling, and GUI changes.

Sol also asked whether the key was mandatory; the selected answer was its recommended required-key option, consistent with that contract. The earlier baseline received an explicit-key answer and the user's scope paragraph, so it is not a fully controlled old/new comparison.

The full definition file (including frontmatter) used for both Luna trials has SHA-256 `78ed7f1c439ef26e8b71638c3d3f3f2741ef3f9f19b3dd37c5004354de403c4d`. Its body is 164 words. The final file, whose body is 171 words, has SHA-256 `ecf2251fc6cff121da67d60cfa4d2571dc8f04f460655efb6c0f1eb9e94f0aab`. The only subsequent prompt change strengthened requirement-to-acceptance mapping and checks that expose incorrect implementations at the claimed boundary. It contains no retry, idempotency, database, or restart-specific instruction.

Temporary `dataDirectory` configuration isolated the trials from normal task records. Both Luna tasks landed in `/private/tmp/lazers-interview-20261031/luna-max/tasks.sqlite`: a concurrent WebGPU import error prevented the intended switch to `luna-low`. The Low session did not retrieve the Max task or receive its answers. Final Sol used a new `sol-high` database after a user-authorized background-service restart cleared the stale failed module import. Native Desktop Restart had restarted only the window. The maintenance command did not drive any model session.

These trials assess one fixture across models and reasoning settings, with one final changed-definition run. They do not establish generalization, statistical reliability, a minimal optimal prompt, or equivalence between reasoning settings. A rejected workflow-choice candidate and an initial Luna run that retrieved the existing baseline task are excluded. Manual waiting is included in Desktop elapsed times, so those times are unsuitable for a latency comparison.

Zod/tool validation proves structure, references, paths, and budget fields before persistence. It does not establish semantic completeness or prove that a future implementation satisfies the task. The task remains `submitted`; no retry feature, scheduler, or execution engine was implemented by this evaluation.

API-equivalent estimates use exported uncached input, cache reads/writes, visible output, and reasoning separately. Reasoning is charged at output rates. On 2026-10-31, standard OpenAI-provider rates on [OpenRouter Sol](https://openrouter.ai/openai/gpt-6.1-sol) were $2/$0.10/$2.50/$10 per million uncached input/cache read/cache write/output tokens. [OpenRouter Luna](https://openrouter.ai/openai/gpt-6-luna) rates were $0.10/$0.01/$0.125/$0.50. These are estimates, not subscription charges. Pinned [OpenCode usage mapping](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/usage.ts) records visible output and reasoning as separate fields; both must be counted.
