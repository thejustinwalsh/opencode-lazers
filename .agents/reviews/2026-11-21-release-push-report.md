# Release push report, 2026-11-21

One driver session, from a restart request in the morning to a budget stop in the evening.
What is left is in [the remaining-work plan](../plans/v020-remaining.md).

## Update, later the same evening

The panel branch finished its last merge round and passed the full gate at `812265ea` (Fallow
0; 0 test failures). It is merged into `main` and pushed, so the section "Built on
`feat/panels-all`" below is now on `main`. The running service has NOT been restarted on it:
the schema changes need a restart, and no panel has been checked on screen. The startup fix and
the Planning-panel finding are in that merge as described; `progressDiagnostics` and the
all-projects paging behind it are deleted.

## Where things stand (as first written)

| Item                           | State                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `github/main`                  | `c373a885`: gated work through `5325937b`, plus LZ-216 integrated by the product       |
| Running service                | Restarted 22:46 UTC on `09797230` (runner schema 21)                                   |
| Panel branch `feat/panels-all` | `64ffeb95`, full gate green; a second merge round was in flight (see the plan, step 0) |
| On-screen verification         | **None done.** No panel has been looked at in the app                                  |
| v0.2.0 tag                     | Not cut. Waits for on-screen checks and the owner's go                                 |

## Landed on `main`, gated and pushed

| Change                                          | Effect                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Planning review tick, plan memo, storage timing | Idle reads per quiet minute 264 → 167                                                  |
| Audit retention                                 | Already followed the configured age; tests and Settings hint added                     |
| Renewal coverage                                | A stale checkpoint summary is repaired from its rows; the renewal continues            |
| ruNNtime `lazers-omni-625c05e`                  | GPU buffer limits requested; released on the owner's fork                              |
| Integer keys                                    | Online migration; six text-id indexes dropped                                          |
| Fallow cleanup                                  | 503 findings → 0; three dependencies removed                                           |
| Stall interrupt                                 | Runs from durable facts; a shell counts as progress only while its output grows        |
| Cancelling exit                                 | A cancelling plan with terminal nodes reaches cancelled                                |
| Renewal on notice                               | An idle Architect is renewed only when a notice waits                                  |
| Truthful resume                                 | An automatic resume records attempted, then admitted or refused with the host's reason |

## Verified live after the 22:46 restart

| Check                                 | Result                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Integer-key migration                 | 419,173 transitions and 80,293 progress rows keyed; 0 without a key; 0 mismatches |
| Database file                         | 1.42 GB                                                                           |
| Plan stuck in cancelling for 49 hours | Cancelled                                                                         |
| Stream probe over RPC                 | Open 103 ms, slide 2-3 ms                                                         |
| Renewals in the next 10 minutes       | 1 (was about 5 an hour, 130 since Nov 20)                                         |

## Product loop

| Task             | Outcome                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| LZ-144           | Integrated and pushed by the product                                                                                                      |
| LZ-225           | Plan integrated                                                                                                                           |
| LZ-216           | Worker commit `7372bb87`; the Architect composed it with the stream-backed Tasks panel (`073b7a54`); integrated and pushed by the product |
| LZ-227           | Cancelled as superseded                                                                                                                   |
| LZ-255           | Cancelled on the owner's decision; main deletes the gate it worked around                                                                 |
| LZ-228 to LZ-231 | Still paused; superseded by the panel work                                                                                                |
| LZ-252, LZ-253   | Hold lifted; combined check rerun                                                                                                         |

Driver-assisted, not product recovery: one interrupt of LZ-216's worker (a test run spinning at
100% CPU for 1 h 50 min, 3 GB), several Architect form answers, and relays of owner decisions.

## Built on `feat/panels-all`, gated on the branch, not on `main`

All five panels read through streams. Shared pieces: a projection owner with paged, resumable,
versioned backfill; a `projection` state machine; a host-backed stream kind for data OpenCode
owns; a guard in `bun run verify` that fails on a new RPC read in a panel.

| Panel      | What changed                                                                                          | Parity                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tasks      | Detail, attempts, activity, current activity and search from stored rows; `Tasks.get` deleted         | 21 detail cases, 8 searches, all three task tools field for field |
| Radar      | Worker pane, Map, lifecycle, Monitor sessions, calls and Flow; `liveRadar` and its 512 KB cap deleted | Flow and Monitor match a recording of the old read                |
| Models     | Candidates, decision views, assignments; catalog build 1.3 s → about 20 ms                            | Stored results equal the old reads byte for byte                  |
| Projects   | Overview and Verification group; 3 s poll removed                                                     | Stream rows equal the old profile view                            |
| Trajectory | Events, effort and a host-backed transcript; two 128 MB caches deleted                                | Event order and the tool's sections match the old read            |

Stored metadata under the owner's rule (no message text): `host_session_state`,
`transcript_steps`, `transcript_sessions`, `trajectory_task_effort`. A test seeds six secret
strings in message text and finds none in the database file.

| Measure                                         | Before     | After                    |
| ----------------------------------------------- | ---------- | ------------------------ |
| Effort refresh on the main thread               | 80-110 ms  | 0.6-0.8 ms median        |
| Stored effort row, 3,619-step task              | 2.98 MB    | 31 KB                    |
| Candidate build on the main thread              | 115-180 ms | 30-36 ms across 7 writes |
| Lines of old read code deleted in the last pass | —          | 10,511                   |

## Defects found on the way

| Defect                                                                                  | State                             |
| --------------------------------------------------------------------------------------- | --------------------------------- |
| A running shell exempted a worker from the stall interrupt forever                      | Fixed, on `main`                  |
| A cancelling plan could never reach cancelled                                           | Fixed, on `main`                  |
| An idle Architect was renewed every 10-15 minutes                                       | Fixed, on `main`                  |
| An interrupted turn read as completed, so resume was refused and the error swallowed    | Fixed, on `main`                  |
| A trigger's `INSERT OR REPLACE` fails under an outer upsert (broke unpausing a project) | Fixed on the panel branch         |
| Transcript paging: the real host puts cursors on every page; a tail window opened empty | Fixed on the panel branch         |
| Plugin load dies when the database is locked (one location lost all RPCs at restart)    | Fixed on `fix/load-busy`; merging |
| `reload-safe` counts stale attempt rows                                                 | Open                              |
| Retention status counts all history                                                     | Open                              |
| Planning panel polls an RPC every 3 s                                                   | Open; agent stopped for budget    |

## Owner decisions taken today

Release v0.2.0 public; show the report before tagging; all four panels in the release; the
product builds product tasks; Opus for architecture and root-cause work; zero Fallow findings at
a 100-token clone threshold; integer keys landed; lease term stays 30 s; ruNNtime fix released;
git-hardening dropped (patch parked); session titles stored; transcript metadata stored and text
read from OpenCode; LZ-255 cancelled; both Architect holds lifted; standing permission for
restarts, window reloads and window moves until the tag.

## Mistakes by the driver

1. A restart ran while the safety check said no; a pipe hid its exit code. The Architect turn had
   ended one second earlier, so nothing was cut.
2. Told the owner audit runs were kept forever. They already followed the configured age.
3. Removed transcript storage wholesale when the owner only asked what it was for.
4. Did not check for Architect forms for hours; two Architects waited on answers, which is why
   no quiet point came.
5. Three agents copied live database tables to scratch files before the briefs forbade it. All
   copies are deleted.
6. One agent amended a commit on its own unpushed branch.

## Not verified

- Every panel on screen, the website demo in a browser, and LZ-144, LZ-216 and LZ-225 in the app.
- A working hour with real workers on the new build: memory, stalls and timing.
- New messages arriving through a stored transcript cursor on a growing session.
- A model-scale GPU run on the new ruNNtime release.
- Whether `c373a885` passes the full gate; the product verified it, the driver did not.
