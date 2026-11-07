# LZ-175 `7727cc4`: focused independent rereview

The same native Luna Max reviewer rereviewed exact
`7727cc4cb3d823c82f259719a2ced47cc2261642` against direct parent
`c135109f29c333276cffa33278c77fc86b931b0a`, retaining the prior review context
and original LZ-175 contract. Architect confirmed the clean exact HEAD/parent
in existing native `/private/tmp/lz175-binding-repair-20261107` before delegation.
The review was read-only: no implementation, tests, controls, merge or activation.

## Result: no material findings in the correction

All three findings from `312dabd` and the worker-staleness finding from
`c135109` are resolved:

- **Reservation owner fence:** `src/runner/runtime.ts:2533–2565` validates a
  fresh native owner between the repair worker's before/after observations.
  The final command transaction checks that owner snapshot with durable owner,
  plan revision/version and control epoch (`2998–3078`).
- **Acceptance owner fence:** `runtime.ts:9463–9484` places fresh owner
  validation between worker observations after checks. The final synchronous
  Git check and fenced transaction preserve task, disposition, attempt, repair,
  plan and epoch checks (`9521–9558`).
- **Late scope conflicts:** existing attempt, adoption and retained-verification
  scans (`711–749`) repeat inside final reservation before operation creation
  (`3070–3078`).
- **Worker changes during owner lookup:** the existing observer checks worker
  state before/after the owner callback and compares the full observation
  (`675–708`), following the retained-repair prompt admission pattern
  (`7123–7175`) with no trailing native await. Six registered-path regressions
  cover input, busy and route changes during that lookup at admission and
  acceptance (`src/runner/retained-reverify.test.ts:782–828`). No polling,
  daemon or new protocol is introduced.

The reviewer found no regression in this delta's Git, scope, immutable candidate
binding or hold-preservation fences. This resolves the source concerns in
`lz175-312dabd-source-review-20261107.md` and
`lz175-c135109-focused-rereview-20261107.md`; those reports remain historical.

## Evidence limits and follow-through

Tests were **not rerun** by the reviewer or Architect. Root supplied:

- Six new races fail on `c135109` and pass on `7727cc4`; all 13 review races pass.
- Exact corrected candidate's declared checks: 75 tests / 813 assertions /
  four files in 39.09 seconds; formatting, lint, typecheck, diff, GUI build and
  bundle evaluation pass.
- Broader 593 tests / 7,800 assertions / 29 files passed on **parent `c135109`**,
  not on `7727cc4`. Do not relabel this as a corrected-candidate broad run.

This is a clean focused source review, not live retained-verification qualification
or task fulfillment. Root owns reviewed integration, quiet activation and exact
native LZ-173/LZ-174 follow-through before normal LZ-175 disposition. No merge or
activation was performed here. Keep LZ-175 undispatched, original LZ-173/LZ-174
workers and held source/history/usage intact, and all unknown original background,
source, human and resource holds truthful. No full-tree fingerprint or fabricated
idle/resource proof is authorized. Completed LZ-165 remains separate.
