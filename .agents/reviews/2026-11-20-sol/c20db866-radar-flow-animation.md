# c20db866 — radar-flow-animation

## Findings

### c20db866-1 — minor / confirmed

- **Where:** `src/radar/pulse-loop.test.ts:130-140` (test rewritten but the assertion gap survives in `70a0f10e`).
- **What:** The no-DOM-writes assertion checks a MutationObserver callback array synchronously, before observer delivery. It passes even if the operations under test mutate observed DOM.
- **Failure scenario:** Introduce a style/attribute write in an unchanged-wire update. The mutation queues a callback, but `expect(writes).toEqual([])` runs first and passes; disconnect then discards pending observation.
- **Evidence:** Current test installs the observer, calls synchronous updates/advances and asserts without yielding or calling `takeRecords`. The original test in this range used the same pattern around `frame(0)`.
- **Executed reproduction:** The observer test in `review-invariants-reproduction.test.ts` performs a real attribute write: the callback array remains empty while `takeRecords()` contains that mutation.
- **Suggested fix / test:** Inspect `takeRecords()` or await observer delivery before asserting; include an intentional observed write as a positive control so the instrumentation must detect it.

## Checked and sound

- Reviewed exact range `ee0203de..c20db866`; dots move into a separate HTML overlay and SVG geometry is not rewritten every frame.
- Visibility teardown still belongs to loop disposal.
- Later `70a0f10e` replaces this frame driver with Web Animations; the removed driver is not treated as a current runtime defect.

## Not reviewed

- No compositor/paint profiling; transform-only writes alone do not prove zero paint across browsers.
