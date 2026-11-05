# Original LZ129 accepted source still needs correction

Artifact `37dadd7f982ae726ceb3fbbbb3298cf219d81810`, base `f06a65e`;
original attempt `58d8d699-6a12-44c3-a5af-954b2b5564bc`, native Luna Max session
`ses_aeff3e9ac5d24c6c944d35e31b050963`. Runtime acceptance/history are preserved;
independent review does **not** clear this source for merge or cleanup.

Independent Luna Max reviewer `ses_e55446795ffe0DlSh1loaZZFui` found:

1. **Assignment query is not scan-bounded.**
   `src/observability/live-store.ts:433–456` applies LIMIT33 but the available
   `runner_attempts` indexes (`src/runner/store.ts:303–309`) do not support its
   filter/order. EXPLAIN QUERY PLAN showed an attempt scan and temporary sort.
   Counters count returned rows, not scanned historical rows. Correct the bounded
   access path and add a discriminating plan/scaling regression; do not describe
   LIMIT or returned-row counters as proof of bounded underlying work.
2. **Previously untracked unmanaged event during first read can be missed.**
   `live-read.ts:623–639` captures the boundary before inventory retrieval, then
   registers selected IDs at832–837. `changes.ts:151–154` discards such an event
   while the ID is not yet tracked, allowing stale inventory without notification.
   Existing new test emits after selection. Cover actual in-flight first-read
   ordering while preserving directory/project filtering and bounded state.
3. **Astral Unicode still violates output schema caps.**
   `live-read.ts:30–31` budgets the truncation suffix, but
   `trajectory/privacy.ts:168–175` trims code points while schemas cap UTF-16
   length. Reviewer reproduced121 emoji→242 code units against240,301→602
   against600. Existing ASCII boundaries do not discriminate this failure.
   Bound actual output length including suffix and avoid corrupting surrogate
   pairs; keep privacy/redaction before projection.

## Other reviewed boundaries

Route identity and managed-session starvation corrections are fixed. Selected
unmanaged invalidation works after selection, not in the first-read race above.
Metadata accounting is honestly named `raw-selected-fields-after-adapter` and
oversized selected-field tests cover it; it does not measure native wire bytes.
Authorization-before-read, directory/project filters, scoped history cursors and
paging, privacy and legacy fallback are covered by registered-handler tests.
Only the six task-scoped files changed.

Reviewer checks passed108 tests/1,112 assertions plus format/lint/type/diff checks.
Passing those checks did not detect the three cases above or establish native
OpenCode integration/cleanup. Preserve the original task/work/artifact/worker;
use the existing accepted-unintegrated repair and retained-verification lanes,
not a replacement task or proof-only worker turn. Any needed query/index scope
outside original task authority needs a supported narrow amendment.
