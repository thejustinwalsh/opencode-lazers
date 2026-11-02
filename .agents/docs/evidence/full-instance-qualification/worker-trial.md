# LZ-50 worker trial evidence — 2026-11-02

## Result

**Native candidate feature scenario completed and retained.** In an isolated
OpenCode Desktop 2.2.5, this admitted worker used the candidate's owned native
interaction adapter to submit one Architect task from the visible prompt. The
task database in the owned profile contained exactly one matching persisted
task, `LZ-1`, with the requested acceptance criteria, write scope, project path,
and fixture starting revision. No worker dispatch or task execution occurred.
The stale-action test was denied before delivery, then a fresh observation
preceded the corrected action. The owned fixture and app/service profile were
removed by the owned cleanup path; the driver process, authenticated endpoint,
listener and protocol-handler baseline remained unchanged.

The runbook and retained structured observations are in
[`product-verification.md`](../../product-verification.md) and
[`native-observation.json`](native-observation.json). This report distinguishes
the actual worker-visible behavior from source analysis and records all owned
relaunches. Cleanup needed bounded retries; the older generic error messages do
not establish the underlying cause.

## Source and implementation findings

- OpenCode 2.2.5 resolves the isolated service registration under the effective
  XDG state path. The launcher uses a fixed per-launch base, explicit selected
  loopback port, isolated registration, authenticated `/api/info`, and matching
  process PID/version before Desktop startup; it does not use `Service.ensure`
  or the driving service's registration.
- Desktop startup can reset the process working directory to the home directory.
  Setting `HOME` alone did not isolate macOS Foundation's Documents path. The
  working isolated environment now sets and validates matching `HOME` and
  `CFFIXED_USER_HOME` values below each owned root.
- Bun and Node/Electron read the same filesystem nanosecond mtime but rounded
  `Date.toISOString()` differently at a millisecond boundary. The candidate GUI
  identity now floors `mtimeNs` to whole milliseconds consistently; the
  revision, byte length, timestamp and dirty-path checks remain in force.
- `processIdentity` previously mapped all `ps` errors, nonzero exits and malformed
  output to `null`, while cleanup treated `null` as proof of absence. The
  implementation now distinguishes authoritative absence, matching live
  identity, identity change and unavailable observations. Bounded shutdown
  distinguishes a still-live main process, observed exit, helper drain, helper
  inventory failure and identity/observation failure; no timeout inflation,
  signal escalation or weaker identity match was introduced. Focused tests cover
  actual `ps` observations for the current and an absent PID, parsed probe error
  branches, process identity changes, persistent helpers and blocked root
  removal. The actual cleanup retries below predated this final cleanup-code
  revision and do not identify their own cause.
- The native adapter is fixed to the owned MainContext/window and authenticated
  sidecar binding. It returns bounded snapshots and rechecks a live focused
  window, snapshot reference, generation and rendered content before input; it
  does not offer arbitrary JavaScript, global CUA, automatic input replay or
  driver-service fallback.

These are implementation/source findings; the native interaction and persisted
task below are the behavioral observations.

## Per-launch history

1. **Earlier recorded launch `bB3Lby` (candidate revision
   `b35c1d3f41118abe43b203f4c2e679a5df144e94`):** the prior retained trial note
   records an adapter-unavailable result, no native snapshot/input, and cleaned
   root. Its recorded Desktop/service PIDs were 66393/66330 and port 61222. This
   original failure history is preserved; it is not replaced with later results.
2. **`z1DCM8`:** service PID 53182, Desktop PID 53190, port 64288, candidate
   revision `bb159b83ecfd29786bbcf5371789ce1f40fffdb4`. The adapter did not
   attach. The redacted startup category named only `guiEntryModifiedAt`; a
   Bun-side probe and Node/Electron had observed identical nanoseconds but
   returned different rounded ISO milliseconds. No input was sent. Cleanup
   reported `cleaned`; the timestamp representation was then corrected without
   relaxing the identity check.
3. **`Qm5WAN`:** service PID 58144, Desktop PID 58152, renderer PID 58178,
   window 1/generation 1, port 64695. The adapter attached, but the first
   bounded snapshot exposed `/Users/tjw/Documents/Default Project`. No input was
   sent. Cleanup returned `cleanup-blocked` twice and later `cleaned`; the root
   was removed, its recorded PIDs and port were absent, and the handler baseline
   remained `ai.opencode.desktop`. The initial `HOME` isolation change did not
   alter Foundation's Documents path, so the trial remained stopped pending a
   correction.
4. **`LvVRJY`:** service PID 67568, Desktop PID 67623, renderer PID 67685,
   window 1/generation 1, port 65050. Despite isolated `HOME`, the snapshot
   again showed the operator's Documents path. No input was sent. Cleanup
   returned `cleanup-blocked` twice and later `cleaned`; root/process/port checks
   were clear and the protocol handler remained unchanged. Inspection of the
   installed Electron app showed it uses macOS Foundation's Documents path;
   matching `CFFIXED_USER_HOME` was added and positively checked before further
   interaction.
5. **Qualified launch `HXoIsS`:** candidate revision
   `bb159b83ecfd29786bbcf5371789ce1f40fffdb4`, Desktop/service 2.2.5, Desktop PID
   80331, service PID 80322 at `127.0.0.1:49390`. The explicit verification base
   was `/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-product-verification`.
   The native status and fresh owned-launch proof agreed on the root, service
   identity, isolated state/registration paths, candidate revision with no
   differences, and visible/focused window 1, webContents 1, renderer PID 80361,
   generation 1. The displayed project resolved to
   `<owned-root>/desktop/Documents/Default Project`.

## Native actions and persisted behavior

- The owned project was confirmed empty and inside the launch root, then
  initialized as a disposable Git repository. Its clean baseline revision was
  `8cf45d73cd2815352f88c8c34d06e94c0d6d9c39`.
- A click using a stale snapshot reference was denied with `not-delivered` and
  “Snapshot reference is stale; take a fresh observation.” No stale input was
  replayed. A new bounded snapshot established the current window generation and
  visible prompt before typing.
- Through the owned renderer only, the worker typed one request into the
  observed Architect prompt and clicked its observed Send control. Both actions
  returned `delivered`; a later bounded renderer snapshot showed the completed
  “Pure greet helper” response and `LZ-1`. Relevant request/snapshot IDs and the
  final observed title/result are retained in `native-observation.json`.
- The submitted task requests a pure exported
  `greet(name: string): string` helper, with `greet("Ada") === "Hello, Ada!"`,
  `greet("") === "Hello, !"`, focused Bun tests, and only
  `src/greeting.ts` / `test/greeting.test.ts` in its write scope. A read-only
  query of the isolated task database found exactly one task: ID
  `fb119a84-b8f7-4cca-b63e-0874646e60a7`, reference `LZ-1`, revision 1, status
  `submitted`, the owned project directory, acceptance IDs and fixture starting
  revision recorded above. No worker dispatch or execution was triggered; no
  files in the fixture were changed by the task scenario.
- The final native status was idle with the owned window generation unchanged.
  Text snapshots, bounded task facts and operation IDs were retained; no page
  screenshot or provider transcript was retained.

## Teardown and driver boundary

For `HXoIsS`, four invocations of the same identity-checked cleanup path returned
three retryable blockers followed by `cleaned`: two generic Desktop-exit blockers,
then one service-exit blocker, then success. Read-only `ps`/listener checks
between retries showed the owned Desktop/root-referencing helper processes had
disappeared after the Desktop blockers, and the owned service PID/port had
disappeared after its blocker. The cleanup path then confirmed the original
`opencode://` handler and removed the owned root, including the fixture and task
database. Post-cleanup checks confirmed the root and fixture absent, owned
Desktop/service PIDs absent, and port 49390 without a listener. The observed
sequence does **not** establish why earlier calls returned blockers; no zombie,
`ps` failure, or other incident cause is inferred. The reservation was retained
until cleanup reported success; nothing was force-deleted or signaled by process
name.

The driver baseline was PID 40217 (start time `Sun Nov 1 19:09:01 2026`),
listener `127.0.0.1:49374`, authenticated `/api/info` version 2.2.5, and handler
`ai.opencode.desktop`. After owned cleanup, the same PID/start time and listener
were present; an in-memory, read-only authenticated check again returned PID
40217/version 2.2.5; and the handler still equaled `ai.opencode.desktop`, so no
handler mutation/restoration was needed. No driver credential was printed,
copied, or used in the isolated profile. No canonical GUI, global CUA, profiler,
inference retry, or worker dispatch was used.

## Driver assistance and measured effort

- Root/Architect findings supplied the distinction between service discovery,
  authentication and process health; the stable explicit-base startup defect;
  and the cleanup-observation review. The user authorized same-attempt owned
  relaunches, warned against concurrent Desktop input, and clarified the owned
  input resumption boundary. These findings and authorization were not treated as
  interaction or behavior evidence.
- At the trajectory snapshot `2026-11-02T02:57:08.153Z`, the LAZERS attempt was
  still running and had 778 measured tool calls and 1 provider retry. Its one
  OpenCode session snapshot reported 1,804,275 uncached input, 96,366,848
  cache-read, 0 cache-write, 183,353 output, and 407,763 reasoning tokens. There
  is no recorded attempt end time or final wall-clock span; model-active time is
  not inferred. Recorded cost basis is unknown, so no API-equivalent cost is
  inferred.

## Remaining limits

The owned native task-submission path and persisted candidate behavior were
demonstrated in this trial. This scenario intentionally stopped at `submitted`;
it does not claim that a worker edited the disposable project or ran its greeting
tests. Cleanup blockers were retryable and ultimately resolved, but their precise
mechanical cause remains unknown. The process-observation correction is covered
by focused branch tests and actual local positive/absent `ps` observations; those
tests do not retroactively prove the cause of this launch's cleanup retries.
