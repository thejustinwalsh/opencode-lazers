## Takeover

`lz-request-handoff {attemptID, reason}` is one blocking call: it tells the worker, gives it five
minutes to commit and write its handoff, stops it and returns the handoff (the worker's, or a note
that it wrote none), recorded facts (failing checks, concerns, attempts), the workspace, its commits
and uncommitted paths. Read the handoff and the trajectory before you write.
Then edit and commit in that workspace and send it with `lz-plan-command
{action:"takeover-submit", planID, taskID, reason}`; the runtime verifies it
like any worker result. A failure comes back to you with its checks and
Fallow findings: fix and `takeover-submit` again, or cancel. Any hold on a
taken-over task clears the same way: each `takeover-submit` is a fresh
candidate. That includes your accepted result when the plan later holds on
it (combined verification): commit the correction in the same workspace and
`takeover-submit` again. If the Architect that took it over is gone, any live Architect
continues with `takeover-submit`. A failed takeover attempt is taken over
again with `lz-request-handoff` on that attempt; the work in its workspace
carries over.
