# LAZERS scheduler: one process-global scheduler, no feature flag

Owner direction (2026-11-18): LAZERS needs one global scheduler that every
project registers with, wakes reliably, and avoids fixed-interval polling.
Scheduled tasks are an upcoming feature that loads a project or session on
demand and drives it.

OpenCode 2.3.0 has a native Schedule service, but it sits behind the
`schedules` feature flag, which is off on the release channel. We do not
build on it yet. We build our own, modelled closely on the native one, so we
can switch to it once it ships or deprecate ours.

The research was done 2026-11-18 against the OpenCode 2.3.0 source (`dc2ffcf8`).
File and line references below are to that source unless prefixed `src/`.

## Problems this solves

- **Idle eviction stops the scheduler.** OpenCode evicts a location after 60
  minutes without session events (`core/src/location-activity.ts:30,79-118`).
  When every location of a project is evicted, that project's LAZERS scheduler
  stops, and queued work stalls silently.
- **Polling and lost delays.** `PROJECT_RECONCILIATION_INTERVAL_MS` polls
  every 5 minutes. Delays such as the lease retry or the 15 s outcome retry
  live only in memory and are lost on restart.
- **Stale scheduler code.** `sharedScheduler` is created once with `??=`
  (`src/runner/scheduler-coordinator.ts:216-220`), so it keeps the first
  module generation's code until the process restarts.

## How the native Schedule works

`core/src/schedule.ts`:

- **Table `schedule`.** One row per schedule: `when` (`in`, `at`, `every` or
  `cron`, plus `tz`), `status` (`active`, `paused` or `done`), `next_due_at`,
  `retry_at`, the counters, and `last_outcome` (`fired`, `late`, `checked`,
  `expired`, `skipped`, `disabled` or `failed`).
- **Leader.** A KV row `schedule:leader` lives 60 s and renews every 20 s.
  Every row re-claims leadership before it fires.
- **Doorbell loop.** The loop sleeps until `min(next_due_at)`, but never longer
  than `MAX_SLEEP = 30s`. A create or resume rings the doorbell to wake it.
  With no active rows it gives up leadership and naps.
- **Catch-up.**
  - A row that came due while the service was down fires once, oldest first.
  - A fire 60 s or more late is recorded as `late`.
  - `every` keeps its phase and skips missed slots.
  - `cron` handles the DST fall-back.
- **Idempotency.**
  - The prompt id is `msg_<sch>_<run>`.
  - `pending`: if the last prompt is still in the inbox, the loop does not
    prompt again.
  - `rewake`: when a process gains leadership, it re-wakes unclaimed prompts.
- **Back-off.**
  - A failed prompt retries after 5 minutes.
  - A failed check retries after 1 minute; three strikes pause the row.
  - A missing directory pauses the row.
- **Location boot.** Firing boots the location with `instances.provide(session)`,
  then waits for `Plugin.awaitActivation` before running any check.

## Design

```
 globalThis[Symbol.for("lazers.scheduler.v3")] = { generation, loop, registry, activation waiters }
   location boots → acquireCore → register(projectKey, driver)   (release on core dispose)
   loop: claim leader → tickAt(now) → sleep min(next_due, 30s) | doorbell
   due row, no driver → connectedClient().location.get with x-opencode-directory = project root
                      → LAZERS activates → register() resolves the waiter → driver.fire(row)
 tasks.sqlite: lazers_schedule (rows mirror the native shape) + runner_leases (leader sentinel)
```

1. **Store.**
   - The table `lazers_schedule` mirrors the native columns and adds
     `project_directory`, `native_id` and an `action` column. An action is one
     of `{type:"prompt"}` or `{type:"runner.tick"}`.
   - Each project gets one `runner.tick` row.
   - Status and outcome changes go through an XState machine registered in
     `lifecycleMachines`. No SQL-only transitions.
   - The timing helpers are ported from the native code: `following`,
     `nextCron`, `firstDue` and `endsAt`.
2. **Persisted runtime delays.** Every delay the runtime takes today becomes
   an upsert that sets `next_due_at = min(existing, now + delay)` and rings the
   doorbell. The call sites are `wakeScheduler(...)` and `requestTick`
   (`src/runner/runtime.ts:849,7214-7306,8877,9060`).
3. **Global loop, keyed by build generation.**
   - When a new generation acquires the core, it stops the old loop, which
     releases leadership and clears the timer, and installs its own.
   - The loop needs no plugin `ctx`, so it outlives the last LAZERS location.
   - Timers target absolute `Date.now()` values, capped at 30 s.
   - The 30 s re-check is one indexed `SELECT min(next_due_at)`, and it runs
     only while active rows exist.
4. **Leader.**
   - A sentinel row in `runner_leases` (`project_directory='lazers:scheduler:leader'`)
     with a 30 s TTL, renewed every 10 s while ticking.
   - Per-project work stays fenced by the existing project lease.
5. **Cold wake.**
   - The loop calls `connectedClient().location.get()` with the project
     directory header. That boots the location without flagged APIs.
   - An activation waiter times out after 60 s, which records `failed` and
     retries after 5 minutes.
   - A missing directory pauses the row.
6. **Re-arm after a service restart.** Whenever any LAZERS location boots,
   the loop scans the due rows of every project, catches up the overdue ones
   and arms the timer. The table lists what triggers that first boot:

   | Rank | Path                                                                                          | Guarantee                                 |
   | ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
   | 1    | LAZERS Desktop main watches `serverEndpoints.get("sidecar")` and calls `lazers.scheduler/arm` | Yes, while the Desktop app runs           |
   | 2    | Desktop reconnect, which boots cwd `/Users/tjw` and reopens projects                          | Observed on every restart; not a contract |
   | 3    | Restart continuity resumes in-flight sessions                                                 | Only if a turn was in flight              |

   **Documented gap:** with a headless `opencode serve`, no client connected
   and no turn in flight, nothing re-arms until the first request. Every due
   row then catches up once, marked `late`. Diagnostics show the last fire
   time and the late counts, so the gap is visible rather than silent.

7. **Driving work.**
   - A `runner.tick` row calls `runtime.tick()` through the existing
     single-flight drain for its project.
   - A `prompt` row:
     1. ensures the location is loaded;
     2. creates its session if the row has none;
     3. prompts with `id` `msg_<lsch>_<run>` and `delivery:"steer"`, after the
        `pending` check;
     4. runs `rewake` when the process gains leadership;
     5. observes completion through `session.execution.*` and `session.idle`
        events, and reconciles with `session.get` on boot.
   - `session.wait` and the `experimental.idle` hook may be used, but nothing
     depends on them.
8. **Eviction.**
   - OpenCode already skips eviction while a session executes or a background
     job runs.
   - A tick that does git work with no session running may hold a short pin
     (a zero-tool client-MCP socket) for its duration. That needs a spike
     first; the fallback is ticks that can resume.
   - Never write `location_idle_timeout:false` into the user's config.

## Switching to the native Schedule later

- **One interface.** Both backends sit behind a `ScheduleBackend` interface
  shaped like the native one: `create`, `list`, `get`, `pause`, `resume`,
  `remove`, plus `runnerWake`.
- **Detection.** The native backend is available when `ctx.app.version` is
  2.3.0 or later and `experimental.schedule.list` succeeds rather than
  returning `ForbiddenError`. The answer is re-probed on `config.updated`.
- **Migration.**
  - Prompt rows move to `sch_` rows: record `native_id` and mark ours `done`.
  - Rows with a prompt still in flight stay on our backend until they settle.
  - Runner rows stay on ours until native supports actions other than prompts.
- **Deprecation.**
  1. Route new user schedules to the native backend.
  2. Migrate the existing ones.
  3. Delete ours once the native Schedule is unflagged and runner wakes have
     a native form.

## Deleted

- `PROJECT_RECONCILIATION_INTERVAL_MS`, `Participant.intervalMs` and the
  interval re-arm.
- In-memory-only delays.
- The generation-less `sharedScheduler`.

## Kept

- The per-project single-flight drain and the `runNow` waiters.
- `registry` and `CapabilityHub`.
- `runner_leases`.
- Event wakes through `core.wake()`.

## Spikes, deciding unknowns first

1. Does LAZERS activate in the cwd location `/Users/tjw` when the service starts?
2. Does `location.get` return before plugin activation finishes, and how long
   does activation take?
3. Does `serverEndpoints.get("sidecar")` change across a service restart, and
   can Desktop main observe the change?
4. Is `session.prompt` with an id that already exists idempotent?
5. Does a zero-tool client-MCP socket pin a location without adding agent
   tools, and does it survive close code 1012?
6. How do `setTimeout` and `Date.now()` behave across macOS sleep?
7. With two processes on one `tasks.sqlite`, does leadership hand off without
   a double fire?
8. After a lost-event window, does reconcile-on-reconnect finish the task?
9. What does the 30 s re-check cost compared with relying on the doorbell plus
   a drift check?

## Phases

| Phase | Scope                                                                                                      | Done when                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | Spikes 1–4                                                                                                 | Each answered with log evidence                                           |
| 1     | Table, migration, XState status machine, ported timing helpers with tests                                  | DST, phase-skip, `ends` and late cases pass                               |
| 2     | Generation-keyed global loop, leader sentinel, doorbell; delete the 5-minute interval and in-memory delays | Two-process test passes; one loop per generation                          |
| 3     | Cold wake and runner-row upserts                                                                           | An evicted project resumes queued work at its due time in Desktop         |
| 4     | Restart re-arm: scan all projects on boot, Desktop main booster                                            | After `opencode service restart`, overdue rows fire `late` within seconds |
| 5     | User scheduled tasks: tools, idempotent prompts, `pending` and `rewake`, completion                        | A task due at T runs once across a mid-run restart                        |
| 6     | `ScheduleBackend` interface, native detection, migration (dormant)                                         | The probe reports `native-disabled` on the 2.3.0 release build            |

Prerequisite: bump the pinned `@opencode/*` SDK from 2.2.5 to 2.3.0 first.
