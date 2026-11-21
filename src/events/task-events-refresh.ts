import type { Database } from "bun:sqlite"
import type { BackfillPhase, ProjectionSpec } from "../projections/owner.ts"
import { drainQueue, type QueueDrain } from "../projections/queue.ts"
import type { EffectRow } from "../runner/store.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import {
  effectEvents,
  transitionEvent,
  type CheckView,
  type EventAttempt,
  type TransitionRow,
} from "../trajectory/events.ts"

/**
 * Derivation of `task_events` rows (schema: `task-events-schema.ts`). Each refresh recomputes the
 * rows of one source row from the database as it is, with the functions the trajectory read uses
 * (`transitionEvent`, `effectEvents`, which applies `checkView`), so a stored row is what that read
 * shows. A source row that is gone, or that the read would not show, leaves no row.
 */
export const TASK_EVENTS = "task-events"
/** The derivation's generation: raise it when a row's content changes, and the backfill rewrites. */
const TASK_EVENTS_GENERATION = 1
const QUEUE = "task_events_dirty"

/**
 * Entries refreshed per drain call. A unit of work, not a cap: the rest stay queued for the owner.
 * Measured on the live-sized copy: 1,000 task-scoped transition inserts plus their drain took
 * 15 ms; a check refresh costs about 0.2 ms, so a full budget stays near 100 ms at worst.
 */
export const DRAIN_BUDGET = 500

type Row = {
  project_directory: string
  task_id: string
  plan_id: string | null
  attempt_id: string | null
  session_id: string | null
  at: number | null
  /** A check's receipt interval (`check.startedAt`/`check.endedAt`); NULL for every other kind. */
  started_at: number | null
  ended_at: number | null
  /** The old event id: the trajectory read's tie-break. */
  sort_key: string
  kind: "transition" | "effect" | "check" | "progress"
  origin: string
  event: string | null
  from_state: string | null
  to_state: string | null
  status: string | null
  tool: string | null
  title: string | null
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
  detail: string | null
  /** A transition's own payload text, unchanged; NULL for every other kind. */
  payload: string | null
}

const COLUMNS = [
  "project_directory",
  "task_id",
  "plan_id",
  "attempt_id",
  "session_id",
  "at",
  "sort_at",
  "sort_key",
  "started_at",
  "ended_at",
  "kind",
  "origin",
  "event",
  "from_state",
  "to_state",
  "status",
  "tool",
  "title",
  "route_provider",
  "route_model",
  "route_variant",
  "detail",
  "payload",
] as const
const UPDATED = COLUMNS.filter((column) => column !== "origin")
/** Writes only a row that differs: a refresh that changes nothing changes no page and wakes no stream. */
const UPSERT = `INSERT INTO task_events(${COLUMNS.join(",")}) VALUES(${COLUMNS.map(() => "?").join(",")})
  ON CONFLICT(origin) DO UPDATE SET ${UPDATED.map((column) => `${column}=excluded.${column}`).join(",")}
  WHERE ${UPDATED.map((column) => `task_events.${column} IS NOT excluded.${column}`).join(" OR ")}`

/** Upsert by origin: the row keeps its id (a stream updates it in place); unchanged rows are not written. */
/** Where the trajectory read puts an event with no time: after every timed one. */
const UNTIMED = Number.MAX_SAFE_INTEGER

function write(db: Database, row: Row) {
  db.query(UPSERT).run(
    row.project_directory,
    row.task_id,
    row.plan_id,
    row.attempt_id,
    row.session_id,
    row.at,
    row.at ?? UNTIMED,
    row.sort_key,
    row.started_at,
    row.ended_at,
    row.kind,
    row.origin,
    row.event,
    row.from_state,
    row.to_state,
    row.status,
    row.tool,
    row.title,
    row.route_provider,
    row.route_model,
    row.route_variant,
    row.detail,
    row.payload,
  )
}

const empty = {
  started_at: null,
  ended_at: null,
  status: null,
  tool: null,
  title: null,
  route_provider: null,
  route_model: null,
  route_variant: null,
  payload: null,
}
const str = (value: unknown) => (typeof value === "string" ? value : null)
const num = (value: unknown) => (typeof value === "number" ? value : null)

const planProject = (db: Database, plan: string) =>
  db
    .query<{ project_directory: string }, [string]>(
      "SELECT project_directory FROM runner_plans WHERE id=?",
    )
    .get(plan)?.project_directory

/** The trajectory read shows a plan's events in a task only while the plan holds the task's node. */
const holdsNode = (db: Database, plan: string, task: string) =>
  db.query("SELECT 1 FROM runner_nodes WHERE plan_id=? AND task_id=?").get(plan, task) !== null

/** An attempt of `task` in a plan of `project`: the attempts the trajectory read resolves against. */
function attemptOf(db: Database, id: string, task: string, project: string) {
  return (
    db
      .query<EventAttempt, [string, string, string]>(
        `SELECT a.id,a.session_id,a.started_at FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
         WHERE a.id=? AND a.task_id=? AND p.project_directory=?`,
      )
      .get(id, task, project) ?? undefined
  )
}

function refreshTransition(db: Database, id: number) {
  const origin = `tr:${id}`
  const row = db
    .query<TransitionRow, [number]>(
      "SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions WHERE id=?",
    )
    .get(id)
  const project = row?.task_id ? planProject(db, row.plan_id) : undefined
  if (!row?.task_id || project === undefined || !holdsNode(db, row.plan_id, row.task_id)) {
    db.query("DELETE FROM task_events WHERE origin=?").run(origin)
    return
  }
  const attempts = new Map<string, EventAttempt>()
  const requested = attemptRequested(row.payload)
  const attempt = requested ? attemptOf(db, requested, row.task_id, project) : undefined
  if (attempt) attempts.set(attempt.id, attempt)
  const event = transitionEvent(row, attempts, privacyStats())
  write(db, {
    ...empty,
    project_directory: project,
    task_id: row.task_id,
    plan_id: row.plan_id,
    attempt_id: event.attemptID,
    session_id: event.sessionID,
    at: event.at,
    sort_key: event.id,
    kind: "transition",
    origin,
    event: event.event,
    from_state: str(event.from),
    to_state: str(event.to),
    detail: JSON.stringify({ event }),
    payload: row.payload,
  })
}

function attemptRequested(payload: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload)
    const id = (parsed as { attemptID?: unknown } | null)?.attemptID
    return typeof id === "string" ? id : undefined
  } catch {
    return undefined
  }
}

/** Nodes read per statement while listing a plan's tasks; a unit of work, the loop reads them all. */
const NODE_PAGE = 200

/** Every task of a plan, in node order, a page at a time. */
function planTasks(db: Database, plan: string): string[] {
  const tasks: string[] = []
  const page = db.query<{ task_id: string }, [string, string, number]>(
    "SELECT task_id FROM runner_nodes WHERE plan_id=? AND task_id>? ORDER BY task_id LIMIT ?",
  )
  for (;;) {
    const rows = page.all(plan, tasks.at(-1) ?? "", NODE_PAGE)
    tasks.push(...rows.map((row) => row.task_id))
    if (rows.length < NODE_PAGE) return tasks
  }
}

/** Origins of one effect's rows: `ef:<id>` for a task's effect, `ef:<id>@<task>` per plan task. */
const fanOrigin = (id: string, task: string) => `ef:${id}@${task}`

function refreshEffect(db: Database, id: string) {
  const effect = db
    .query<EffectRow, [string]>(
      "SELECT id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence FROM runner_effects WHERE id=?",
    )
    .get(id)
  const project = effect ? planProject(db, effect.plan_id) : undefined
  const written: string[] = []
  // A task's effect, or a plan's (no task, no attempt); an attempt-only effect is not shown.
  if (effect && project !== undefined && (effect.task_id || !effect.attempt_id)) {
    const tasks = effect.task_id
      ? holdsNode(db, effect.plan_id, effect.task_id)
        ? [effect.task_id]
        : []
      : planTasks(db, effect.plan_id)
    for (const task of tasks) {
      const attempts = new Map<string, EventAttempt>()
      const attempt = effect.attempt_id
        ? attemptOf(db, effect.attempt_id, task, project)
        : undefined
      if (attempt) attempts.set(attempt.id, attempt)
      const checks: CheckView[] = []
      const [event] = effectEvents([effect], attempts, checks, privacyStats())
      const check = checks[0]
      const origin = effect.task_id ? `ef:${effect.id}` : fanOrigin(effect.id, task)
      write(db, {
        ...empty,
        project_directory: project,
        task_id: task,
        plan_id: effect.plan_id,
        attempt_id: str(event!.attemptID),
        session_id: str(event!.sessionID),
        at: num(event!.at),
        sort_key: String(event!.id),
        kind: check ? "check" : "effect",
        origin,
        event: check ? check.id : str(event!.effect),
        from_state: null,
        to_state: str(event!.state),
        status: check ? check.result : null,
        started_at: check ? check.startedAt : null,
        ended_at: check ? check.endedAt : null,
        detail: JSON.stringify(check ? { event, check } : { event }),
      })
      written.push(origin)
    }
  }
  // Rows this effect no longer has: gone, moved, or a plan task that left the plan.
  db.query(
    `DELETE FROM task_events WHERE (origin=? OR (origin>? AND origin<?))
       AND origin NOT IN (SELECT value FROM json_each(?))`,
  ).run(`ef:${id}`, `ef:${id}@`, `ef:${id}A`, JSON.stringify(written))
}

type DisplayColumns = {
  project_directory: string
  attempt_id: string
  session_id: string
  at: number
  kind: string
  tool: string | null
  status: string | null
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
}

/**
 * A progress row of a task's attempt, mirrored from its stored display (`runner_progress_display`,
 * already sanitized and truncated by `progressDisplay`): no payload is read or parsed. Only what a
 * timeline lists and filters is copied; the rest (source, message and call ids, agent, result,
 * error, file targets, observations) stays in the display row, which `pg:<seq>` names and
 * `observability.liveHistory` reads (19.6 MB not duplicated on the live-sized copy).
 */
function refreshProgress(db: Database, seq: number) {
  const origin = `pg:${seq}`
  const display = db
    .query<DisplayColumns, [number]>(
      `SELECT project_directory,attempt_id,session_id,at,kind,tool,status,route_provider,route_model,
         route_variant FROM runner_progress_display WHERE seq=?`,
    )
    .get(seq)
  const attempt = display
    ? db
        .query<{ task_id: string; plan_id: string }, [string]>(
          "SELECT task_id,plan_id FROM runner_attempts WHERE id=?",
        )
        .get(display.attempt_id)
    : null
  if (!display || !attempt) {
    db.query("DELETE FROM task_events WHERE origin=?").run(origin)
    return
  }
  write(db, {
    project_directory: display.project_directory,
    task_id: attempt.task_id,
    plan_id: attempt.plan_id,
    attempt_id: display.attempt_id,
    session_id: display.session_id,
    at: display.at,
    sort_key: `progress:${seq}`,
    started_at: null,
    ended_at: null,
    kind: "progress",
    origin,
    event: display.kind,
    from_state: null,
    to_state: null,
    status: display.status,
    tool: display.tool,
    title: null,
    route_provider: display.route_provider,
    route_model: display.route_model,
    route_variant: display.route_variant,
    // The display row (`pg:<seq>`) holds source, ids, agent, result and error: not copied.
    detail: null,
    payload: null,
  })
}

/** Refresh the rows of one queued source key. Unknown refs (a newer copy's kind) are dropped. */
function refreshTaskEvent(db: Database, ref: string) {
  if (ref.startsWith("tr:")) refreshTransition(db, Number(ref.slice(3)))
  else if (ref.startsWith("ef:")) refreshEffect(db, ref.slice(3))
  else if (ref.startsWith("pg:")) refreshProgress(db, Number(ref.slice(3)))
}

export function drainTaskEvents(db: Database, budget = DRAIN_BUDGET): QueueDrain {
  return drainQueue(db, QUEUE, refreshTaskEvent, { budget })
}

/**
 * Transition ids read per backfill page. A unit of work: the page walks an id range (no plan
 * filter, so no history index is needed) and refreshes the task-scoped rows in it (about 2% of
 * ids). Measured on the live-sized copy (418,709 ids, 9,510 task-scoped): 222 pages, median
 * 1.9 ms, slowest 32 ms.
 */
const TRANSITION_PAGE_IDS = 2_000
/**
 * Effects per backfill page; each may fan out to its plan's tasks. A check's receipt (stdout,
 * stderr) is sanitized at write: measured 0.21 ms per effect on the live-sized copy (2,628
 * effects); pages of 100 measured median 13 ms, slowest 34 to 58 ms (receipts vary in size), so a
 * page holds 50.
 */
const EFFECT_PAGE_ROWS = 50

const transitions: BackfillPhase = {
  name: "transitions",
  page(db, _scope, after) {
    const end = after + TRANSITION_PAGE_IDS
    const ids = db
      .query<{ id: number }, [number, number, number]>(
        "SELECT id FROM runner_transitions WHERE id>? AND id<=? AND task_id IS NOT NULL ORDER BY id LIMIT ?",
      )
      .all(after, end, TRANSITION_PAGE_IDS)
    for (const { id } of ids) refreshTransition(db, id)
    const last =
      db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM runner_transitions").get()
        ?.id ?? 0
    return { next: end, done: end >= last }
  },
}

const effects: BackfillPhase = {
  name: "effects",
  page(db, _scope, after) {
    const rows = db
      .query<{ rowid: number; id: string }, [number, number]>(
        "SELECT rowid,id FROM runner_effects WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(after, EFFECT_PAGE_ROWS)
    for (const row of rows) refreshEffect(db, row.id)
    return { next: rows.at(-1)?.rowid ?? after, done: rows.length < EFFECT_PAGE_ROWS }
  },
}

/**
 * Display rows per backfill page. Measured on the live-sized copy (79,423 rows) at 500 per page:
 * 159 pages, median 6 ms, slowest 26 to 47 ms over two runs; 250 keeps the slowest page well under
 * 50 ms.
 */
export const PROGRESS_PAGE_ROWS = 250

const progress: BackfillPhase = {
  name: "progress",
  page(db, _scope, after) {
    const rows = db
      .query<{ seq: number }, [number, number]>(
        "SELECT seq FROM runner_progress_display WHERE seq>? ORDER BY seq LIMIT ?",
      )
      .all(after, PROGRESS_PAGE_ROWS)
    for (const { seq } of rows) refreshProgress(db, seq)
    return { next: rows.at(-1)?.seq ?? after, done: rows.length < PROGRESS_PAGE_ROWS }
  },
}

export const taskEventsProjection: ProjectionSpec = {
  name: TASK_EVENTS,
  generation: TASK_EVENTS_GENERATION,
  backfill: [transitions, effects, progress],
  queue: { table: QUEUE, drain: (db) => drainTaskEvents(db) },
}
