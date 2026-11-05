# LZ132/137 native qualification and completed integration

Observed by Architect `ses_e568438ebffeaoFbF9nBb942XM`; no new worker turn.

## Source and adoption

Root first merged accepted132 base `e67fee195776f6da333e44a9068444817b08c117`
at `e4104ee4ba597281d954ece5ec708ad4d2a2d35b`. Task-only integration recorded
that exact baseline at planversion26, keeping the combined live gate open.
Root then merged independently reviewed137 correction `7262d827` with ancestry.
Main stayed clean at `cf46320948d04e4932fe09305dc5a9c1a49ddf81` throughout adoption,
native walkthrough and integration.

Supported adoption `044eb65e-6fed-413b-b638-b86dad63f8fd` bound original132 task
`5cdc0405-0e7f-4b18-933d-d0a331b37cd5`, attempt
`547ae78b-1300-47fe-9aa4-d43461a54379`, original accepted artifact and recorded
baseline to corrected task/combined artifact `cf463209`. Fresh adoption checks:

- Task advice18 tests/239 assertions; compatibility94 tests/797 assertions;
  formatting/lint/types/diff checks pass.
- Combined task-advice94 tests/797 assertions and quality pass.
- All5 checks completed, exit0, unchanged and no timeout. No worker dispatched.

## Actual Code Mode attachment and reads

The live Code Mode catalog exposed `lz-attach-task-advice`; Code Mode invoked it.
This was not direct callback execution, fixture RPC, a repo note or a session
instruction entry.

At `2026-11-05T08:16:23.620Z`, attachment to existing132 recorded advice revision1
for specification1 and expectedRevision0, request
`lz132-native-qualified-advice-20261105-v1`. Host provenance names the above
Architect session, agent `architect`, canonical project and original task.
Concise useful findings/advice cover shared task/read projections, immutable
authority, Code Mode exposure, CAS/exact retries and the history-count scaling
limitation, with corrected-artifact source references.

Exact request retries returned `replayed` with identical advice receipt, revision,
provenance and original timestamp; historyCount remained1. The first observation
check compared whole response wrappers and reported inequality because initial
`recorded` and retry `replayed` statuses differ as designed. Correct semantic
validation at `2026-11-05T08:17:05.083Z` compared the advice receipt, timestamp,
revision and history: every check passed. This was correction of an overly strict
observation check, not a concealed product failure or changed-content replay.

Fresh `lz-get-task` and `lz-get-task-instructions` calls both ran through Code
Mode, exposing matching effective advice/revision/host provenance. The readable
getter returned a string containing every finding/advice item and recorded
session/timestamp. Before/after immutable132 task envelope, original132 attempt
and execution, and original129 task/attempt/execution were unchanged by attachment.
No worker prompt, restart, replacement, implicit reference retrieval, private DB
write or inference was used. Read availability is not model consumption.

Combined human evidence `native-attached-readback` was recorded against the exact
adoption ID and corrected combined artifact. Runtime adopted the descendant and
accepted the combined plan atversion29; it did not manufacture native-idle history.

## Actual integration and native non-forced cleanup

- LZ132 task landing recorded atversion30; combined integration requested31;
  plan `10964078-2262-4b2c-8f5a-101222a16e55` is **integrated/version32**,
  corrected artifact `cf463209`,14 completed effects and none pending.
- LZ137 task landing recorded10; combined integration requested11;
  plan `181baf24-b3dc-49c5-adad-338d0ec9fe34` is **integrated/version12**,
  artifact `7262d827`,8 completed effects and none pending.
- Runtime worktree-remove receipts identify native removal. The actual adapter
  `src/runner/native.ts:365–371` calls native removal with `force:false`.
- At1793867009390/391, both original native sessions were still readable,
  unarchived and bound to original attempts:132 `ses_f2286bc5414840b1b3fe8d5b1c037b2c`,
  137 `ses_fa6c346c44b04d5c9de8f895674664ed`.
- Filesystem readback confirmed both original worktree paths absent, plus both
  `adoption-044eb65e-6fed-413b-b638-b86dad63f8fd-{task,combined}` worktrees absent.
  No forced deletion or history/session removal was performed.

Original127/129 worktrees, accepted artifacts and review findings remain separate
and preserved. Completion of132/137 does not clear their outstanding work.
