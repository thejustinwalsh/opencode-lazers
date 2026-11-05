# LZ-139 native product observations

Reviewed main artifact: `d0fdafa` (includes original worker `3633c1f`, rendering
repair `8a371ae`, and location-fixture correction `0d809b4`/`d77937b`).
Task: `873b7617-e895-486d-bdba-7e89b07dee07`; plan:
`916474c0-4f49-4c42-80dd-718ff3c20ba3`. Original attempt and worker are retained.

## Checks

- Current-main assigned reads plus projection, connected target rendering and
  existing timing rendering: **87 tests, 879 assertions, no failures**.
- `bun fmt` changed no files (751 checked); lint and typecheck passed. GUI build
  and bundle evaluation passed. Logs: `/private/tmp/lz139-render-main-checks.log`,
  `/private/tmp/lz139-render-main-format.log`,
  `/private/tmp/lz139-render-main-gui-build.log`.
- The new connected render regression exercises a real scoped reader above the
  unrelated broad-project transition limit. It asserts zero broad snapshot reads,
  rendered attempts/checks and measured duration geometry.
- The older timing fixture lacked `location.directory` on its synthetic event.
  Adding the native envelope field makes its 106 assertions pass; production
  directory isolation is unchanged. No timeout increase or status-refactor waiver.

## Actual Desktop workflow

Root drove the native OpenCode Desktop window, opened Tasks with Project/Completed,
then opened completed **LZ-137** through **Open trajectory**. The intended task,
attempt, recorded check markers and duration bars rendered. Selecting its quality
marker updated the inspector to the same check:

- Start `1793863279991`, end `1793863280498` Unix ms; duration **507 ms**.
- Registration check start `1793863275851`, end `1793863279966`; **4115 ms**.
- Captured activity count208 and live progress130 are available; unknown attempt
  ends remain unknown. Screenshot:
  `/private/tmp/lz139-native-trajectory-restored-20261105.png`.
- Root expanded captured activity and used **Load more activity**: displayed
  captured records increased **50 → 98**, the continuation control disappeared,
  LZ-137 remained selected and updates stayed connected. This is an observed
  continuation, not a claim that the summary count208 equals displayed rows.

Root then selected the same **LZ-137** in Models and expanded its actual task effort:
one attempt, one unique worker session, coverage available; uncached input56,452,
output2,061, reasoning2,202, cache read820,992 and cache write0 tokens. Full-task
and market-equivalent cost both correctly remained **Unknown**. No broad-project
volume error or zero substitution appeared. The separate decision producer still
fails; this does not qualify the unfinished Models Compare graph or routing.

These observations establish the two product paths in this increment. They do
not assert unchanged DB rows, reconstruct historical idle gaps, or mark runtime
acceptance/cleanup complete. Architect must finish native acceptance and integration
through existing tools, retaining old failed receipts.

## Operational recovery during observation

Desktop-only quit/relaunch replaced main PID8893 with43129. Background service
PID95968 and original workers continued. All six inference flags stayed on and idle
unloading stayed Never. A real native local request returned `local GPU ready.`
(19 input/4 output tokens), and on-demand d1 returned
`{"ok":true,"kind":"boolean","value":true}`. This recovered the stranded cache
lease operationally; it does not prove the queued generation-retirement repair.
