## Luna Max — LZ-122 review

**Bottom line:** the added preflight is a useful early-refusal check, but it does not make this capture proportional or bounded in memory. The current path still scans, loads, serializes, fingerprints, and projects the whole project; paging through its public reader repeats much of that work. These findings are for the worker’s uncommitted diff over `3999968` as of **2026-11-05 17:43:59Z**. The diff changes `observation-ledger-read.ts` and `observation-ledger-schema.ts`; tests are unchanged.

### Read-only production measurements

Aggregate-only SELECTs against the canonical plugin database returned, in one coherent snapshot: **142 tasks, 116 plans, 135 nodes, 138 attempts, 3,362 transitions, 11 dispositions, 13 classifications, 1 adoption, and 39,393 joined progress rows**. A later read-only transaction saw **39,418** progress rows, so the live ledger was still changing. No payload or secret values were read into the report.

On that later snapshot, the patch’s project-scoped progress `COUNT(*)` took **269 ms** and its byte `SUM(...)` took **90 ms** for **88,159,473 bytes** of payload and lineage text—about **359 ms for those two preflight queries alone**, before the full SELECT and projection. The task count also means the public reader needs at least two pages (maximum 100 tasks).

Earlier aggregate evidence records **29,975** progress rows and an **85,972,209-byte** serialized raw-row envelope; it explicitly was not a JavaScript heap measurement. I did not run the full production projection: materializing tens of thousands of large facts would not be a useful safe memory probe. **No full-reader heap/RSS measurement is available.**

### Findings and scoped advice

1. **Count-derived `LIMIT` does not reduce the capture work** (`observation-ledger-read.ts:535–647, 649–835`). For an in-bound project, the reader counts, sums text bytes, then loads every matching row with `.all(count + 1)`. The limit is therefore the full row count, not a smaller bounded batch. The transaction is coherently scoped, which is good, but this is still multiple project-wide passes followed by full materialization.

2. **The byte estimate is not yet evidence of a memory bound.** The exact serialized-size check remains after all rows are loaded (`:837–857`), and the fingerprint serializes the full capture again (`:940`). The SQL estimate plus 512 bytes per row does not account exactly for JSON escaping or all selected text columns; the earlier raw-row envelope is a useful warning that a row-overhead allowance needs validation. The estimate can reject early, but it does not cap peak memory. Keep exhaustion `incomplete`/unknown—not a truncated success—and validate the estimator against escaped payloads and long omitted columns before relying on it.

3. **Progress facts incur avoidable parse/projection amplification** (`:889–924, :1918–1937`; `src/progress/projection.ts:231–276`). Capture validation parses each payload, calls `projectProgressFact`, and separately validates lineage; output projection calls the general projector again and reparses the payload for observations. That is four payload JSON parses per fact across these paths, plus repeated lineage parses. The general projector also sanitizes visible tool content into a result field that the ledger schema does not return; prior production evidence measured 20.4 MB of such content. Prefer one narrow, reusable projection for the fields LZ-122 needs, while retaining full route/event identities and truthful omissions.

4. **The ledger-to-decision seam encourages repeated full reads.** `read()` accepts pages of at most 100, but every cursor call runs `readCapture` and `outputFromCapture` again (`:2211–2255`); each invocation rebuilds all task rows, progress projections, and session maps before slicing the page. LZ-122 needs full selected-task histories, shared-session ownership, and the global frontier before paging. Draining this cursor as if it were incremental would repeat full capture/projection at least twice for the current task count—and potentially again for each RPC. Within the existing decision snapshot, derive the global result from **one coherent capture**, then page the immutable decision rows. This can stay a narrow LZ-122 seam; it does not require a broader cache/lifecycle framework.

5. **Cancellation needs an explicit boundary.** The ledger’s `read()` is synchronous and has no abort signal. A server-side pre/post check cannot interrupt its full read, JSON work, and projection mid-call; the caller must also close the reader in `finally` on errors. Verify the decision adapter can reject a mid-read abort without publishing a complete-looking prefix and closes its connection.

The production facts substantiate that the old **10,000 progress-row** ceiling was insufficient. They do **not** substantiate the new 250,000-row or 256 MiB ceilings, nor the raised limits for tables currently containing only hundreds or a few thousand rows. Preserve hard bounds and explicit incomplete/unknown results; don’t treat the larger values as demonstrated capacity.

### Regression discriminators

- Test count and byte exhaustion at/over bounds, including highly escaped payloads and long text in fields not included in the byte sum; overflow must not return a partial prefix as complete.
- Assert one coherent full capture/projection per decision snapshot, not one per ledger page; check page-size invariance and a global frontier dominated by an off-page task.
- Change an existing progress row’s payload/lineage between pages—not only append a row—and verify stale capture fails without success.
- Retain shared-session dedupe and complete failed/retry/accepted histories; verify exact route/effort attribution and unknown values remain unknown.
- Exercise pre-abort/auth denial before reads and mid-read cancellation with connection closure.

No files were changed, no server or service was touched, and no full ledger materialization or test run was performed.
