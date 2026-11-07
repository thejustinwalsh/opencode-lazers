# LZ-172: read-heavy repair steering

## Baseline supplied by Root

The original presentation repair was busy from Unix ms `1794089363340`.
At `1794090595240` (about 20.5 minutes), Root inspected the last 45 messages:
20 grep, 28 read, 2 shell and 3 execute calls, one invalid-regex error, and clean
Git status with zero edits. Multiple tool calls may occur in one message.
This is a measured research-heavy window, not a missing handle, provider failure
or proof of forward implementation progress. The separate original Tasks worker
had 18 patch calls and growing implementation; it was left undisturbed.

## Intervention

The Architect confirmed the original LZ-172 attempt was still running, then stored
task advice revision 9 and replaced its single native `lazers-task-advice` entry.
Exact native readback matched the supplied value. No cancellation, replacement,
new task, input, resume or unrelated prompt was issued.

The steering directs the worker to implement the already-reviewed coherent
presentation correction from Terra's actual screenshots, Root's interaction report
and existing advice, then run focused rendered checks and automatic quality fixes.
Further broad API/fixture exploration is excluded absent a named concrete blocker.
The product requirements and acceptance remain unchanged.

## Outcome and follow-up

At intervention time, storage/readback proves delivery only—not consumption,
application, first patch or passing behavior. The next outcome observation must
look for actual substantive edits, the resulting candidate and focused checks,
then Root's connected narrow/wide interaction/Terra reprobe. Continuing busy state
or increasing read counts alone must not be reported as improvement.

This is evidence for the existing recovery/trajectory learning lane, not a new
detector, policy, task or retrospective claim that a single tool-count threshold
establishes worker struggle. Preserve the original task/attempt/session/input,
candidate, usage and resource history when evaluating the eventual result.

## Subsequent consumption finding

Root inspected native execute `msg_1b823bd08001nEgzmVhGJvbefx`: the worker fetched
`lz-get-task` but projected `result.task.advice?.current` and
`result.task.reference`. `GetOutput` places `advice` and `reference` at the top
level. The actual result contained only `writeScope`; those attempted fields were
undefined. This fetch therefore did **not** prove advice consumption.

The Architect prepended a concise getter correction to the same native context
key, preserving advice 9: read `lz-get-task-instructions`, or use
`result.advice?.current` and `result.reference`. Readback confirmed the corrected
entry without a new input. Actual readable steering consumption and substantive
edit outcome remain to be observed; no getter invocation alone establishes either.

## Observed subsequent edits

Root read native tool receipts after steering. The first successful patch in this
repair window completed at Unix ms1794090834553, changing comparison-presentation.ts
and comparison-chart.tsx. Further successful patches changed comparison-panel.tsx
at1794090869711 and1794090928890; one intervening patch failed to match context
and was followed by a successful patch. At1794090928890 the working diff had
3files,150insertions/72deletions. This establishes implementation progress, not
a passing visual result or causal proof that the reminder produced it.

The worker's task-advice inspection also used the wrong response path:
msg_1b823bd08001nEgzmVhGJvbefx selected result.task.advice and result.task.reference;
the actual tool output contained only writeScope. GetOutput stores advice and
reference at the top level. Root sent this exact consumption issue to Architect
through Desktop, recommending the readable instructions getter or the correct
structured projection. Delivery/readback remains distinct from worker use.
