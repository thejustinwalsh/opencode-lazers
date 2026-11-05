# Execution order checkpoint

Native/SQLite reads at1793847759658–7856255. This is an observation checkpoint,
not a replacement for scheduler decisions or a claim of feature completion.

## Selection

`RunnerStore.plans()` orders higher numeric plan priority first, then submission
order. Runtime advances current attempts, checks integrated plan/task dependencies,
and reserves nonconflicting write scopes. Shared work is single-writer;
compatible isolated work may fan out. Blocked plans cannot dispatch new work.
Cancellation gets first processing priority. No preemption of ordinary active
workers is implied by changing a plan's priority.

## Actual work

| Task                          | Plan priority | Current limit                                                                                                      |
| ----------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------ |
| LZ99 continuation             |          2175 | Queued; legacy recovery control remains unresolved.                                                                |
| LZ122 Models producer         |          2090 | Queued with no attempt; unresolved integrated prerequisites, including126.                                         |
| LZ135 recovery projection     |          1825 | Both corrections committed;66 tests pass. Native CPU comparison and runtime acceptance remain.                     |
| LZ133 journal inspection      |          1820 | f5f7af4 committed;16 tests and migrated actual-data probe pass. Completion blocked by review-steer input mismatch. |
| LZ134 notification coalescing |          1815 | Queued after133 integration.                                                                                       |
| LZ131 trajectory endpoints    |          1800 | Queued; no worker.130 UI slice has landed.                                                                         |
| LZ129 Radar producer          |          1790 | Original quota-stopped worker retains work; runtime still running/unknown.                                         |
| LZ132 task advice             |          1785 | Same quota-stop mismatch; original work retained.                                                                  |

The two new implementors overlapped in isolated native trees and have now both
finished their correction turns. Their runtime states must be reconciled honestly.
The current Architect and its research delegates are orchestration, not substitute
implementation workers. A running plan with a queued node is not an active worker.

## Immediate coordination

Repair recognition of genuinely delivered review steering without restarting
finished workers. Review/integrate133/135, then134. Recover129/132 through supported
flows. Move the higher-priority Models chain through its actual prerequisites and
deliver the approved comparison graph, editable assignments and dispatch routing.
Independent eligible work may run in parallel; this sequence is coordination
intent, not proof that the runtime queue has already been repaired.

Automatic approval review rejected submitting legacy owner reassignment without
explicit user approval. Root requested approval for129/132 only and instead
answered the Architect's interview with a safe continuation on its own133/135
plans. No legacy ownership transfer was performed.

### Subsequent authorized progress

The user approved129/132 transfer. Native commands at1793848354034/4093 reassigned
only those plans to the fresh Architect. Readback at1793848404029 confirmed
versions26/13 and the same original attempts, sessions and worktree paths.

LZ136 (`06fc208a-e4ed-4fe6-9b5b-33905840f8a8`) is submitted in plan
`ad6cb637-d5d7-4ee4-974e-727216f2bdd5`, priority2300. Its narrow review-input
reconciliation goal preserves original assignments and ordinary verification.
At1793848453348 it had no attempt. Read-only write-scope comparison identified
one conflicting reservation: original LZ72's verifying attempt. Its source guard
is installed (native readback1793848567046), worker succeeded/idle, and permission
inventory is empty. Its unresolved verification effect remains unresolved.
Root requested explicit approval for this additional plan's existing ownership
transfer and source-quarantine/archive flow. No72 transfer or quarantine has been
performed at this checkpoint.

The LZ136 System One check failed with an ONNX WebGPU buffer-download device-loss
error. Its review result was `unavailable`, not a semantic rejection. Submission
continued with the recorded review state. Inference settings were not changed;
successful automatic GPU recovery is still unproven.

## CPU observation limits

Current-process measurement1793847699525–7711557, Tasks visible with live model
activity: service95968=34.83%, renderer8902=25.27%, GPU-process8898=41.56% mean CPU
over12.03s. This is neither a quiet before/after comparison nor GPU utilization.
It does not establish a battery fix. An earlier1793847653005 window used exited
renderer/GPU PIDs; its zero values are invalid and must not be cited. The helper
now discovers current process IDs and rejects missing processes.
