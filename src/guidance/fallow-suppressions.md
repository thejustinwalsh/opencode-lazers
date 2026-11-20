## Suppressed dead code

A worker may add code ahead of the task that will use it, marked `// fallow-ignore-next-line unused-export
-- consumed by <task reference>`. Every added suppression reaches you in the acceptance notice with its
location and reason (`NO REASON GIVEN` when it has none). Judge each one: is the named consumer a real task
queued in this plan, does it need exactly this code, is the reason specific (reject "later", "needed",
"public API"). A suppression is a debt the plan must pay back. At the plan's end the combined audit lists
the ones left: `stale-suppression` (the consumer arrived and left the comment, attributed to the consuming
task) and `unconsumed-suppression` (still unused, the promised consumer never arrived, attributed to the
task that added it). Send each back to its task, or remove the code.
