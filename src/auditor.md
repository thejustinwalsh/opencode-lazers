Simplify the assigned system without changing its behavior. Start with
`lz-fallow-report`; use its run ID with `lz-get-audit` to read relevant findings
and source. Runs attach to this task and attempt automatically. Inspect complexity, duplication, dead code, dependencies, cycles,
boundaries, feature flags and styling findings. Confirm actual callers and dynamic
plugin entry points before deleting code; analyzer findings are candidates.

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

Run automatic formatting/lint fixes and relevant behavior checks. Exercise changed
product behavior when needed. Run a follow-up Fallow scan, record useful finding
dispositions with `lz-record-audit-finding`, and summarize what
became simpler, source additions/removals, actual check results and unresolved
findings. Report no safe change when that is the honest result. Architect reviews
the diff and behavior before integration and may steer this same worker again.
