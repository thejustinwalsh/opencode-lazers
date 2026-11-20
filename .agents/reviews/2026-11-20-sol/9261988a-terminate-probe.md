# 9261988a — terminate-probe

## Findings

### 9261988a-1 — minor / confirmed

- **Where:** `src/audit/wasm/terminate-probe.ts:9-12`; `src/audit/wasm/fallow-wasm.test.ts:188-198`.
- **What:** A fixed 150 ms delay is treated as proof that analysis and helper threads started, but the probe has no startup handshake. The cancellation test can pass without exercising helper termination at all.
- **Failure scenario:** On a busy/cold process, worker startup/module loading takes longer than 150 ms. Abort cancels the queued request before helpers exist; the child prints “cancelled” and exits, satisfying both assertions even if terminating a running helper is broken.
- **Evidence:** This unit changes only 700 to 150 ms; parent checks stdout and exit status, not helper count/readiness. No analyzer/helper-start event gates abort.
- **Suggested fix / test:** Signal that a helper entered a deliberately held analysis, then abort; assert startup occurred and the child exits without forced kill. Retain a timeout solely as a failure backstop.

## Checked and sound

- Reviewed exact range `3bb090ac..9261988a`; only probe timing/comment changes.
- Parent's timeout kills the child on hang rather than hanging the whole suite forever.

## Not reviewed

- No helper leak is asserted: this is a false-positive test-coverage defect, not evidence that runtime termination currently leaks.
- Probe was not run; it analyzes a repository and writes caches outside this review directory.
