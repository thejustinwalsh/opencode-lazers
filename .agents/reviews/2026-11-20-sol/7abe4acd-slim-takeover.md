# 7abe4acd — slim-takeover

## Findings

### 7abe4acd-1 — major / confirmed

- **Where:** `src/runner/takeover.ts:115,127-148`.
- **What:** “Kept verbatim, never dropped” handoffs silently cut every field/raw value to 8,000 characters, without a stored original or omitted marker.
- **Failure scenario:** Worker submits 8,100 characters of remaining-work notes with a critical warning at the end. The tool acknowledges receipt; the Architect receives only the first 8,000 characters and never sees the warning.
- **Evidence:** `normalizeWorkerHandoff` applies `.slice(0, FIELD_LIMIT)` to both known fields and unknown raw data. `recordWorkerHandoff` persists only the normalized result.
- **Suggested fix / test:** Persist the complete handoff and page long display text; test a >8,000-character field/raw payload ending in a sentinel and verify retrieval retains it.

### 7abe4acd-2 — major / confirmed

- **Where:** `src/runner/takeover.ts:408-421,500-512,631-635`.
- **What:** State transitions merge patches into a stale row payload, overwriting a worker handoff accepted while a host read was awaiting.
- **Failure scenario:** `awaitHandoff` reads a row with no handoff and awaits `host.session`; the worker submits its handoff, gets `received`, and ends its turn. The host read returns idle; `move(row,"stopping",...)` writes the old payload over the saved handoff, so settlement reports that the worker wrote none.
- **Evidence:** `move` conditions only on state and serializes `this.payload(row)`, not the current database payload. Recording a handoff does not change state, so the stale update succeeds.
- **Suggested fix / test:** Read/merge the current payload inside the transition transaction (or use a version CAS). Delay `host.session`, save a handoff, resolve idle, and assert the final worker-authored text is preserved.

## Checked and sound

- Failed takeover verification returns the same attempt to Architect submit/cancel rather than spawning an implementation worker.
- Shutdown-aborted native tool tail no longer proves a completed worker turn.
- Takeover attempt display omits fabricated tool/retry counts.

## Not reviewed

- No runtime tests: fixtures run mechanical fixes/worktree operations outside the permitted area.
- The older reviewed-handoff request remains alongside the slim path; retirement interaction is recorded in `84e85b0f`.
