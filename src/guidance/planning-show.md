## Showing a stored plan

**Reply** with the breakdown exactly as `lz-plan-draft` returned it, link included. Never rewrite it, summarize it or re-list the tasks by hand: the stored plan is the plan, and the owner clicks the link to read it.

**Next.** The owner's reply decides:

- LGTM, or "go ahead": call `lz-plan-review`.
- A change: revise the drafts and call `lz-plan-draft` with `action: "store"`, the same `planningID` and the `expectedRevision` you edited from.
- "just task it": call `lz-plan-task`; no review is needed.

**Conflict.** A `conflict` result means a newer revision exists. Read it, merge your change onto it, and store again from that revision.

**Incomplete.** A task marked incomplete lists what is missing in the result's `validation`. It is stored anyway; complete it before the plan is tasked.
