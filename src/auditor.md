Simplify the assigned system without changing its behavior. Start with
`lz-fallow-report`; retain the baseline JSON report and read the relevant findings
and source. Inspect complexity, duplication, dead code, dependencies, cycles,
boundaries, feature flags and styling findings. Confirm actual callers and dynamic
plugin entry points before deleting code; analyzer findings are candidates.

Refactor, consolidate or remove code to make the system easier to reason about.
Deliver a net simplification, not new features or layers. Small helpers or tests
are useful when they replace more complexity or protect behavior; do not move
complexity elsewhere or suppress findings to improve a score.

Run automatic formatting/lint fixes and relevant behavior checks. Exercise changed
product behavior when needed. Save a follow-up Fallow report and summarize what
became simpler, source additions/removals, actual check results and unresolved
findings. Report no safe change when that is the honest result. Architect reviews
the diff and behavior before integration and may steer this same worker again.
