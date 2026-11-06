# Retained verification: async setup integration review

Source: LZ-138 worker commit `a869fce`, following `fee2a89`, `d37858f` and
`d875063`. The native review worktree `/private/tmp/lz138-current-review` starts
from main `7d4ca63`; its integration candidate is `7b6abc5`. Main is unchanged.

Dependency installation now uses an asynchronous child process with cancellation,
timeout and termination. Runtime reserves setup ownership before allocating the
private resource directory and reconciles partial setup on failure/cancellation.
Candidate-owned dependency changes remain supported. The only cherry-pick conflict
was the plan-control tool description; the concise description was retained.

Independent checks:

- Original worker source: isolation and retained runtime tests, 18 passing tests,
  188 assertions. These include real isolated candidate installs and subprocesses.
- Current-main integration: 33 focused tests, 402 assertions; formatting, lint,
  typecheck, diff check and GUI build/bundle evaluation pass.
- Broader runner/verification/trajectory run: 596 pass, four five-second timeouts,
  four subsequent errors. Log: `/private/tmp/lz138-current-runtime-tests.log`.
  Preserve this failure; it is not a passing qualification.
- All four timed-out tests pass separately under the original timeout. The
  independent-plans, lost-startup-response and cancelled-successor cases passed
  alongside an integration-cleanup case (4 tests/149 assertions); the remaining
  cancelled-child-resume case passed separately (1 test/30 assertions).
- The broader rerun with a 30-second default timeout completed with 599 pass,
  one failure and one subsequent error (7,679 assertions). The remaining test,
  `identical task and combined assertion/artifact evidence remains phase- and
task-bound`, has its own explicit ten-second timeout and exceeded it. It passed
  in the earlier run. Log: `/private/tmp/lz138-current-runtime-bounded-tests.log`.
  This is still not a clean broad-suite pass. No production timeout or runtime
  acceptance rule changed. Repeat affected integration checks after the actual
  source defects below are corrected rather than continuing unchanged reruns.

The installer-responsiveness fixture injects a deferred installer and checks that
another runtime command completes before installation is released. Cancellation
and injected failure fixtures inspect durable resource reservations and physical
cleanup. These are useful discriminating tests, not a native Desktop qualification.

Luna reviewer `ses_e522ffd49ffeenRSBj8xvTAxMB` returned **not ready**. Two material
gaps remain: the installer signals only its immediate process rather than using
the check launcher's existing process-group lifecycle; and a crash during setup
leaves durable reservations without the in-memory link identities needed by its
cleanup path. A retry can report cleanup success without reconciling those saved
resources. The injected installer tests do not prove real process termination or
crash/reopen recovery. Root returned both findings through Desktop Architect for
correction by the same worker. This candidate is not activated.

Still required: corrected source and review, final combined checks, coordinated
activation, and the actual registered zero-implementation-turn retained-candidate
walkthrough. Worker reports and passing fixtures do not establish those outcomes.
