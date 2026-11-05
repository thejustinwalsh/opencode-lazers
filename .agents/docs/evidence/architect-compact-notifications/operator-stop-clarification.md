# Existing LZ134: explicit-stop renewal regression

Operator clarification for the existing notification/renewal increment, not a new
task or authorization to discard legacy plans.

The user approved stopping the historical-notice review chain, including automatic
successors that merely consume historical notices. Original owner
`ses_5aa94658965844ed85f4b0ebdd5266cb` was interrupted/idle at1793847176491.
The runtime nevertheless renewed its ownership to successor
`ses_72db8086246b4cabb6abf6f2f431dcc7`. Root then interrupted that successor through
the native API at1793850535819 and confirmed interrupted/idle1793850535856;
only the LZ136 implementor remained active. This Architect and136 were untouched.

Second recurrence: the stopped72db successor renewed at1793852337790 into
`ses_728b844b477c4a569402cfdbcc5423e2` (parent72db); Root observed only legacy
inspection tools. Under the existing chain-stop approval Root interrupted that
successor at1793852396456 and confirmed interrupted/idle1793852396587. Only136
remained active. No fresh implementation or worker input was changed. This is a
second observed failure of explicit-stop preservation, not new authorization to
discard plans or silently mark historical notices consumed.

Root subsequently reported another successor `c10fbf89` (parent728b) and applied
the standing chain-stop approval at1793854357004, with no workers affected. Carry
this recurrence into the same134 boundary; it does not authorize the pending
proposal to transfer58 unfinished plans. No such transfer is approved or performed
by this Architect.

Carry this observed failure into **LZ134**, alongside its original LZ28/LZ30 seams:

- Honor explicit operator stop of this historical-review chain across the idle
  timer, native successor creation/ownership transfer and process reopen. Historical
  journal/reference notifications alone must not restart it or renew another
  inference-consuming successor.
- Preserve legacy plans, ownership records, workers, source journal, native history,
  delivery receipts and unknown consumption. Do not silently delete queued notices,
  cancel unrelated plans, or treat native interruption as task completion.
- Keep material new inputs/actionable worker outcomes distinct from historical
  backlog. Do not suppress independent eligible implementation or assume every
  idle session/provider failure is an operator stop.
- Regress the observed sequence: explicit native stop, retained historical notices,
  elapsed renewal window and reopen/concurrent schedulers. Show no historical-only
  successor wake while preserving records and normal explicitly authorized work.
  Ground the stop-intent representation and any later resumption in supported
  native facts and explicit authority; do not fabricate those facts from prose.

LZ134 already owns runtime/native/store notification source; preserve its task and
plan identity and existing integration prerequisite on133. No replacement task,
historical-loop wake, additional legacy transfer or delegation feature is approved.
Before its original worker begins, the owning Architect must supply this operator
clarification through its task/advice or instruction-context surface, not a new
genuine worker input. The immutable historical specification is not rewritten.

Root's observed stop is current native evidence, not proof that the preventive
product repair has shipped.136's alias repair remains a separate original-worker
increment; do not append this unrelated renewal implementation to136.
