# First real product wave — driver observations

## Actual native isolated overlap

Existing plans `b50a1a71-1a54-4d89-8ef2-0644bcccc327` and
`8d505ab3-e279-4c54-bd0f-dc5169f228e9` run from committed main
`9b0ab5efec71fa5935695b92bacf9592a745ef86`. Their admitted schedule is preserved:
b50 priority 20; Go UI priority 30. No replacement tasks, demo graph or duplicate
Run was created. Stale driver scheduling requests were rejected without mutation
after the user had already admitted both plans.

At epoch milliseconds **1793478154501–1793478154503**, public native
`session.get` calls returned all three sessions busy, in project
`b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`, agent `lazers-implementor`, each in a
different scheduler-owned native worktree. Busy is based on native busy/idle
timestamps; an existing `outcome:"succeeded"` field during a busy session is not a
completed-worker or acceptance observation.

| Task                                                     | Attempt/worktree suffix                | Native session                         | Exact selected route               |
| -------------------------------------------------------- | -------------------------------------- | -------------------------------------- | ---------------------------------- |
| Projection `efd8459f-1dbe-4472-968b-f26f59504291`        | `7eaa8182-bc03-4200-9086-78a28bf709f2` | `ses_24973c3a02bf468787ea501e79e71813` | `openai/gpt-6-luna#max`            |
| Speech `3af64c61-ff16-43a9-8983-a11763ccf415`            | `963f6a39-fadb-4de1-982b-22b548668e7c` | `ses_51ea19be1f964b8baf0c6225fe833c35` | `openai/gpt-6-luna#max`            |
| Tasks affordances `7548e7f8-d33b-4768-b8a1-9c81222da176` | `e7f473db-3716-49fa-8075-c81be5b924ad` | `ses_de0ba270cb044fac97f46f3b275e45df` | `opencode-go/qwen3.8-flash#medium` |

Each directory is under
`/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/<suffix>`.
Persisted `WORKER_STARTED` observations: Go activity 460 at 1793478046435;
speech activity 483 at 1793478050537; projection activity 485 at 1793478050539.
This is real native overlap, not inferred from topology or sequential fake-host
calls. It does not establish comparative model quality, savings or completed
combined acceptance.

## Actionable native queued wake consumed

The runtime's real permission-plan blocked outcome v9 produced
`msg_b6a81e4524b442418c977c4996b3fca2` for Architect
`ses_e6e0e6239ffdtzIePMeJ1sHA4l`, with resume requested. Earlier native inbox
inspection found it queued with the concise action “Inspect this blocked plan
and resolve the recorded cause using its allowed actions.” It was not manually
injected by the driver or attributed to a demo task.

The corresponding native notification subsequently resumed this Architect. At
**1793478400308**, `session.message.get` returned that exact ID as `synthetic`
with the same actionable text and plan identity; `session.inbox.list` no longer
contained it. The notification is stale relative to permission plan integration
v13, so the resumed Architect did not redispatch, reintegrate or retry it. Native
admission/consumption is distinct from the earlier runner outbox delivery receipt.

## Completed integration sweep and limits

Repomix and Tasks plans reached integrated v13 after exact-artifact focused/full/
quality verification (Tasks also GUI build), each with `unchanged:true`; prior
advanced-checkout and missing-dependency failures were retained. Runtime native
cleanup removed their clean merged verification worktrees without force.
Scheduler/title/native-route results were already integrated. Concurrent external
runner, storage/disposition and prompt changes were not edited by this driver.

Legacy retirement used native durable disposition records 1–5: `75f62b3b` rejected;
`94298112`, `2d955ffa`, `313174d7` and `9dde2941` superseded, not fulfilled.
Default queries exclude them; `includeRetired` retains immutable specifications,
reasons, related task IDs and code/test/native evidence. Missing original
specialist/model-inheritance/permission/current-web trials, exhaustive native
theme/font/restart tests and other unobserved legacy gates remain explicit in
those records. Absence of old unplanned audit findings is not proof of fulfillment.

Product branch acceptance, reviewed combination, current running panel/speech
captures and Terra review remain pending. No inference code/settings, enabled
switches or canceled inference work were changed. Lifecycle remains a separate
follow-up: cache policy must be keyed by native provider/model/options with user
override and fallback; API cache documentation is not proof of ChatGPT retention.
