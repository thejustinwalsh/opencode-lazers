# LZ132 retained-source review

Task5cdc0405-0e7f-4b18-933d-d0a331b37cd5, original attempt547ae78b-1300-47fe-9aa4-d43461a54379,
native worker ses_f2286bc5414840b1b3fe8d5b1c037b2c. Its actual route was OpenAI
gpt-6-luna/max. The worker stopped on the provider quota error after its assigned
tests and quality checks; it did not submit a final completion. Preserve the
original dirty native worktree and identity.

The implementation attaches advisory metadata without rewriting the specification,
uses transactional expected revisions and exact replay, and projects current advice
through shared structured/readable getters. The worker's last completed checks were
18 tests/230 assertions,91 tests/779 assertions and quality. Root additionally ran
the actual shared-contract GUI build and process-free bundle smoke successfully;
the initial Root sandbox EPERM creating dist was an execution-environment issue,
resolved by the authorized build in the retained worktree, not a product defect.
Log: `/private/tmp/lazers-task132-retained-gui-review-20261104.log`.

## Correction before integration

`src/tasks/advice.ts` imposes a lifetime20-revision write ceiling: after20 valid
corrections the next attachment conflicts solely because history is full. Its
existing test explicitly expects that rejection. Bounded effective guidance and
bounded read responses do not require stopping future corrections. Retain history,
bound its projection progressively, and demonstrate another correction beyond the
current ceiling without changing task bytes or silently losing earlier records.
This is a finding for the original worker, not a new task or replacement attempt.

Also omit the readable empty-advice heading/message for tasks without an attachment.
The structured null already expresses absence; every legacy task need not pay for
an extra prose section. Current advisory content and required provenance should
remain available when advice exists.

The registered native attach/read walkthrough remains pending after installation.
Fixture tests and the GUI build do not establish that live gate, acceptance or
completion. Root has made no edits to the retained worker's source or lifecycle.
