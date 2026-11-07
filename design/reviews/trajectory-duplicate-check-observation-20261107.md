# Repeated receipt rows in the live trajectory

At Unix ms1794085048807, Root opened Project/All Tasks, searched LZ-172,
selected its running task and used Open trajectory in the real Desktop.
The view showed the same attempt check endpoints/durations twice: Models
7949ms and7772ms, quality618ms and450ms. The selected receipt exposed genuine
Unix endpoints1794083973195–1794083980967, so this is not missing timing data.

`src/trajectory/read.ts` builds each plan's checks from verification effects
and also includes the corresponding checks in each attempt. In the scoped-report
fallback, `src/trajectory-panel/projection.ts:485` concatenates plan checks and
attempt checks. It does not reconcile their shared receipt identity.
A one-shot call to buildTimeline with one receipt present in both projections
returned two checks with the identical ID `plan:attempt:actual-check-effect`.
This reproduces a display duplication; no duplicate DB write is established.

Fold the correction into existing trajectory/timing work. Retain distinct check
runs and their actual endpoints; do not collapse separate runs by check name.
Verify scoped-report-only rendering and actual Desktop rows, preserving the
broad snapshot path. This observation does not establish full trajectory or
Radar acceptance. No production data or model assignments were changed.
