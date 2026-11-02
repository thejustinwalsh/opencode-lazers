# Full Desktop product verification

This runbook is the controlled macOS path for exercising a LAZERS candidate in
OpenCode Desktop 2.2.5. It launches a separate Desktop profile and service; it
does not repoint, restart, or authenticate through the driving OpenCode service.
The first worker qualification is recorded in
[`evidence/full-instance-qualification/worker-trial.md`](evidence/full-instance-qualification/worker-trial.md).

## Safety boundary

- Run only with explicit trial authorization and a native Desktop interaction
  surface available to the admitted implementer. Browser-page controls alone do
  not satisfy the native interaction gate.
- The launcher supports macOS and requires an explicit Desktop `.app` bundle,
  its same-version CLI executable, and the same candidate/target checkout.
- The launcher creates a unique directory beneath the stable per-user system
  temp root reported by `getconf DARWIN_USER_TEMP_DIR`, at
  `opencode/lazers-product-verification`. It records the canonical base/root,
  candidate revision and dirty paths, app/CLI versions, test-root XDG paths,
  service identity and protocol-handler baseline. The isolated environment also
  carries `OPENCODE_LAZERS_VERIFICATION_BASE`; manifest, owner marker, private
  permissions, symlink status, and containment under the system temp root are
  checked independently. The spawned service and Desktop also use matching
  owned `HOME` and `CFFIXED_USER_HOME` paths beneath the test root; the latter
  keeps macOS Foundation's Documents path inside the profile, so a default
  project cannot resolve to the operator's real home. Validation does not
  recompute the base from the owned profile's `TMPDIR`. It does not copy
  the driving profile, provider credentials, service registration, or service
  authentication. Set up any model access through a separately authorized,
  supported mechanism in the trial profile; if that is unavailable, stop before
  the feature scenario.
- The isolated CLI service starts on a selected loopback port other than
  OpenCode's default `49374`. The Desktop process is not started until the
  registration path and authenticated `/api/info` PID/version match the spawned
  service and its endpoint. No `Service.ensure` call is used by the launcher.
- The packaged Desktop may register `opencode://` globally. The launcher records
  the existing handler before startup; teardown restores it only if it changed
  to this trial's exact bundle ID, then reads it back. Any other change blocks
  teardown and retains the owned root for review.
- Never manually delete the owned root, registration, or lock; do not kill a
  process by name. `cleanup` checks PID, start time, command, registration and
  authenticated service identity before stopping it. A timeout or ambiguous
  identity keeps the root and reservation so cleanup can be retried safely.
- Do not arm profiling, change the canonical profile/GUI, follow protocol links,
  or interrupt any existing worker. Record the driver PID, listener and handler
  read-only before and after the trial. Do not print or copy credentials.

## Preconditions and setup

1. Confirm the native-control permission and use a throwaway, no-secret fixture.
   If native Desktop interaction is unavailable, record the limitation and do
   not launch the app. Confirm the driving service and URL handler without
   reading credentials, for example:

   ```sh
   lsof -nP -iTCP:49374 -sTCP:LISTEN
   defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers
   ```

   Capture the listener PID/start time and the `opencode` scheme handler in
   private notes. Avoid broad output retention if unrelated handlers are
   sensitive.

2. From the candidate checkout, build its Desktop GUI export and identify the
   installed app/CLI pair. `build:gui` is a one-shot build, not a listening
   server. It uses the repository's pinned WebGPU engine cache and may fetch the
   pinned asset if that cache is absent. The built export stays in ignored
   `dist/`; the owned profile symlinks only that GUI entry while importing the
   candidate server entry directly from `src/index.ts`. The CLI must report the
   same version embedded in the app bundle; the launcher checks this before
   creating any trial process.

   ```sh
   cd /path/to/assigned-candidate
   bun run build:gui
   CANDIDATE="$(pwd -P)"
   DESKTOP="/Applications/OpenCode.app"
   CLI="$HOME/Library/Application Support/ai.opencode.desktop/cli/2.2.5-arm64/opencode-cli"
   ```

   Change `CLI` only to the actual same-version executable installed with the
   selected app. The binary may come from the ordinary installation, but no
   config or credentials from its profile are read or copied.

3. Start the isolated trial:

   ```sh
   bun src/verification/opencode/cli.ts launch \
     --desktop "$DESKTOP" \
     --cli "$CLI" \
     --candidate "$CANDIDATE" \
     --target "$CANDIDATE"
   ```

   A successful command returns a manifest summary and the owned `root`. Keep
   that exact path as `ROOT`. Setup creates the isolated Desktop/XDG folders, a
   candidate-only plugin redirect, and a global OpenCode config under the root;
   it verifies the login-shell overlay before starting the service. It refuses
   an existing trial root/registration, a non-restorable protocol baseline, an
   unexpected handler, or a candidate/target mismatch. It then starts the CLI
   with explicit `--service`, loopback host and selected port; reads the
   test-root registration; authenticates `/api/info`; verifies registration,
   process PID/start time/version and selected port; and only then launches the
   Desktop executable. Readiness requires the Desktop process to use its owned
   user-data directory and the isolated service to expose the candidate's
   `architect` primary agent with the recorded description.

   The summary intentionally omits the service password. Do not inspect or
   publish the raw `service.json`. If startup reports retryable cleanup, use the
   root path included in the error and follow the cleanup steps below. If the
   setup fails before a root is returned, locate only this tool's roots with:

   ```sh
   bun -e 'import { defaultBaseDirectory } from "./src/verification/opencode/owned-launch.ts"; console.log(defaultBaseDirectory())'
   ```

   Inspect candidate `owned-launch.json` files; never guess a PID or remove a
   directory manually.

## Native interaction adapter

The isolated launch conditionally enables a fixed RPC bridge only when
`OPENCODE_DESKTOP_TEST_ROOT` is set. The bridge binds each request to the owned
manifest, authenticated sidecar, candidate identity, and a live MainContext
adapter. It does not expose arbitrary JavaScript or direct plugin handlers. The
adapter reads a bounded rendered-DOM snapshot, can capture the owned window with
Electron `capturePage`, and sends only allowlisted mouse/key input or plain text
through the owned window's `webContents`. It rechecks the window generation,
focused state, referenced snapshot and rendered-page digest before input, then
returns a fresh observation. A timeout or uncertain delivery is not replayed;
the request and owned cleanup remain blocked until the same request can be
resolved conclusively.

Use the verification CLI from the candidate checkout while the owned Desktop is
running. It reads the owned service credential internally and does not print it
or copy it to another profile:

```sh
bun src/verification/opencode/cli.ts native-status --root "$ROOT"
bun src/verification/opencode/cli.ts native --root "$ROOT" --kind snapshot
```

`native-status` reports only the owned adapter state and bounded window
references. Select the visible, focused window shown by the result. A snapshot
prints its `snapshotID` and bounded visible controls (`e0`, `e1`, ...). Review
that output in context; do not paste secrets into the command line or use it to
inspect unrelated content. Before any input, positively recheck the owned
root/base, authenticated service, candidate identity, and window generation, and
confirm the visible project is the owned fixture or exact candidate checkout;
stop if a real-home or unrelated project appears. For example, after confirming
the exact visible control and fresh snapshot:

```sh
bun src/verification/opencode/cli.ts native --root "$ROOT" --kind type \
  --window 12 --snapshot SNAPSHOT_ID --element e0 --text 'Return Hello, world!'
bun src/verification/opencode/cli.ts native --root "$ROOT" --kind click \
  --window 12 --snapshot NEW_SNAPSHOT_ID --element e1
```

Use only for the disposable no-secret fixture. Text entry accepts ordinary text
only into a rendered editable control; password/credential-like controls and
credential-shaped text are refused. The only key operations are Enter, Escape,
Tab, Backspace, ArrowUp and ArrowDown. An action requires a fresh snapshot and a
focused owned window; if its rendered content or generation changed, take a new
snapshot and decide again rather than retrying the old action. Each returned
snapshot is a new observation, not proof that a task was submitted or completed.
If `native-status` reports `ready: false`, do not send input. Inspect only the
owned Desktop's `main.log` for the adapter's allowlisted `reason` and redacted,
bounded `detail` fields before teardown; do not publish the full log. Cleanup
removes the owned logs with the test root, so record only those safe fields and
necessary timestamps.

The optional screenshot command captures the owned Desktop window, not a
browser-tool screenshot. Use it only after a human has confirmed that the entire
visible page is safe to retain; automatic credential filtering is best-effort,
not a privacy guarantee:

```sh
bun src/verification/opencode/cli.ts native --root "$ROOT" --kind capture \
  --output trial-safe-page.png --confirm-safe-page yes
```

The command writes a new, mode-restricted PNG under
`.agents/docs/evidence/full-instance-qualification/` in the candidate checkout.
Only single-component `.png`, `.md`, or `.json` outputs in that task-scoped
evidence directory are treated as probe evidence rather than material source
changes. The manifest retains the initial candidate revision and dirty-path
provenance; edits elsewhere, or other file types in that directory, invalidate
the launch proof and require fresh setup/observation. This narrow evidence
scope is not a clean-tree requirement or a general exemption for docs/data.
Keep screenshots only when they contain no credentials, unrelated chats,
personal data, or other sensitive material. If native delivery becomes
pending or ambiguous, inspect only that request:

```sh
bun src/verification/opencode/cli.ts native-resolve \
  --root "$ROOT" --request REQUEST_ID
```

This command only reads the same request's result. It does not replay an input
or override an ambiguous outcome. If the result is still unknown or ambiguous,
leave the trial root and reservation intact and do not run cleanup.

## Native feature scenario and retained evidence

1. Before touching a window, confirm `native-status` is ready and positively
   validate its owned root/base, authenticated service, candidate identity, and
   visible focused window/generation. The macOS Documents path must resolve below
   `ROOT`; stop without input if the visible project is outside the owned root.
   Keep the fixture and messages free of secrets. The host model may use only
   separately authorized trial authentication; never import the driver's
   credentials.

2. The isolated OpenCode 2.2.5 profile uses
   `ROOT/desktop/Documents/Default Project` as its default project. Only use it if
   the path is an empty directory resolving beneath `ROOT`. Create a clean Git
   baseline from a separate shell:

   ```sh
   FIXTURE="$ROOT/desktop/Documents/Default Project"
   test -d "$FIXTURE"
   test -z "$(find "$FIXTURE" -mindepth 1 -maxdepth 1 -print -quit)"
   cat > "$FIXTURE/README.md" <<'EOF'
   # Disposable LAZERS Desktop verification fixture

   Empty baseline for a single no-secret greeting-task submission scenario.
   EOF
   git -C "$FIXTURE" init --quiet --initial-branch=main
   git -C "$FIXTURE" add README.md
   git -C "$FIXTURE" -c user.name='LAZERS Qualification' \
     -c user.email='lazers-qualification@example.invalid' \
     -c commit.gpgsign=false -c core.hooksPath=/dev/null \
     commit --quiet -m 'Add owned qualification fixture'
   git -C "$FIXTURE" status --short
   ```

   Record the fixture's starting revision. Do not add credentials, user files,
   dependencies, or unrelated source.

3. In the owned Desktop, select **Architect** and submit exactly one task to add
   a pure exported `greet(name: string): string` helper that returns
   `Hello, <name>!`, with acceptance for `greet("Ada") === "Hello, Ada!"`,
   `greet("") === "Hello, !"`, and passing focused Bun tests. Limit writes to
   `src/greeting.ts` and `test/greeting.test.ts`; exclude UI, dependencies,
   configuration and unrelated work. Use a fresh idempotency key. For this
   submission scenario, stop at `submitted`: do not dispatch a worker or execute
   the task. Verify the task through the visible LAZERS task UI and, when needed,
   a read-only query of the owned task database. Do not use a manual SDK call or
   browser-only UI as a substitute for native input.

4. Retain only non-sensitive evidence outside `ROOT`, beneath
   `.agents/docs/evidence/full-instance-qualification/`: candidate revision and
   dirty paths, Desktop/CLI versions, fixture starting revision, native request
   and snapshot IDs, stale-action denial and correction, task reference/status,
   exact task scope, persisted facts, driver assistance, measured effort and
   cleanup outcome. Keep source-derived facts separate from native observations.
   Text observations or a safely reviewed owned-window screenshot are sufficient;
   do not retain authentication tokens, unrelated chats, personal data or full
   provider transcripts.

## Teardown and restoration

1. Record final behavior and task state outside the owned root. Ensure no
   dispatched worker or active task is still using the fixture. A task
   intentionally left `submitted` with no dispatch, as in the scenario above,
   may be removed with its owned profile after the status is recorded.
2. Run cleanup with the exact root returned by `launch`:

   ```sh
   bun src/verification/opencode/cli.ts cleanup --root "$ROOT"
   ```

   Cleanup positively identifies and stops the trial Desktop and service,
   verifies service authentication/process identity when it is still running,
   confirms/restores the protocol handler, checks for remaining owned Desktop
   helpers, and removes the owned root only when all checks pass. It prints
   `cleaned` after removal. A `cleanup-blocked` result preserves the root and
   reservation; the reason distinguishes a live main process, changed identity,
   unavailable process observation, remaining helpers, and unavailable helper
   inventory. Inspect only the owned resource identities without editing them,
   resolve or re-observe the concrete issue, then retry the same command. Never
   force-delete a blocked root or send a signal by PID/name yourself.

3. Repeat the read-only driver listener/handler check from setup. Confirm the
   original driver PID/start time, authenticated endpoint (using only its
   already-supported authorized path, never printing its credential), and
   handler baseline are unchanged/restored. Record this separately from the
   trial service result.

## Known qualification boundary

The linked worker trial qualifies the owned native task-submission path and
persisted `submitted` task behavior. It does not claim a dispatched worker edit
or focused greeting-test execution; those require a separately authorized
scenario. Focused tests cover cleanup decision branches, while live cleanup
blockers in the recorded trial required retries and their precise cause remains
unknown. The report preserves that limitation rather than inferring a cause from
the tests.
