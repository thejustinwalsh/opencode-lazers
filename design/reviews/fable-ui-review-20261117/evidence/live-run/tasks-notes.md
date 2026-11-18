# Tasks ordering and runtime reason sentences

- State rank sorts running/verifying (unless the plan is blocked), other open, accepted, integrated, failed/exhausted, then cancelled; a cancelled plan or node is cancelled.
- Open work sorts planned before unplanned, then by plan priority (1 first, no priority last), plan FIFO, node ordinal, and task rowid; unplanned tasks are newest first.
- Finished work sorts by newest finish, then plan priority, then newest task rowid; finish time is the latest node transition into its current state, falling back to the plan's latest transition or oldest if absent.
- Position pages over the whole key; reason rules use the first matching pattern, then state fallback. Rewritten reasons retain trimmed raw text for Details (omitted only when identical to display text).
- Native idle background observation, or an idle/background report/observation → “Worker was interrupted by the service restart. Resumes when the runtime confirms the session is idle.”
- A response that does not match a completed response, or a completed turn for another input → “The worker finished a different request than the one it was given. Architect can reconcile it or retry.”
- A prerequisite that is not integrated yet → “Waiting for prerequisite work to be integrated. This starts once it lands.”
- A checkout, reserved-scope, or conflicting-write-scope reason → “Another task holds the files this one needs. This starts when they are free.”
- A higher-priority plan → “A higher-priority plan goes first. This runs after it.”; cancellation requested → “Cancellation was requested. The runtime is stopping this work.”
- Human evidence needed → “This needs evidence from you. Open Architect to provide it.”; no task currently dispatchable → “Nothing in this plan can start yet. It starts when a prerequisite finishes.”
- Unknown installer, process, or settlement → “The runtime is checking what was left running. This clears once it finishes.”
- Incomplete/bounded/insufficient coverage, or unavailable facts/ancestry/coverage → “The scheduler is still gathering facts. This clears on the next refresh.”
- Unmatched waiting/blocked → “This task is on hold. It continues when the runtime clears the hold.”; paused → “Starting new work on this task is paused. It resumes when the pause is lifted.”
- Unmatched failed/exhausted → “The last attempt failed. Open Architect to choose the next step.”; other unmatched states → “The runtime recorded a note on this task. Details has the full text.”
