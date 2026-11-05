# Focused review of source-quarantine extension658099c

Independent read-only native OpenAI Luna Max reviewer
`ses_e55054657ffebAGSulafITdIMx` inspected exact commit
`658099c51bdc27e359e32d2435c2c4b2901dfb6e` against parent8fcdca0. At review,
HEAD3a67378 had the same source delta; uncommitted changes were docs only.
Reviewer ran no tests; Root owns regression runs.

## P2: reject changed current input before native archive side effect

Runtime checks a running attempt's exact completed input before awaiting guard
activation (`src/runner/runtime.ts:2804–2818`). Native archive rechecks assignment,
project, owner, active state and pending input, but not current input ID
(`src/runner/native.ts:787–835`). A newer input can arrive and finish in that gap,
then be archived against the stale assignment. The runtime's post-archive read
should refuse sealing/source release, but the archive side effect already happened.

Required discriminating regression: complete a newer native input after the
runtime detailed check but before `session.update`; verify **no archive update**
occurs. Existing different-input case at runtime.test.ts1011–1044 rejects before
command admission and does not cover this gap; native cases708–759 do not test a
mismatched current input.

Finding delivered to existing99 ownerc59b at1793870487190,
message `msg_1ab035e90001twHZn89fBCsxQt`. It was then corrected and reviewed as below;
it is no longer a hold or a reason to await another Root release.

## Corrections reviewed: source-clear for guarded operation

Root `eb7d696` checks retained current input for running attempts before native
archive update and during readback. Tests cover a changed input before update
(zero archives) and a change during update (pending quarantine, source admission
held, no repeat archive). Final16 tests/260 assertions pass per Root.

Root `9c342e2` closes the separate Code Mode fetch bypass: pinned Code Mode fetch
asserts webfetch permission outside tool hooks, so a native permission-evaluate
hook now denies webfetch for quarantined session IDs. Other sessions/actions are
unchanged; lookup errors are not converted into allow. Root39 role/adapter/fence
tests/237 assertions and quality pass.

The same Luna Max reviewer performed a quick source-only delta check of those two
commits: **clear, no remaining blocking finding**. No tests were rerun. A change
after the precheck can still coincide with the native archive call; readback then
prevents sealing/source release. Do not claim an atomic expected-input native API
or complete absence of archive-side-effect races.

Clear verdict and Root's authorization were delivered to current99 ownerc59b at
1793871096912, message `msg_1ab0cac48001tX6zy8WWZl0n24`, requesting the supported
original-attempt quarantine flow. No force, cancellation, background-zero claim,
ownership transfer or historical acceptance was authorized. Inspect actual
pending→sealed and retained resources, then observe real scheduler activity.

Actual readback: request1793871135090 sealed1793871137427, planversion20,
resourceHoldsRetained:true. Native worker archived1793871137393; original tree
preserved. Node/attempt remain running/unaccepted, artifact null, old background
unknown reason retained. Original133 subsequently resumed in its original Luna Max
worker and completed two patches by1793871563436. This is source-admission progress,
not historical acceptance, background settlement or cleanup.

## Other inspected boundaries

Absent/mismatched turn metadata rejects. Native authorization binds the pending
request to exact project, attempt, session, message and workspace. Shared checkout
admission remains blocked; realpath checks/fail-closed resolution protect physical
workspace exclusion. Old attempts/effects remain unaccepted and uncertain. Role
unit tests allow outer execute while denying direct edit/bash; actual nested Code
Mode hook re-entry is a pinned OpenCode-host behavior, not demonstrated by that
unit test. Do not overstate this as an independently observed native bypass test.

Root's existing checks passed275 tests/4143 assertions; focused15/249 and36/207,
plus quality. Passing those tests does not cover the newly identified race.
