# Native completion and renewal observations

Read-only native session and LAZERS DB inspection at1793859945042/5047:

| Worker                         | Native busy   | Native idle   | Busy window | Result                            |
| ------------------------------ | ------------- | ------------- | ----------- | --------------------------------- |
| LZ99 original027e143b          | 1793854753222 | 1793859776335 | 83m43.113s  | succeeded; source29e291a +be50616 |
| LZ135 resumed originald0930725 | 1793857765449 | 1793859547774 | 29m42.325s  | succeeded; source374a599          |

These session activity windows overlap29m42.325s in separate native worktrees;
they are not simultaneous GPU/model-compute measurements. LZ99 reports169 recovery
and344 runner/progress tests passing. Root independently reproduced and verified
its fresh-failure correction. LZ135 is merged as26f0825; Root's postmerge69 tests/
660 assertions, lint and typecheck passed. One unrelated Markdown indentation
issue was autoformatted. No native task acceptance is claimed from source landing.

## Completion observer loses valid live lineage

LZ135 runner_progress records a real zero-background idle hook at1793859547643,
then idle-lineage-unavailable at1793859547760 for its current assigned input
msg_b86cf7dcc9af417abb54ebf23481fe6c and execution start1455. Its worktree listener
was d9633764 at1793857963626 and a48b967b at final idle. The durable idle row still
contains the old start7/report873/input118166; success event2860 invalidated it.
The current hook is observed, but its listener lacks the local start map entry.
This explains the rejection; the trigger of listener replacement remains unproven.
Do not reconstruct a historical idle report or send a certificate prompt.

## Renewed Architect hits native delegation depth

Successor ses_04072d58d16c46b0a8b13f7db3e08737 is legitimately reviewing LZ99.
Its subagent call failed with `Subagent depth limit reached (1)` at1793859817149.
Runtime renewal supplies parentID=previous_session_id to native createArchitect
and requires that parent in renewalSuccessorMatches. This creates nested successor
sessions. The existing native adapter already supports parentless creation with
an explicit location, retaining source identity in metadata. Review that path for
fresh coordinators within the queued renewal work; no configuration limit was raised.

Both findings were delivered through Desktop to the root Sol High Architect.
The renewed coordinator was left running because its review is actionable.
No additional legacy ownership transfer or production SQL mutation occurred.
