import type { Database } from "bun:sqlite"
import { planPrioritySortSQL } from "../../runner/priority.ts"
import { reservationPatterns } from "../../runner/scope.ts"
import { PlanInput } from "../../runner/schema.ts"
import type { DispatchPause } from "../../runner/schema.ts"
import { outerPauseIn, outerPauseReason } from "../../projects/pause.ts"
import { canStruggle, readTrajectoryFacts } from "../../recovery/trajectory-facts.ts"
import { isTakeoverAttempt, openConcerns } from "../../recovery/detector.ts"
import { TaskSpecSchema } from "../../task.ts"
import { taskClassificationFor } from "../classification.ts"
import { taskTitle } from "../presentation.ts"
import { bucketOf, encodeSortKey, ownerHoldOf, priorityKeyOf, rankOf } from "./key.ts"
import { effectiveStatus, reservationFingerprint } from "./status.ts"
import type { PlanWait, Reservation } from "./status.ts"
import type { DirtyKind } from "./schema.ts"

/**
 * Re-derive stored rows from the source tables. Every function runs inside the caller's write
 * transaction and reads current rows, so a refresh is never older than the write that queued it,
 * and an unchanged row costs no write. They return whether any stored row changed, so a change
 * can cascade to the plans that list this one as a prerequisite.
 */
export type RefreshContext = {
  /** Active reservations per project, read once per drain: nothing writes sources meanwhile. */
  reservations: Map<string, Reservation[]>
  plans: Map<string, PlanFacts | null>
  enqueue(kind: DirtyKind, ref: string): void
}

const TERMINAL = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])
const INTEGRATED_PLAN = new Set(["cleaning", "cleanup-blocked", "integrated"])

type PlanRowFacts = {
  id: string
  rowid: number
  project_directory: string
  owner: string
  revision: number
  version: number
  state: string
  body: string
  reason: string | null
}

export type PlanFacts = PlanRowFacts & {
  title: string
  priority: number
  mode: "shared" | "isolated" | undefined
  afterPlans: string[]
  own: DispatchPause | undefined
}

function planFacts(db: Database, ctx: RefreshContext, planID: string): PlanFacts | null {
  const cached = ctx.plans.get(planID)
  if (cached !== undefined) return cached
  const row = db
    .query<PlanRowFacts, [string]>(
      "SELECT rowid,id,project_directory,owner,revision,version,state,body,reason FROM runner_plans WHERE id=?",
    )
    .get(planID)
  let facts: PlanFacts | null = null
  if (row) {
    let raw: { title?: unknown; objective?: unknown; priority?: unknown } = {}
    let parsed: ReturnType<typeof PlanInput.safeParse> | undefined
    try {
      const json = JSON.parse(row.body)
      raw = json && typeof json === "object" ? json : {}
      parsed = PlanInput.safeParse(json)
    } catch {
      parsed = undefined
    }
    const control = db
      .query<{ reason: string; until_plans: string }, [string]>(
        "SELECT reason,until_plans FROM runner_dispatch_controls WHERE plan_id=? AND state='paused'",
      )
      .get(planID)
    facts = {
      ...row,
      title: String(raw.title ?? raw.objective ?? "").slice(0, 120),
      priority: typeof raw.priority === "number" ? raw.priority : 0,
      mode: parsed?.success ? parsed.data.workspaceMode : undefined,
      afterPlans: parsed?.success ? [...new Set(parsed.data.afterPlans ?? [])] : [],
      own: control
        ? { reason: control.reason, untilPlans: JSON.parse(control.until_plans) as string[] }
        : undefined,
    }
  }
  ctx.plans.set(planID, facts)
  return facts
}

const pauseOf = (db: Database, plan: PlanFacts): DispatchPause | undefined => {
  const outer = outerPauseIn(db, plan.project_directory)
  return outer ? { reason: outerPauseReason(outer), untilPlans: [], level: outer.level } : plan.own
}

const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value)

/** Active reservations of a project: `RunnerStore.dispatchReservations()` over stored rows. */
export function activeReservations(
  db: Database,
  ctx: RefreshContext,
  project: string,
): Reservation[] {
  const cached = ctx.reservations.get(project)
  if (cached) return cached
  const attempts = db
    .query<{ task_id: string; workspace: string }, [string]>(
      `SELECT a.task_id,a.workspace FROM runner_attempts a JOIN runner_plans p ON a.plan_id=p.id
       WHERE a.project_directory=? AND a.state IN ('preparing','running','verifying')
       ORDER BY ${planPrioritySortSQL("p.body")},p.rowid,a.started_at,a.number`,
    )
    .all(project)
  const adoptions = db
    .query<{ task_id: string }, [string]>(
      `SELECT a.task_id FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
       WHERE p.project_directory=? AND a.state IN ('pending','task-checks','combined-checks')
       ORDER BY a.created_at,a.id`,
    )
    .all(project)
  const set = [
    ...attempts.map((attempt) => ({
      taskID: attempt.task_id,
      shared: attempt.workspace === project,
      scopes: reservationScope(db, attempt.task_id),
    })),
    ...adoptions.map((adoption) => ({
      taskID: adoption.task_id,
      shared: false,
      scopes: reservationScope(db, adoption.task_id),
    })),
  ]
  ctx.reservations.set(project, set)
  return set
}

/** `RunnerStore.effectiveReservationScope`: edit and create scope plus the newest amendment. */
export function reservationScope(db: Database, taskID: string): string[] {
  const row = db
    .query<{ write_scope: string | null; create_scope: string | null }, [string]>(
      `SELECT json_extract(body,'$.proposal.writeScope') AS write_scope,
              json_extract(body,'$.proposal.createScope') AS create_scope
       FROM tasks WHERE id=?`,
    )
    .get(taskID)
  const write: string[] = row?.write_scope ? JSON.parse(row.write_scope) : []
  const create: { path: string }[] = row?.create_scope ? JSON.parse(row.create_scope) : []
  const amendment = db
    .query<{ payload: string }, [string]>(
      `SELECT t.payload FROM runner_transitions t JOIN runner_nodes n
         ON n.plan_id=t.plan_id AND n.task_id=t.task_id
       WHERE n.task_id=? AND t.event='SCOPE_AMENDED' ORDER BY t.id DESC LIMIT 1`,
    )
    .get(taskID)
  const amended: string[] = amendment ? (JSON.parse(amendment.payload).writeScope ?? []) : []
  return reservationPatterns([...new Set([...write, ...amended])], create)
}

type StoredRow = Record<string, string | number | null>

function upsert(db: Database, table: string, key: string, row: StoredRow): boolean {
  const previous = db
    .query<StoredRow, [string | number]>(`SELECT * FROM ${table} WHERE ${key}=?`)
    .get(row[key] as string | number)
  if (previous && Object.keys(row).every((column) => previous[column] === row[column])) return false
  const columns = Object.keys(row)
  db.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
     ON CONFLICT(${key}) DO UPDATE SET ${columns.map((column) => `${column}=excluded.${column}`).join(",")}`,
  ).run(...(columns.map((column) => row[column]) as (string | number | null)[]))
  return true
}

/** Replace the rows of `table` for `owner` with `rows` when they differ; returns whether they did. */
function replaceChildren(
  db: Database,
  table: string,
  ownerColumn: string,
  owner: string,
  rows: readonly StoredRow[],
): boolean {
  const columns = rows.length ? Object.keys(rows[0]!) : []
  const existing = db
    .query<StoredRow, [string]>(`SELECT * FROM ${table} WHERE ${ownerColumn}=?`)
    .all(owner)
  const sameShape =
    existing.length === rows.length &&
    rows.every((row) =>
      existing.some((old) => columns.every((column) => old[column] === row[column])),
    )
  if (sameShape) return false
  db.query(`DELETE FROM ${table} WHERE ${ownerColumn}=?`).run(owner)
  for (const row of rows) {
    const names = Object.keys(row)
    db.query(
      `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
    ).run(...(names.map((name) => row[name]) as (string | number | null)[]))
  }
  return true
}

function adjustCount(db: Database, project: string, bucket: string, delta: number) {
  db.query(
    `INSERT INTO task_schedule_counts(project_directory,bucket,n) VALUES(?,?,?)
     ON CONFLICT(project_directory,bucket) DO UPDATE SET n=n+excluded.n`,
  ).run(project, bucket, delta)
}

const objectiveOf = (db: Database, taskID: string) =>
  db
    .query<{ o: string | null }, [string]>(
      "SELECT json_extract(body,'$.proposal.objective') AS o FROM tasks WHERE id=?",
    )
    .get(taskID)?.o ?? ""

const referenceOf = (db: Database, taskID: string) =>
  db
    .query<{ reference: string }, [string]>("SELECT reference FROM task_references WHERE task_id=?")
    .get(taskID)?.reference

const NODE_PLAN_SQL = `SELECT n.plan_id,n.ordinal,n.state,n.reason,p.rowid AS plan_rowid
  FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
  WHERE p.project_directory=? AND n.task_id=? ORDER BY p.rowid DESC LIMIT 1`

/**
 * The one task row, its edges, blockers, waits, sessions and scopes. A task with several plans
 * (impossible through the writers, `UNIQUE(task_id, spec_revision)` with revision 1) shows its
 * newest plan by rowid, as `currentActivityTargets` and `tasks.list` did.
 */
export function refreshTask(db: Database, ctx: RefreshContext, taskID: string): boolean {
  const record = db
    .query<
      { id: string; project_directory: string; body: string; created_version: number },
      [string]
    >("SELECT id,project_directory,body,created_version FROM tasks WHERE id=?")
    .get(taskID)
  if (!record) return false
  const project = record.project_directory
  const reference = referenceOf(db, taskID)
  if (!reference) return false
  const task = TaskSpecSchema.parse(JSON.parse(record.body))
  const old = db
    .query<StoredRow, [string]>("SELECT * FROM task_schedule WHERE task_id=?")
    .get(taskID)
  const placement = db
    .query<
      {
        plan_id: string
        ordinal: number
        state: string
        reason: string | null
        plan_rowid: number
      },
      [string, string]
    >(NODE_PLAN_SQL)
    .get(project, taskID)
  const plan = placement ? planFacts(db, ctx, placement.plan_id) : null

  // Prerequisites, held-back reasons and reservations.
  const adoption = placement
    ? db
        .query<{ id: string; hold_reason: string | null }, [string, string]>(
          `SELECT id,hold_reason FROM runner_adoptions WHERE plan_id=? AND task_id=?
           AND state IN ('pending','task-checks','combined-checks') ORDER BY created_at DESC LIMIT 1`,
        )
        .get(placement.plan_id, taskID)
    : null
  const waitingOn = placement
    ? db
        .query<{ prerequisite: string }, [string, string]>(
          `SELECT d.prerequisite FROM runner_dependencies d
           JOIN runner_nodes n ON n.plan_id=d.plan_id AND n.task_id=d.prerequisite
           WHERE d.plan_id=? AND d.successor=? AND (n.state!='accepted' OR EXISTS(
             SELECT 1 FROM runner_adoptions a WHERE a.plan_id=n.plan_id AND a.task_id=n.task_id
               AND a.state IN ('pending','task-checks','combined-checks')
           ) OR NOT EXISTS(
             SELECT 1 FROM runner_transitions ti
             WHERE ti.plan_id=d.plan_id AND ti.task_id=d.prerequisite
               AND ti.event='TASK_INTEGRATION_RECORDED' AND json_valid(ti.payload)
               AND json_extract(ti.payload,'$.artifact')=n.artifact
           ))`,
        )
        .all(placement.plan_id, taskID)
        .map((r) => r.prerequisite)
    : []
  const waits: PlanWait[] = []
  if (plan)
    for (const id of plan.afterPlans) {
      const required = db
        .query<
          { state: string; version: number | null; reason: string | null; body: string },
          [string, string]
        >("SELECT state,version,reason,body FROM runner_plans WHERE project_directory=? AND id=?")
        .get(project, id)
      if (required && INTEGRATED_PLAN.has(required.state)) continue
      let title: string | null = null
      if (required)
        try {
          const raw = JSON.parse(required.body)
          title = String(raw.title ?? raw.objective ?? "").slice(0, 120) || null
        } catch {
          title = null
        }
      waits.push({
        planID: id,
        title,
        state: required?.state.slice(0, 80) ?? null,
        version: required?.version ?? null,
        reason: required?.reason?.slice(0, 400) ?? null,
      })
    }
  const pause = plan ? pauseOf(db, plan) : undefined
  const reserving = Boolean(
    placement && plan?.state === "running" && ["queued", "ready"].includes(placement.state),
  )
  const references = new Map<string, string>()
  const status = placement
    ? effectiveStatus({
        node: { state: placement.state, reason: placement.reason },
        plan: { state: plan!.state, reason: plan!.reason },
        adoption: adoption ? { id: adoption.id, holdReason: adoption.hold_reason } : null,
        waitingOn,
        waits,
        pause,
        planMode: plan!.mode,
        scope: reserving ? reservationScope(db, taskID) : [],
        reservations: reserving ? activeReservations(db, ctx, project) : [],
        reference: (id) => {
          const known = references.get(id) ?? referenceOf(db, id) ?? id
          references.set(id, known)
          return known
        },
      })
    : {
        status: task.status as string,
        reason: null,
        blockers: [] as string[],
        dispatchPause: undefined,
      }

  const disposition = db
    .query<Record<string, string | number>, [string, string]>(
      `SELECT id,task_id,request_id,disposition,reason,evidence,related_task_ids,session_id,agent,created_at
       FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(project, taskID)
  const displayReason = status.reason ?? (disposition ? String(disposition.reason) : null)

  // Finish time: incremental from the newest transition already folded for this node.
  const rank = rankOf({ nodeState: placement?.state ?? null, planState: plan?.state ?? null })
  const mark = placement
    ? (db
        .query<{ id: number | null }, [string, string]>(
          "SELECT MAX(id) AS id FROM runner_transitions WHERE plan_id=? AND task_id=?",
        )
        .get(placement.plan_id, taskID)?.id ?? 0)
    : 0
  let finishedAt = 0
  let basis: string | null = null
  if (placement && rank >= 2) {
    const unchanged =
      old != null &&
      old.node_state === placement.state &&
      old.plan_id === placement.plan_id &&
      old.finished_basis === "node"
    // Only transitions newer than the last fold can raise the finish time.
    const found = db
      .query<{ at: number | null }, [string, string, number, string]>(
        `SELECT MAX(created_at) AS at FROM runner_transitions
         WHERE plan_id=? AND task_id=? AND id>? AND json_extract(payload,'$.to')=?`,
      )
      .get(
        placement.plan_id,
        taskID,
        unchanged ? Number(old.transition_mark) : 0,
        placement.state,
      )?.at
    if (unchanged || found != null) {
      finishedAt = Math.max(unchanged ? (old.finished_at as number) : 0, found ?? 0)
      basis = "node"
    } else {
      finishedAt =
        db
          .query<{ at: number }, [string]>(
            "SELECT created_at AS at FROM runner_transitions WHERE plan_id=? ORDER BY id DESC LIMIT 1",
          )
          .get(placement.plan_id)?.at ?? 0
      basis = "plan"
    }
  }
  const paused = Boolean(status.dispatchPause)
  const bucket = bucketOf({
    nodeState: placement?.state ?? null,
    planState: plan?.state ?? null,
    status: status.status,
    paused,
  })
  const sortKey = encodeSortKey({
    planID: placement?.plan_id ?? null,
    nodeState: placement?.state ?? null,
    planState: plan?.state ?? null,
    priority: plan?.priority ?? null,
    planSeq: placement?.plan_rowid ?? null,
    ordinal: placement?.ordinal ?? null,
    seq: record.created_version,
    finishedAt,
  })

  // Attempt-derived flags, only while the task can still struggle.
  const struggling = placement ? canStruggle(status.status) : false
  const latest = placement
    ? db
        .query<{ started_at: number; policy: string }, [string, string]>(
          `SELECT started_at,policy FROM runner_attempts WHERE plan_id=? AND task_id=?
           ORDER BY number DESC,started_at DESC LIMIT 1`,
        )
        .get(placement.plan_id, taskID)
    : undefined
  const startedAt =
    placement &&
    status.status === "running" &&
    !["blocked", "cancelled"].includes(plan?.state ?? "") &&
    !status.dispatchPause
      ? (latest?.started_at ?? null)
      : null
  const open = struggling ? openConcerns(db, project, { taskID }) : []
  const concernVersion = open.length ? Math.max(...open.map((item) => item.version)) : null
  let totals: string | null = null
  if (open.length && placement) {
    // Frozen at the latest concern version: read once, kept until the version moves.
    totals =
      old && old.concern_version === concernVersion && old.concern_totals
        ? (old.concern_totals as string)
        : JSON.stringify(
            (({ attempts, verifyRounds, attemptMs, tokens, toolCalls, costUSD }) => ({
              attempts,
              verifyRounds,
              attemptMs,
              tokens,
              toolCalls,
              costUSD,
            }))(readTrajectoryFacts(db, placement.plan_id, taskID, Date.now())),
          )
  }

  // Edges: same-plan prerequisites first, then every node of each prerequisite plan.
  const edges: StoredRow[] = []
  if (placement && plan) {
    const seen = new Set<string>()
    const add = (edge: Omit<StoredRow, "parent_task_id" | "ord">) => {
      const id = edge.child_task_id as string
      const at = edges.findIndex((e) => e.child_task_id === id)
      if (at >= 0) edges[at] = { ...edges[at]!, ...edge }
      else edges.push({ parent_task_id: taskID, ord: edges.length, ...edge })
      seen.add(id)
    }
    for (const dep of db
      .query<{ prerequisite: string; state: string }, [string, string]>(
        `SELECT d.prerequisite,n.state FROM runner_dependencies d
         JOIN runner_nodes n ON n.plan_id=d.plan_id AND n.task_id=d.prerequisite
         WHERE d.plan_id=? AND d.successor=? ORDER BY d.rowid`,
      )
      .all(placement.plan_id, taskID))
      add({
        child_task_id: dep.prerequisite,
        kind: "plan",
        child_reference: referenceOf(db, dep.prerequisite) ?? null,
        child_title: objectiveOf(db, dep.prerequisite).slice(0, 400),
        child_state: dep.state,
        waiting: waitingOn.includes(dep.prerequisite) || dep.state !== "accepted" ? 1 : 0,
        child_plan_id: placement.plan_id,
      })
    const untilPlans = plan.own?.untilPlans ?? []
    for (const id of new Set([...plan.afterPlans, ...untilPlans])) {
      const prior = db
        .query<{ id: string; state: string }, [string, string]>(
          "SELECT id,state FROM runner_plans WHERE project_directory=? AND id=?",
        )
        .get(project, id)
      if (!prior) continue
      const integrated = ["integrated", "cleaning", "cleanup-blocked"].includes(prior.state)
      for (const candidate of db
        .query<{ task_id: string; state: string }, [string]>(
          "SELECT task_id,state FROM runner_nodes WHERE plan_id=? ORDER BY ordinal",
        )
        .all(prior.id))
        add({
          child_task_id: candidate.task_id,
          kind: "after-plan",
          child_reference: referenceOf(db, candidate.task_id) ?? null,
          child_title: objectiveOf(db, candidate.task_id).slice(0, 400),
          child_state: integrated
            ? "integrated"
            : candidate.state === "accepted" && ["accepted", "running"].includes(prior.state)
              ? "awaiting integration"
              : prior.state === "running"
                ? candidate.state
                : prior.state,
          waiting: integrated ? 0 : 1,
          child_plan_id: prior.id,
        })
    }
  }
  const edgesChanged = replaceChildren(db, "task_schedule_edges", "parent_task_id", taskID, edges)
  const blockersChanged = replaceChildren(
    db,
    "task_schedule_blockers",
    "task_id",
    taskID,
    status.blockers.map((blocker) => ({ task_id: taskID, blocker_task_id: blocker })),
  )
  const waitsChanged = replaceChildren(
    db,
    "task_schedule_waits",
    "task_id",
    taskID,
    waits.map((wait, ord) => ({
      task_id: taskID,
      ord,
      plan_id: wait.planID,
      title: wait.title,
      state: wait.state,
      version: wait.version,
      reason: wait.reason,
    })),
  )

  // Sessions and scopes.
  const sessions = new Map<string, StoredRow>()
  const addSession = (session: string, role: string) =>
    sessions.set(`${session}\0${role}`, { session_id: session, task_id: taskID, role })
  addSession(task.provenance.sessionID, "creator")
  for (const owner of db
    .query<{ owner: string }, [string, string]>(
      `SELECT p.owner FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
       WHERE n.task_id=? AND p.project_directory=?`,
    )
    .all(taskID, project))
    addSession(owner.owner, "owner")
  for (const attempt of db
    .query<{ session_id: string }, [string]>(
      "SELECT DISTINCT session_id FROM runner_attempts WHERE task_id=?",
    )
    .all(taskID))
    addSession(attempt.session_id, "attempt")
  const sessionsChanged = replaceChildren(db, "task_schedule_sessions", "task_id", taskID, [
    ...sessions.values(),
  ])
  const scopes = [...new Set(task.proposal.writeScope)].map((path) => ({ task_id: taskID, path }))
  replaceChildren(db, "task_schedule_scopes", "task_id", taskID, scopes)

  const searchText = [
    task.id,
    reference,
    task.proposal.objective,
    task.proposal.writeScope.join("\n"),
    task.proposal.acceptance.map((item) => item.assertion).join("\n"),
    task.proposal.context.map((item) => item.reference).join("\n"),
  ]
    .join("\n")
    .toLowerCase()

  const observation = placement
    ? db
        .query<{ payload: string }, [string, string]>(
          `SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id=?
           AND event='PREREQUISITE_OBSERVED' ORDER BY id DESC LIMIT 1`,
        )
        .get(placement.plan_id, taskID)
    : undefined
  let decision = "not-applicable"
  let decisionReason: string | null = null
  if (placement && ["queued", "ready"].includes(placement.state)) {
    if (status.status === "blocked" || status.dispatchPause) {
      decision = "waiting"
      decisionReason = status.reason ?? status.dispatchPause?.reason ?? null
    } else if (waitingOn.length) {
      decision = "waiting"
      decisionReason = "Waiting for prerequisite tasks to be accepted and integrated."
    } else {
      // The dispatcher's newest proof of the git side; with none recorded the database facts
      // (no unmet prerequisite, no hold) stand and dispatch confirms at its next tick.
      const seen = observation
        ? (JSON.parse(observation.payload) as { decision?: string; reason?: string | null })
        : undefined
      decision = seen?.decision === "waiting" ? "waiting" : "eligible"
      decisionReason = seen?.decision === "waiting" ? (seen.reason ?? null) : null
    }
  }

  const row: StoredRow = {
    seq: record.created_version,
    task_id: taskID,
    project_directory: project,
    reference,
    revision: task.revision,
    created_at: task.createdAt,
    session_id: task.provenance.sessionID,
    title: taskTitle(task.proposal.objective),
    objective: task.proposal.objective.slice(0, 400),
    classification: JSON.stringify(taskClassificationFor(db, project, task).current),
    source_plan: json(task.proposal.sourcePlan),
    search_text: searchText,
    stale: 0,
    retired: disposition ? 1 : 0,
    disposition: disposition
      ? JSON.stringify({
          id: disposition.id,
          taskID: disposition.task_id,
          requestID: disposition.request_id,
          disposition: disposition.disposition,
          reason: disposition.reason,
          evidence: JSON.parse(String(disposition.evidence)),
          relatedTaskIDs: JSON.parse(String(disposition.related_task_ids)),
          sessionID: disposition.session_id,
          agent: disposition.agent,
          createdAt: disposition.created_at,
        })
      : null,
    plan_id: placement?.plan_id ?? null,
    plan_seq: placement?.plan_rowid ?? null,
    ordinal: placement?.ordinal ?? null,
    node_state: placement?.state ?? null,
    plan_state: plan?.state ?? null,
    rank,
    bucket,
    owner_hold: ownerHoldOf({
      nodeState: placement?.state ?? null,
      planState: plan?.state ?? null,
    })
      ? 1
      : 0,
    priority_key: priorityKeyOf(plan?.priority),
    finished_at: finishedAt,
    finished_basis: basis,
    transition_mark: mark,
    sort_key: sortKey,
    status: status.status,
    reason: displayReason,
    node_reason: placement?.reason ?? null,
    plan_reason: plan?.reason ?? null,
    started_at: startedAt,
    takeover: struggling && latest && isTakeoverAttempt(latest.policy) ? 1 : 0,
    concern: open.length
      ? JSON.stringify({
          line: open.map((item) => item.reason).join("; "),
          reasons: open.map((item) => item.ruleID),
        })
      : null,
    concern_totals: totals,
    concern_version: concernVersion,
    dispatch_pause: json(status.dispatchPause),
    dispatch_pause_plan_id: status.dispatchPause ? (placement?.plan_id ?? null) : null,
    wait_plans_count: waits.length,
    wait_plan_ids: JSON.stringify(waits.map((wait) => wait.planID)),
    // Every task the row waits behind: unmet dependencies, then unaccepted prerequisites, then the
    // reservations holding it back (the three lists `rowBlockers` merged).
    blocker_task_ids: JSON.stringify([
      ...new Set([
        ...edges.filter((edge) => edge.waiting === 1).map((edge) => edge.child_task_id as string),
        ...waitingOn,
        ...status.blockers,
      ]),
    ]),
    dependency_waiting: edges.some((edge) => edge.waiting === 1) ? 1 : 0,
    blocker_count: status.blockers.length,
    dependency_count: edges.length,
    decision,
    decision_reason: decisionReason,
  }
  const rowChanged = upsert(db, "task_schedule", "seq", row)
  if (rowChanged) {
    if (old && old.retired === 0) adjustCount(db, project, old.bucket as string, -1)
    if (row.retired === 0) adjustCount(db, project, bucket, 1)
  }
  return rowChanged || edgesChanged || blockersChanged || waitsChanged || sessionsChanged
}

/** The plan row and every node row of the plan; cascades to plans listing this one. */
export function refreshPlan(db: Database, ctx: RefreshContext, planID: string): boolean {
  ctx.plans.delete(planID)
  const plan = planFacts(db, ctx, planID)
  if (!plan) return false
  const nodes = db
    .query<{ task_id: string; state: string }, [string]>(
      "SELECT task_id,state FROM runner_nodes WHERE plan_id=? ORDER BY ordinal",
    )
    .all(planID)
  const header = upsert(db, "task_schedule_plans", "plan_id", {
    plan_id: planID,
    project_directory: plan.project_directory,
    seq: plan.rowid,
    title: plan.title,
    state: plan.state,
    reason: plan.reason,
    priority: plan.priority > 0 ? plan.priority : 0,
    priority_key: priorityKeyOf(plan.priority),
    owner_session_id: plan.owner,
    workspace_mode: plan.mode ?? null,
    after_plans: JSON.stringify(plan.afterPlans),
    after_plans_count: plan.afterPlans.length,
    // The plan's own pause; a project or global pause shows on each queued row (`dispatch_pause`).
    pause: json(plan.own),
    plan_revision: plan.revision,
    node_count: nodes.length,
    open_count: nodes.filter((node) => !TERMINAL.has(node.state)).length,
  })
  let changed = header
  for (const node of nodes) changed = refreshTask(db, ctx, node.task_id) || changed
  if (changed)
    for (const parent of db
      .query<{ plan_id: string }, [string, string]>(
        `SELECT DISTINCT t.plan_id FROM task_schedule_edges e
         JOIN task_schedule t ON t.task_id=e.parent_task_id
         WHERE e.child_plan_id=? AND t.plan_id IS NOT NULL AND t.plan_id<>?`,
      )
      .all(planID, planID))
      ctx.enqueue("plan", parent.plan_id)
  return changed
}

/** Recompute blockers of queued and ready tasks when the active reservations changed. */
export function refreshReservations(db: Database, ctx: RefreshContext, project: string): void {
  const fingerprint = reservationFingerprint(activeReservations(db, ctx, project))
  const state = db
    .query<{ reservations_fp: string }, [string]>(
      "SELECT reservations_fp FROM task_schedule_state WHERE project_directory=?",
    )
    .get(project)
  if (state?.reservations_fp === fingerprint) return
  for (const row of db
    .query<{ task_id: string }, [string]>(
      "SELECT task_id FROM task_schedule WHERE project_directory=? AND node_state IN ('queued','ready')",
    )
    .all(project))
    refreshTask(db, ctx, row.task_id)
  db.query(
    `INSERT INTO task_schedule_state(project_directory,reservations_fp) VALUES(?,?)
     ON CONFLICT(project_directory) DO UPDATE SET reservations_fp=excluded.reservations_fp`,
  ).run(project, fingerprint)
}

/** Recompute queued and ready tasks in the scope of a project or global pause. */
export function refreshPause(db: Database, ctx: RefreshContext, scope: string): void {
  const rows =
    scope === "global"
      ? db
          .query<{ task_id: string }, []>(
            "SELECT task_id FROM task_schedule WHERE node_state IN ('queued','ready')",
          )
          .all()
      : db
          .query<{ task_id: string }, [string]>(
            `SELECT task_id FROM task_schedule WHERE node_state IN ('queued','ready')
             AND project_directory IN (SELECT path FROM lazers_project_paths WHERE key=?)`,
          )
          .all(scope)
  for (const row of rows) refreshTask(db, ctx, row.task_id)
}
