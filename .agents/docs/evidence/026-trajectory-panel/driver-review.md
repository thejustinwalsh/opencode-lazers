# Trajectory artifact review and early source landing

Reviewed task `f1b1a687-31b7-4edb-a6bc-1865f61e0bdd`, attempt
`360ba25c-ae49-4994-9712-b6f050066284`, accepted artifact
`4a518cb03dd682427b351b8850660bbd8948f1e8`. Review compared its changes against
its actual base `bb2c78d`, not a two-tip diff that would misrepresent later
canonical fixes as deletions.

The P1 check-attribution repair is present in `projection.ts`: all snapshot plans
containing the selected task contribute allowed plan IDs. Null-task checks from
unrelated plans and unknown/null/missing legacy plan IDs are excluded. The
regression includes two associated plans, an unrelated plan, reverse plan order,
legacy IDs and a directly task-linked check. Source review also covered native
registration, scope/cancellation and late-response handling, recorded interval
geometry, unique-session all-attempt totals, unknown API-equivalent cost and
closed Activity/payload disclosures. No blocking defect was found for this
self-contained renderer increment.

The worker's accepted checkout passed focused checks **19 tests / 112
assertions**, plus formatting, lint and strict TypeScript. Driver normally merged
the artifact into canonical main as
`9b0dcdc8b670b76f7ca7c765f7611b9ca80ccea0`, preserving later projection, Tasks,
speech, context, debugger and runtime fixes. Canonical focused checks passed
**20 tests / 124 assertions**, `bun run verify` passed, and the existing GUI build
passed with its existing bundler import-meta/deprecation warnings. The first
full-suite tool call was interrupted and is not counted as a pass; the subsequent
background `bun test` completed **283 pass / 0 fail / 2,614 assertions** across
60 files in 49.34 seconds.

## Actual registered data through the returned adapter

Driver called the existing native registered observation RPC in canonical Project
scope and parsed the responses with this artifact's actual adapter. Selected
Trajectory and accepted speech returned five-event rich pages in **230 / 231 ms**
in this observation. Each produced one attempt and three check intervals; their
origins were the recorded reservations **1793482036078 / 1793478049923**. Both
kept API-equivalent cost unknown, and no null-task check belonged to an unrelated
plan. These are individual RPC/adapter observations, not latency guarantees or
mounted native-panel evidence.

## Remaining feature boundary

This source landing does not register whole-plan integration or remove the
worker checkout. Existing assembly task `8db1b281` still wires both renderers,
their stores and the combined production bundle, then Root captures actual
Desktop panels for Terra. Native narrow/short layouts, source/session-link
navigation, resize/reopen/scroll/reconnect behavior and visual alignment remain
assembly observations, not established by source tests or the existing GUI build
(which does not yet import these new registrations). Keep the graphical
statechart versus task-DAG distinction and all unknown timing/cost semantics.
