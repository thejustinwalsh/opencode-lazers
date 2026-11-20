# d93f6681 — ledger-paging

## Findings

### d93f6681-1 — major / confirmed

- **Where:** `src/models/observation-ledger-read.ts:485-490,795-838`.
- **What:** Removing ceilings does not implement source paging: `queryAll` materializes every retained row before the first task page. Continuations rebuild this capture, so peak memory and per-page work grow with all retained history.
- **Failure scenario:** Thousands of tasks have gigabytes of progress; request ten tasks. The reader loads/fingerprints every task, progress row, attempt and transition before yielding ten, potentially exhausting the worker; the next ten repeat it.
- **Evidence:** `queryAll` spreads `iterate` into an array. `readCaptureRows` and `readRunnerRows` capture everything; `openReadOnlyObservationLedger.read` captures before `outputFromCapture` slices. The >64 MiB test proves ceiling removal, not bounded first-page work.
- **Suggested fix / test:** Page membership and associated detail while maintaining a coherent pin. Instrument source row visits/retained bytes for a first page with a large unrelated backlog.

## Checked and sound

- Per-fact observations/event IDs no longer slice to 25/100.
- Cache eviction/reset returns full data instead of refusing oversized projections.
- Baseline reads update LRU order; lost baselines reset instead of falsely patching.

## Not reviewed

- No memory load/volume test execution; fixtures write outside the permitted directory.
