# Existing renewal follow-through: fresh top-level Architects

Root observed genuinely active owner
`ses_04072d58d16c46b0a8b13f7db3e08737` fail delegation with “Subagent depth limit
reached (1)”. Leave that owner and its99 review running. This is not approval to
transfer58 unfinished plans, rewrite active parents or raise configuration limits.

Read-only Luna research confirms `runtime.ts` supplies the predecessor as native
`parentID` and requires it in `renewalSuccessorMatches`. The pinned2.2.5 native API
already supports top-level creation: **omit** `parentID` (not null), set explicit
`location.directory`, and retain the selected agent/model and metadata. Existing
`native.ts` parentless handling already supplies location. Pinned host/protocol:

- `https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts`
- `https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/protocol/src/groups/session.ts`

Use the durable renewal ID as a native metadata marker, retaining predecessor and
plan IDs and the existing source journal. New successor matching should bind exact
renewal metadata plus successor ID/project/location/agent/model/plan identity,
without requiring a parent. Preserve exact variants, including an explicit empty
variant. Existing nested renewals lacking the new marker need their legacy
parent/source matching for recovery; do not reparent or rewrite their history.
Correct handoff text that currently says the predecessor is “linked as parent”.

Discriminating regressions: fresh creation has no parent and the explicit location;
stable successor-ID/lost-create-reply/reopen recovery retains one correctly bound
successor; legacy nested recovery stays compatible; foreign or unbound parentless
sessions cannot trigger ownership transfer or predecessor archival. Preserve
current-input/version/race/continuity and plan-transfer authorization fences.

The existing134 scope covers runtime/native/outcome/store/schema/tools and their
tests. Threading a renewal ID through `RunnerHost.createArchitect` also touches
`src/runner/host.ts`, currently outside that scope; obtain a narrow supported scope
amendment when implementation is admitted. This advice does not amend the held
task or bypass integrated133/source reservations. No duplicate renewal task.

Root's post-activation native qualification must show a fresh top-level Architect
can actually delegate while original predecessor references/journal navigation and
authorized plan ownership remain correct. Fixture or metadata-only success is not
that qualification. No live sessions, inputs or ownership were changed by this
research; native listener-lifecycle work remains a separate current dependency.
