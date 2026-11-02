# LZ-50 worker trial evidence — 2026-11-02

## Result

**Native full-instance gate unresolved.** This worker launched one owned
OpenCode Desktop and invoked the implemented `native-status` path. The isolated
service and candidate readiness checks passed, but the MainContext adapter never
attached: `native-status` returned `ready: false`, `blocked: false`, and no
windows. No native snapshot or input was dispatched. The worker therefore did
not submit a LAZERS task or create a fixture; source checks and sidecar health
are not substitutes for the feature walkthrough.

The owned-launch module, fixed MainContext interaction adapter, authenticated
sidecar RPC/CLI path, negative tests and runbook were implemented. One concrete
launch exposed a startup timing problem in the adapter path; a follow-up source
fix and tests are recorded below, but they were not loaded into the already
running Desktop and were not behaviorally qualified in another launch.

## Source-derived findings

- The installed Desktop/service sources identified in LZ-50 show that
  `OPENCODE_DESKTOP_TEST_ROOT` changes the Desktop/XDG data roots before app
  startup, but a shell overlay may still alter `XDG_STATE_HOME`.
- The pinned 2.2.5 service client defaults to
  `$XDG_STATE_HOME/opencode/service.json`; `Service.ensure` can reuse or replace
  a discovered process. The owned launcher does not call `ensure`: it verifies
  the explicit isolated registration path, starts a CLI service with an
  explicit selected port, authenticates `/api/info`, and checks PID/version
  before launching the app.
- The pinned service probe reads `/api/info` with the registration's Basic
  credentials and treats an undecodable/authentication-failed response as no
  discoverable service. A missing `discover()` result therefore does not prove
  the registered process is absent.
- The candidate redirect is a root-owned package whose entry imports the
  assigned checkout's `src/index.ts`; merely launching from a worktree would not
  activate that candidate. The package also exposes the candidate's built
  `gui-experimental` export, so the Desktop UI is not silently omitted. OpenCode's
  2.2.5 plugin config supports the package path plus options object. LAZERS task
  storage derives from `XDG_DATA_HOME`, so the trial task database will remain
  under the disposable test root.
- The packaged app can register the `opencode://` handler. The launcher records
  the existing handler and restores it only when the value changed to the exact
  trial bundle ID; unrelated handler changes block cleanup.

These are code/bundle observations only. They do not establish that an Architect
task behaves correctly in the native UI.

- The candidate-only GUI export conditionally starts a MainContext adapter
  only under the owned test-root environment. The adapter is designed to bind
  the owned process/service/candidate, enumerate `MainContext.windows`, return a
  bounded visible-DOM snapshot, use `capturePage`, and send allowlisted
  `sendInputEvent`/`insertText` followed by a fresh observation. The CLI exposes
  `native-status`, `native`, and no-replay `native-resolve`; candidate and
  cleanup state fail closed on pending or ambiguous delivery. The actual
  candidate Desktop ran this setup but reported the adapter unavailable after
  its 30-second startup window; its log did not include a failure category.
  Because the launcher and adapter both used 30-second readiness windows, the
  observed timing is consistent with a race but does not prove the exact cause.
- The in-scope follow-up raises the adapter's background startup window to 90
  seconds and logs only a bounded failure category. That correction was made
  after teardown, passed unit/quality/build checks, and was not loaded into or
  re-probed in a second Desktop launch under the one-launch authorization.

## Worker actions and observations

- Before launch, verified the installed `/Applications/OpenCode.app` and its
  CLI were both 2.2.5. A first launcher preflight correctly stopped before
  creating a root because CLI output `v2.2.5` did not match the packaged
  `2.2.5`; the parser was corrected to normalize the conventional `v` prefix.
- Read-only driver baseline before launch: PID `40217`, start time
  `Sun Nov  1 19:09:01 2026`, listener `127.0.0.1:49374`, and Launch Services
  handler `ai.opencode.desktop`. The existing credential in
  `~/.config/opencode/service.json` was used only in memory for authenticated
  read-only `/api/info`; it returned PID `40217`, version `2.2.5`. It was never
  printed, copied, or used in the isolated profile. An SDK `Service.discover`
  attempt against that password-only file failed with `Invalid URL`; it did not
  start, stop, or alter a service.
- The single owned launch returned `ready` with root
  `/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lazers-product-verification/lazers-full-instance-bB3Lby`,
  Desktop PID `66393`, owned service PID `66330`, and reserved port `61222`.
  Manifest evidence recorded the candidate checkout at revision
  `b35c1d3f41118abe43b203f4c2e679a5df144e94`, candidate Architect identity,
  isolated effective state/registration paths, and authenticated owned service
  PID/version. The Desktop process tree used only the test-root profile.
- `native-status` authenticated the owned sidecar and verified its PID/version,
  but returned `ready: false`, `blocked: false`, `windows: []`. The owned
  Desktop `main.log` recorded “Owned LAZERS native verification adapter is
  unavailable” without a reason category. No click, text, key, screenshot,
  browser-tool, driver-window, or other native input was used. No task or fixture
  was created.
- Cleanup returned `cleaned`. The owned root was removed, PIDs `66330` and
  `66393` were absent, and port `61222` had no listener. The protocol handler
  still equaled its pre-launch baseline (`ai.opencode.desktop`), so no
  restoration mutation was needed. After cleanup the driver remained PID
  `40217` with its original start time/listener, authenticated `/api/info` still
  returned PID `40217` and version `2.2.5`, and the handler still equaled the
  baseline. No driver service, process, credential, setting, or active worker
  was changed.
- After the launch failure and cleanup, and after the 90-second startup retry
  correction, `bun test test/product-verification` passed (29 tests, 116
  assertions); `bun run verify` passed formatting, lint
  and type checking; `bun run build:gui` completed. The GUI build emitted the
  existing Vite `inlineDynamicImports` deprecation and dependency `import.meta`
  CommonJS warnings. These checks do not qualify a successful native adapter
  attachment or feature task.

## Driver assistance and effort

- Driver assistance: Root supplied the discovery/authentication distinction and
  the user warned against concurrent Desktop input during the isolated trial.
  This assistance is not evidence of successful worker-native interaction.
- At the 2026-11-02 01:49 UTC trajectory snapshot, the attempt was still running
  with 419 measured tool calls and one provider retry. Its one session reported
  1,132,725 uncached input, 50,926,848 cache-read, 0 cache-write, 110,955 output,
  and 250,260 reasoning tokens. The attempt began at 2026-11-01 20:29:39 UTC,
  about 5h20m before the snapshot; this is observed attempt wall time, not final
  duration or model-active time. The recorded cost basis is unknown, so no
  API-equivalent cost is inferred. Native input time was zero because the
  adapter never attached.

## Remaining qualification

The adapter startup timing correction still needs a later explicitly authorized
full Desktop qualification: confirm `native-status` is ready, use bounded
snapshots and fresh native input for the disposable greeting-task scenario,
retain sanitized behavior evidence, remove the fixture, and verify owned cleanup
and the preserved driver boundary. That second launch was not attempted under
the one-launch limit for this worker trial. Until the adapter actually attaches
and the feature scenario completes, the native/full-instance acceptance
condition remains unresolved.
