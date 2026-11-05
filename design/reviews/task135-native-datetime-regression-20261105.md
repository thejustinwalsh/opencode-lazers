# Native timestamp memo bypass

The production caller in src/progress/native.ts passes the in-process
ctx.session.context messages directly to ProgressRecorder.reconcileMessages.
Those schema values use Effect DateTime timestamps. Current
encodeRecoveryFingerprintValue accepts only ordinary object prototypes; Effect
DateTime has a different prototype, so its fingerprint is unavailable and the
whole unchanged reconciliation falls back to replay.

Root reproduced the representation difference on the actual current recorder
implementation with a disposable repository. Same message and three passes:

| Timestamp representation | Append attempts by pass |
| ------------------------ | ----------------------- |
| numeric timestamps       | 3,0,0                   |
| Effect DateTime          | 3,3,3                   |

Observed1793857504726/7504750. No production data was written; this is a regression
reproducer, not native CPU acceptance. Script:
/private/tmp/lazers-recorder-native-time-regression-20261105.ts.
Native caller/type evidence plus this reproduction explains why the numeric
fixtures do not establish memo reuse for the in-process native representation.
It does not attribute all remaining service CPU to this function.

Architect independently reran the reproduction with the same result, delivered
concise advice/readback, and resumed original135 at1793857764502, planversion15.
Original attemptd0930725-f837-40e7-8992-892f66ec1010 and session
ses_671fad53a1b548679a7afc4472879ed2 are retained. Its OpenAI Luna Max repair is
active alongside99 in a separate native worktree. The fix and regression fit
recorder.ts/test scope; broader diagnostics wiring remains separate behind127.
No performance or acceptance claim is made before correction and native reprobe.

Root independently tested the worker's revised, uncommitted recorder candidate at
1793859163285/9163304 using the same disposable reproducer, importing the worker
recorder while retaining the canonical Effect timestamp producer. Both numeric
and Effect DateTime representations now produce append attempts[3,0,0]. No
production writes occurred. This establishes the original representation repro
is corrected in that draft; final review, changed/late-fact regressions, source
integration and actual native performance qualification remain outstanding.

Candidate374a599 was merged with ancestry as26f0825. Postmerge69 recovery tests/
660 assertions, lint and types passed. Final Luna review recommended removing
private Effect prototype/tag checks. Root removed those checks directly in
canonical source, retaining supported DateTime detection, safe data-property
reads, existing dateMillis conversion and timestamp-position restriction. All20
recorder tests/375 assertions pass; lint/types pass. The original numeric and
Effect repro again yields[3,0,0] at1793860037987/38130. No worker certificate or
restart was needed for this source simplification. Production activation and
native-performance acceptance remain separate.

Separate native fact check at1793856175726/728: original129/132 are inactive with
outcome failed and idle timestamps later than busy. An interrupted-only99 branch
does not establish their recovery. That scope gap and the draft's human-reason
string matching were sent to the native coordinators for explicit disposition.
