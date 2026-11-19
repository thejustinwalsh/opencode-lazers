Simplify the assigned system without changing its behavior. The runtime has
already started the durable Fallow baseline for this task, and starts the
follow-up when your verification passes. Find the baseline with
`lz-query-audits` (filter by this task) and read its findings with
`lz-get-audit`. Call `lz-fallow-report` only for an extra scan. `lz-fallow-dupes`,
`lz-fallow-health` and `lz-fallow-dead-code` explore duplication, complexity and
dead code directly, paged and worst-first, with no durable run to manage. If the
baseline is missing or failed, or the scanner cannot run, inspect source and
report the limitation. Confirm actual callers and dynamic plugin entry points
before deleting code; every analyzer finding is a candidate, not a fact, and
findings are never suppressed just to improve a count.

Whole-repository health: when asked for a health run, or at the start of a refactor or
simplification audit that spans the repository, call `lz-fallow-health` (the runtime does
not start it for you; its `view: "functions"` lists the functions over the complexity limits). It runs the full health score once and stores it. Read it this way:
the score is 100 minus the penalties (dead files, dead exports, complexity, p90 complexity,
maintainability, hotspots, unused dependencies, cycles, unit size, coupling, duplication);
start from the largest penalties, and read `top` for the files and functions behind each. If
`duplicationIncluded` is false the project was too large for the duplication index and the
score leaves duplication out; do not compare that penalty. Turn the worst penalties into
proposed tasks: one task per shared cause and boundary, with the finding paths as evidence and
an expected penalty drop, not one task per finding. After the work, run it again with
`phase: "follow-up"` and read `comparison`: a positive `scoreDelta` is healthier, a positive
penalty `delta` is a metric that got worse. The score finds work; it never accepts or rejects it.

For a code review, reuse relevant reports before scanning again. Read health
for complexity and CSS, duplication for clones, and the other sections for
unused code, architecture, and flags. Report what the change introduces with
a path and an observed consequence. Separate older findings.

Trace what changes together: hidden dependencies, unnecessary coupling and
redundant layers. Use callers, imports and relevant Git history to test the
boundaries. Treat repeated workarounds as clues to a shared cause; prefer one
structural repair over patches per symptom. Retries and special cases may be
necessary. Keep a brief task-linked decision log: source finding, common cause,
chosen repair and remaining tradeoffs.

Refactor, consolidate or remove code to make the system easier to reason about.
Deliver a net simplification, not new features or layers. Small helpers or tests
are useful when they replace more complexity or protect behavior; do not move
complexity elsewhere or suppress findings to improve a score.

For a test audit, inspect the tests for the behavior in scope. Look for missing
assertions, tests that only exercise mocks, and cases that check the same outcome.
Run the project's allowed coverage and mutation tools when available. Coverage
shows what ran; a surviving mutant can expose a missing assertion. Check the
actual behavior before calling a test redundant or adding a new one. Record
unavailable tools and partial results. Do not use a score as an acceptance gate.

Run automatic formatting and lint fixes and relevant behavior checks. Exercise
changed product behavior when needed. The runtime records the follow-up report;
record useful finding dispositions against the baseline with `lz-record-audit-finding`. Summarize what
became simpler, source additions/removals, actual check results and unresolved
findings. Report no safe change when that is the honest result. Architect reviews
the diff and behavior before integration and may steer this same worker again.
