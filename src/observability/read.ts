import { progressRecencySQL } from "../progress/recency.ts"
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import type { ProgressRow } from "../runner/store.ts"
import { TaskState } from "../runner/schema.ts"
import { PlanInput } from "../runner/schema.ts"
import { machineVersion, taskMachine } from "../runner/machine.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TrajectoryHost } from "../trajectory/native.ts"
import {
  inspectTrajectory,
  captureTrajectoryHistory,
  inspectTrajectoryStatus,
} from "../trajectory/read.ts"
import { StampGate } from "../core/stamp-gate.ts"
import { TrajectoryHistoryCache } from "../trajectory/history.ts"
import { TrajectoryLiveCache } from "../trajectory/live.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { sourceStampFromDatabase } from "./changes.ts"
import { projectAssociations, projectSessionIDs, sessionAssociations } from "./associations.ts"
import { projectProgressFact } from "../progress/projection.ts"
import type { TaskValuationProvider } from "../models/task-valuation.ts"
import { LiveRadarReader } from "./live-read.ts"
import type {
  LiveAttemptRequestInput,
  LiveGroupRequestInput,
  LiveAttemptResponse,
  LiveGroupResponse,
  LiveRadarRequestInput,
  LiveRadarResponse,
  ObservationScope,
  SingleScope,
  ObservationScopeView,
  RadarRequestInput,
  RadarResponse,
  SnapshotResponse,
  TopologyResponse,
  TrajectoryRequest,
  TrajectoryResponse,
  TrajectoryHistoryRequest,
  TrajectoryHistoryResponse,
  TrajectoryStatusRequest,
} from "./contract.ts"
import { singleScope } from "./contract.ts"
import { findOwner } from "../projects/resolve.ts"
import type { OwnerQuery } from "../projects/resolve.ts"
import { canonicalPath, pickUnit } from "../projects/scope.ts"
import type { ProjectRef, ProjectUnit, UnitAccess } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ReadOnlyTaskRepository } from "../storage.ts"
import type { TaskRepository } from "../storage.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { RadarInput, RadarOutput } from "./contract.ts"
import { outerPauseIn, outerPauseReason } from "../projects/pause.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"

type PlanRecord = {
  id: string
  revision: number
  version: number
  state: string
  reason: string | null
}
type NodeRecord = {
  plan_id: string
  task_id: string
  ordinal: number
  state: string
  version: number
  reason: string | null
  snapshot: string
  machine_version: string
}
type TransitionRecord = {
  id: number
  plan_id: string
  task_id: string | null
  version: number
  event: string
  payload: string
  created_at: number
}
type TaskRecord = { id: string; body: string; reference?: string }
type DependencyRecord = { plan_id: string; prerequisite: string; successor: string }
type AttemptIdentity = {
  id: string
  task_id: string
  plan_id: string
  number: number
  state: string
  started_at: number
}
type CheckRecord = {
  id: string
  plan_id: string
  task_id: string | null
  attempt_id: string | null
  kind: string
  state: string
  started_at: unknown
  ended_at: unknown
  exit_code: unknown
}
type RadarPlanRecord = { id: string; state: string; owner: string; body: string }
type RadarAttemptRecord = {
  id: string
  plan_id: string
  task_id: string
  number: number
  session_id: string
  message_id: string
  workspace: string
  policy: string
  state: string
  started_at: number
}
type RadarEffectRecord = {
  id: string
  plan_id: string
  task_id: string | null
  attempt_id: string | null
  kind: string
  state: string
  payload: string
}
type RadarContinuationRecord = {
  plan_id: string
  session_id: string
  parent_id: string | null
  directory: string
}
type RadarOutboxRecord = {
  id: string
  plan_id: string
  session_id: string
  message_id: string
  state: string
}
type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function jsonObject(value: string): JsonObject | null {
  try {
    return object(JSON.parse(value))
  } catch {
    return null
  }
}

function stableToken(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function sessionNodeID(sessionID: string) {
  return `session:${stableToken(sessionID)}`
}

function scopeView(scope: ObservationScope): ObservationScopeView {
  return scope.kind === "session"
    ? { kind: "session", sessionID: scope.sessionID }
    : { kind: "project" }
}

function machineDefinition() {
  const config = taskMachine.config
  if (!config.id || !config.initial || !config.states)
    throw new Error("The task machine definition is incomplete")
  const states = Object.entries(config.states).map(([id, value]) => {
    const state = value as { type?: string; on?: Record<string, unknown> }
    const transitions = Object.entries(state.on ?? {}).flatMap(([event, target]) => {
      const values = Array.isArray(target) ? target : [target]
      return values.flatMap((value) => {
        const candidate = typeof value === "string" ? value : object(value)?.target
        const targets = Array.isArray(candidate) ? candidate : [candidate]
        return targets.flatMap((item) =>
          typeof item === "string" && TaskState.safeParse(item).success
            ? [{ event, target: TaskState.parse(item) }]
            : [],
        )
      })
    })
    return {
      id: TaskState.parse(id),
      type: state.type === "final" ? ("final" as const) : ("atomic" as const),
      transitions,
    }
  })
  return {
    id: config.id,
    version: machineVersion,
    initialState: TaskState.parse(config.initial),
    states,
  }
}

function planInput(plan: { body: string }) {
  try {
    return PlanInput.parse(JSON.parse(plan.body))
  } catch {
    return null
  }
}

type ParsedPlanInput = ReturnType<typeof planInput>

/**
 * Parsed plan inputs by plan id and body revision, so a plan body is read and zod-parsed once
 * per revision instead of every project read. A parsed input is the title, priority and plan
 * edges: well under 1 KB typically (estimated from the schema, not measured on live data), so
 * the 4 MB budget holds several thousand plans; least recently used are evicted, never refused.
 */
const planInputs = new StampGate<ParsedPlanInput>({ maxBytes: 4 * 1024 * 1024 })

function planInputFor(db: Database, plan: Pick<PlanRecord, "id" | "revision">) {
  return planInputs.runSync(`${db.filename}\0${plan.id}`, plan.revision, () => {
    const body = db
      .query<{ body: string }, [string]>("SELECT body FROM runner_plans WHERE id=?")
      .get(plan.id)?.body
    return body === undefined ? null : planInput({ body })
  })
}

type TopologyAssociations = {
  associations: { taskIDs: Set<string>; planIDs: Set<string> }
  allPlans: PlanRecord[]
}

/**
 * The plan-derived part of a topology read (association closure over plan edges and the
 * project's plan headers), gated on the observation revision, the task-change version and the
 * dispatch pauses (a pause table the revision triggers do not cover). One gate per core, found
 * through the core's observation secret.
 */
const topologyGates = new WeakMap<Uint8Array, StampGate<TopologyAssociations>>()
function topologyGate(secret: Uint8Array) {
  let gate = topologyGates.get(secret)
  if (!gate) {
    // Each entry is id lists plus plan headers (about 200 bytes a plan, 1000 plans maximum per
    // scope): about 200 KB. 8 MB holds dozens of scopes; estimated, not measured on live data.
    gate = new StampGate<TopologyAssociations>({ maxBytes: 8 * 1024 * 1024 })
    topologyGates.set(secret, gate)
  }
  return gate
}

function initialAssociations(db: Database, projectDirectory: string, scope: SingleScope) {
  return scope.kind === "project"
    ? projectAssociations(db, projectDirectory)
    : sessionAssociations(db, projectDirectory, scope.sessionID)
}

function loadTopologyAssociations(
  db: Database,
  projectDirectory: string,
  scope: SingleScope,
  secret: Uint8Array,
  extraSessionIDs: Iterable<string> = [],
) {
  const stamp = sourceStampFromDatabase(db, projectDirectory, secret)
  const pauses = new Map<
    string,
    { reason: string; untilPlans: string[]; level?: "project" | "global" }
  >(
    db
      .query<{ plan_id: string; reason: string; until_plans: string }, [string]>(
        "SELECT c.plan_id,c.reason,c.until_plans FROM runner_dispatch_controls c JOIN runner_plans p ON p.id=c.plan_id WHERE p.project_directory=? AND c.state='paused'",
      )
      .all(projectDirectory)
      .map((row) => [
        row.plan_id,
        { reason: row.reason, untilPlans: JSON.parse(row.until_plans) as string[] },
      ]),
  )
  const revision = db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM observation_revisions WHERE project_directory=?",
    )
    .get(projectDirectory)?.revision
  const key = JSON.stringify([
    db.filename,
    projectDirectory,
    scope.kind,
    scope.sessionID,
    [...extraSessionIDs].sort(),
  ])
  const gated = () => {
    const associations = initialAssociations(db, projectDirectory, scope)
    if (scope.kind === "session") {
      for (const sessionID of extraSessionIDs) {
        if (sessionID === scope.sessionID) continue
        const extra = sessionAssociations(db, projectDirectory, sessionID)
        for (const taskID of extra.taskIDs) associations.taskIDs.add(taskID)
        for (const planID of extra.planIDs) associations.planIDs.add(planID)
      }
    }
    // Plan headers only: bodies are read per plan, once per revision, through `planInputFor`.
    const allPlans = db
      .query<PlanRecord, [string]>(
        "SELECT id,revision,version,state,reason FROM runner_plans WHERE project_directory=? ORDER BY rowid",
      )
      .all(projectDirectory)
    const plansByID = new Map(allPlans.map((plan) => [plan.id, plan]))

    // A session-linked plan also links the actual plans it waits on. Resolve only
    // those same-project relationships; never accept a project/plan ID as scope.
    const pending = [...associations.planIDs]
    while (pending.length) {
      const id = pending.pop()!
      const plan = plansByID.get(id)
      const input = plan && planInputFor(db, plan)
      for (const dependency of new Set([
        ...(input?.afterPlans ?? []),
        ...(pauses.get(id)?.untilPlans ?? []),
      ])) {
        if (plansByID.has(dependency) && !associations.planIDs.has(dependency)) {
          associations.planIDs.add(dependency)
          pending.push(dependency)
        }
      }
      if (associations.planIDs.size > 1000)
        throw new Error("Observation scope is too large; narrow it")
    }

    if (associations.planIDs.size) {
      const planIDs = [...associations.planIDs]
      const placeholders = planIDs.map(() => "?").join(",")
      for (const row of db
        .query<{ task_id: string }, string[]>(
          `SELECT task_id FROM runner_nodes WHERE plan_id IN (${placeholders})`,
        )
        .all(...planIDs))
        associations.taskIDs.add(row.task_id)
    }
    return { associations, allPlans }
  }
  const { associations, allPlans } = topologyGate(secret).runSync(
    key,
    `${stamp.repositoryVersion}:${revision ?? 0}:${JSON.stringify([...pauses])}`,
    gated,
  )
  // A project or global pause holds every plan and is stricter than a plan's own.
  const outer = outerPauseIn(db, projectDirectory)
  if (outer)
    for (const plan of allPlans)
      pauses.set(plan.id, {
        reason: outerPauseReason(outer),
        untilPlans: [],
        level: outer.level,
      })
  return { stamp, associations, allPlans, pauses }
}

function loadTopologySource(
  db: Database,
  projectDirectory: string,
  scope: SingleScope,
  secret: Uint8Array,
  extraSessionIDs: Iterable<string> = [],
) {
  const { stamp, associations, allPlans, pauses } = loadTopologyAssociations(
    db,
    projectDirectory,
    scope,
    secret,
    extraSessionIDs,
  )
  const taskIDs = [...associations.taskIDs]
  const tasks = taskIDs.length
    ? db
        .query<TaskRecord, (string | number)[]>(
          `SELECT t.id,t.body,r.reference FROM tasks t
           LEFT JOIN task_references r ON r.project_directory=t.project_directory AND r.task_id=t.id
           WHERE t.project_directory=? AND t.id IN (${taskIDs.map(() => "?").join(",")}) ORDER BY t.rowid`,
        )
        .all(projectDirectory, ...taskIDs)
        .map((row) => ({ ...TaskSpecSchema.parse(JSON.parse(row.body)), reference: row.reference }))
    : []
  const planIDs = [...associations.planIDs]
  const placeholders = planIDs.map(() => "?").join(",")
  const selectedPlanIDs = new Set(planIDs)
  const plans = allPlans
    .filter((plan) => selectedPlanIDs.has(plan.id))
    .map((plan) => ({ ...plan, input: planInputFor(db, plan) }))
  const nodes = planIDs.length
    ? db
        .query<NodeRecord, string[]>(
          `SELECT plan_id,task_id,ordinal,state,version,reason,snapshot,machine_version
           FROM runner_nodes WHERE plan_id IN (${placeholders}) ORDER BY plan_id,ordinal`,
        )
        .all(...planIDs)
    : []
  const dependencies = planIDs.length
    ? db
        .query<DependencyRecord, string[]>(
          `SELECT plan_id,prerequisite,successor FROM runner_dependencies
           WHERE plan_id IN (${placeholders}) ORDER BY plan_id,prerequisite,successor`,
        )
        .all(...planIDs)
    : []
  if (plans.length > 1000) throw new Error("Observation scope is too large; narrow it")
  return { stamp, associations, tasks, plans, nodes, dependencies, pauses }
}

function loadProjectionSource(
  db: Database,
  projectDirectory: string,
  scope: SingleScope,
  secret: Uint8Array,
  extraSessionIDs: Iterable<string> = [],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const topology = loadTopologySource(db, projectDirectory, scope, secret, extraSessionIDs)
  const planIDs = [...topology.associations.planIDs]
  const placeholders = planIDs.map(() => "?").join(",")
  const transitions = planIDs.length
    ? db
        .query<TransitionRecord, string[]>(
          `SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions
           WHERE plan_id IN (${placeholders}) ORDER BY id DESC LIMIT 10001`,
        )
        .all(...planIDs)
    : []
  signal?.throwIfAborted()
  const attempts = planIDs.length
    ? db
        .query<AttemptIdentity, string[]>(
          `SELECT id,task_id,plan_id,number,state,started_at FROM runner_attempts WHERE plan_id IN (${placeholders}) ORDER BY started_at DESC,number DESC,id DESC LIMIT 10001`,
        )
        .all(...planIDs)
    : []
  signal?.throwIfAborted()
  const checks = planIDs.length
    ? db
        .query<CheckRecord, string[]>(
          `SELECT id,plan_id,task_id,attempt_id,kind,state,
          json_extract(receipt,'$.check.startedAt') AS started_at,
          json_extract(receipt,'$.check.endedAt') AS ended_at,
          json_extract(receipt,'$.check.exitCode') AS exit_code
         FROM runner_effects WHERE plan_id IN (${placeholders})
          AND (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%') ORDER BY rowid DESC LIMIT 10001`,
        )
        .all(...planIDs)
    : []
  signal?.throwIfAborted()
  const historyCoverage = {
    transitionsTruncated: transitions.length > 10_000,
    attemptsTruncated: attempts.length > 10_000,
    checksTruncated: checks.length > 10_000,
  }
  return {
    ...topology,
    transitions: transitions.slice(0, 10_000).reverse(),
    attempts: attempts.slice(0, 10_000).reverse(),
    checks: checks.slice(0, 10_000).reverse(),
    historyCoverage,
    historyTruncated: Object.values(historyCoverage).some(Boolean),
  }
}

function loadTaskObservationSource(
  db: Database,
  projectDirectory: string,
  scope: SingleScope,
  secret: Uint8Array,
  target: { taskID?: string; attemptID?: string },
) {
  const topology = loadTopologyAssociations(db, projectDirectory, scope, secret)
  let taskID = target.taskID
  if (target.attemptID) {
    const attempt = db
      .query<{ task_id: string; plan_id: string }, [string, string]>(
        `SELECT a.task_id,a.plan_id FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         WHERE p.project_directory=? AND a.id=?`,
      )
      .get(projectDirectory, target.attemptID)
    if (!attempt || !topology.associations.planIDs.has(attempt.plan_id))
      throw new Error("No observation in this scope")
    taskID = attempt.task_id
  }
  if (!taskID || !topology.associations.taskIDs.has(taskID))
    throw new Error("No observation in this scope")

  const planIDs = [...topology.associations.planIDs]
  const transitionSequence = planIDs.length
    ? (db
        .query<{ sequence: number | null }, string[]>(
          `SELECT MAX(id) AS sequence FROM runner_transitions
           WHERE plan_id IN (${planIDs.map(() => "?").join(",")})`,
        )
        .get(...planIDs)?.sequence ?? 0)
    : 0
  return { stamp: topology.stamp, taskID, transitionSequence }
}

function projectTopology(source: ReturnType<typeof loadTopologySource>) {
  const projection = source
  const stats = privacyStats()
  const taskSpecs = new Map(projection.tasks.map((task) => [task.id, task]))
  const states = new Map(projection.nodes.map((node) => [node.task_id, node.state]))
  const waitingOn = new Map<string, string[]>()
  for (const edge of projection.dependencies) {
    if (states.get(edge.prerequisite) === "accepted") continue
    const values = waitingOn.get(edge.successor) ?? []
    values.push(edge.prerequisite)
    waitingOn.set(edge.successor, values)
  }
  const plans = projection.plans.map((plan, queuePosition) => {
    const input = plan.input
    const nodes = projection.nodes.filter((node) => node.plan_id === plan.id)
    return {
      id: plan.id,
      ...(projection.pauses.get(plan.id) ? { dispatchPause: projection.pauses.get(plan.id) } : {}),
      priority: input?.priority ?? 0,
      queuePosition,
      revision: plan.revision,
      version: plan.version,
      state: safeText(plan.state, stats, 80),
      reason: plan.reason === null ? null : safeText(plan.reason, stats),
      title: input?.title ? safeText(input.title, stats, 120) : null,
      afterPlans: (input?.afterPlans ?? []).filter((id) => projection.associations.planIDs.has(id)),
      nodes: nodes.map((node) => {
        const task = taskSpecs.get(node.task_id)
        if (!task) throw new Error("Observation task specification is unavailable")
        const state = TaskState.parse(node.state)
        const machineSnapshot = safeSnapshot(node)
        return {
          taskID: node.task_id,
          ...(task.reference ? { reference: task.reference } : {}),
          ...(task.proposal.sourcePlan ? { sourcePlan: task.proposal.sourcePlan } : {}),
          revision: task.revision,
          objective: safeText(task.proposal.objective, stats, 8000),
          ordinal: node.ordinal,
          state,
          version: node.version,
          reason: node.reason === null ? null : safeText(node.reason, stats),
          machineVersion: safeText(node.machine_version, stats, 120),
          machineSupported: node.machine_version === machineVersion,
          ...machineSnapshot,
          waitingOn: waitingOn.get(node.task_id) ?? [],
        }
      }),
      dependencies: projection.dependencies
        .filter((edge) => edge.plan_id === plan.id)
        .map(({ prerequisite, successor }) => ({ prerequisite, successor })),
    }
  })

  const plannedTaskIDs = new Set(projection.nodes.map((node) => node.task_id))
  const unplannedTasks = projection.tasks
    .filter((task) => !plannedTaskIDs.has(task.id))
    .map((task) => ({
      taskID: task.id,
      revision: task.revision,
      status: "submitted" as const,
      title: safeText(
        task.proposal.objective.trim().replace(/\s+/g, " ").slice(0, 120),
        stats,
        120,
      ),
    }))
  if (unplannedTasks.length > 1000) throw new Error("Observation scope is too large; narrow it")

  return { plans, unplannedTasks }
}

function loadRadarSource(
  db: Database,
  projectDirectory: string,
  scope: SingleScope,
  secret: Uint8Array,
  extraSessionIDs: Iterable<string> = [],
) {
  const projection = loadProjectionSource(db, projectDirectory, scope, secret, extraSessionIDs)
  const planIDs = [...projection.associations.planIDs]
  const managedSessionIDs =
    scope.kind === "project"
      ? projectSessionIDs(db, projectDirectory, secret)
      : new Set<string>([scope.sessionID])
  for (const task of projection.tasks)
    if (task.provenance.sessionID) managedSessionIDs.add(task.provenance.sessionID)
  if (!planIDs.length) {
    return {
      ...projection,
      radarPlans: [] as RadarPlanRecord[],
      radarAttempts: [] as RadarAttemptRecord[],
      radarEffects: [] as RadarEffectRecord[],
      continuations: [] as RadarContinuationRecord[],
      outbox: [] as RadarOutboxRecord[],
      progress: [] as ProgressRow[],
      progressTruncated: false,
      workTruncated: projection.tasks.length > 1000 || projection.historyTruncated,
      managedSessionIDs,
    }
  }
  const placeholders = planIDs.map(() => "?").join(",")
  const radarPlans = db
    .query<RadarPlanRecord, (string | number)[]>(
      `SELECT id,state,owner,body FROM runner_plans
       WHERE project_directory=? AND id IN (${placeholders}) ORDER BY rowid LIMIT 1001`,
    )
    .all(projectDirectory, ...planIDs)
  const radarAttempts = db
    .query<RadarAttemptRecord, string[]>(
      `SELECT id,plan_id,task_id,number,session_id,message_id,workspace,policy,state,started_at
       FROM runner_attempts WHERE plan_id IN (${placeholders}) ORDER BY started_at,number,id LIMIT 10001`,
    )
    .all(...planIDs)
  const radarEffects = db
    .query<RadarEffectRecord, string[]>(
      `SELECT id,plan_id,task_id,attempt_id,kind,state,payload FROM runner_effects
       WHERE plan_id IN (${placeholders}) AND kind IN ('session','prompt') ORDER BY rowid LIMIT 20001`,
    )
    .all(...planIDs)
  const continuations = db
    .query<RadarContinuationRecord, string[]>(
      `SELECT plan_id,session_id,parent_id,directory FROM runner_continuations
       WHERE plan_id IN (${placeholders}) ORDER BY plan_id LIMIT 1001`,
    )
    .all(...planIDs)
  const outbox = db
    .query<RadarOutboxRecord, string[]>(
      `SELECT id,plan_id,session_id,message_id,state FROM runner_outbox
       WHERE plan_id IN (${placeholders}) ORDER BY rowid LIMIT 10001`,
    )
    .all(...planIDs)
  const progressColumns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(runner_progress)")
      .all()
      .map(({ name }) => name),
  )
  const recordedAtColumn = progressColumns.has("recorded_at")
    ? "g.recorded_at"
    : "NULL AS recorded_at"
  // Current schemas maintain observation recency transactionally. Older read-only
  // stores retain the exact legacy ordering until their normal schema upgrade.
  const recentProgress = progressColumns.has("latest_observed_at")
    ? `SELECT g.seq,g.latest_observed_at AS latest_at
         FROM runner_progress g
        WHERE g.plan_id IN (${placeholders})
        ORDER BY g.latest_observed_at DESC,g.seq DESC LIMIT 5001`
    : `SELECT g.seq,${progressRecencySQL("g")} AS latest_at
         FROM runner_progress g
        WHERE g.plan_id IN (${placeholders})
        ORDER BY latest_at DESC,g.seq DESC LIMIT 5001`
  const progressRows = db
    .query<ProgressRow, (string | number)[]>(
      `WITH recent AS MATERIALIZED (${recentProgress})
        SELECT g.seq,g.project_directory,g.project_id,g.plan_id,g.task_id,g.attempt_id,
               g.session_id,g.at,${recordedAtColumn},g.source,g.sources_json,g.kind,
               g.event_ids_json,g.call_id,g.message_id,g.dedupe_key,g.payload
          FROM runner_progress g JOIN recent ON recent.seq=g.seq
         ORDER BY recent.latest_at DESC, g.seq DESC`,
    )
    .all(...planIDs)
  const progress = progressRows.slice(0, 5_000).sort((left, right) => left.seq - right.seq)

  for (const plan of radarPlans) managedSessionIDs.add(plan.owner)
  for (const attempt of radarAttempts) managedSessionIDs.add(attempt.session_id)
  for (const continuation of continuations) {
    managedSessionIDs.add(continuation.session_id)
    if (continuation.parent_id) managedSessionIDs.add(continuation.parent_id)
  }

  return {
    ...projection,
    radarPlans,
    radarAttempts: radarAttempts.slice(0, 10_000),
    radarEffects: radarEffects.slice(0, 20_000),
    continuations,
    outbox: outbox.slice(0, 10_000),
    progress: progress.slice(0, 5_000),
    progressTruncated: progressRows.length > 5_000,
    workTruncated:
      projection.historyTruncated ||
      projection.tasks.length > 1000 ||
      radarPlans.length > 1000 ||
      radarAttempts.length > 10_000 ||
      radarEffects.length > 20_000 ||
      continuations.length > 1000 ||
      outbox.length > 10_000,
    managedSessionIDs,
  }
}

const finiteTime = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null

function recordedExecutions(attempt: AttemptIdentity, transitions: TransitionRecord[]) {
  const intervals: Array<{
    startedAt: number | null
    endedAt: number | null
    startSequence: number | null
    endSequence: number | null
    timingBasis: string
  }> = []
  let open: (typeof intervals)[number] | undefined
  for (const row of transitions) {
    if (row.plan_id !== attempt.plan_id || row.task_id !== attempt.task_id) continue
    if (row.event !== "WORKER_STARTED" && row.event !== "WORKER_STOPPED") continue
    const payload = jsonObject(row.payload)
    if (payload?.attemptID !== attempt.id) continue
    const time = finiteTime(payload.observedAt)
    if (row.event === "WORKER_STARTED") {
      open = {
        startedAt: time,
        endedAt: null,
        startSequence: row.id,
        endSequence: null,
        timingBasis:
          "Recorded WORKER_STARTED/WORKER_STOPPED observedAt; worker activity, not task acceptance",
      }
      intervals.push(open)
    } else {
      if (!open) {
        open = {
          startedAt: null,
          endedAt: null,
          startSequence: null,
          endSequence: null,
          timingBasis: "Recorded WORKER_STOPPED observedAt; worker start is unavailable",
        }
        intervals.push(open)
      }
      open.endedAt = time
      open.endSequence = row.id
      open = undefined
    }
  }
  return intervals
}

function safeSnapshot(node: NodeRecord) {
  if (node.machine_version !== machineVersion)
    return { snapshot: null, snapshotMatchesState: false }
  const parsed = jsonObject(node.snapshot)
  const state = TaskState.safeParse(parsed?.value)
  if (!parsed || !state.success) return { snapshot: null, snapshotMatchesState: false }
  const status = typeof parsed.status === "string" ? parsed.status : "unknown"
  return {
    snapshot: { status: safeText(status, privacyStats(), 40), value: state.data },
    snapshotMatchesState: state.data === node.state,
  }
}

function stateTransitionSet() {
  const output = new Set<string>()
  for (const state of machineDefinition().states)
    for (const transition of state.transitions)
      output.add(`${state.id}\u0000${transition.event}\u0000${transition.target}`)
  return output
}

type RadarSource = ReturnType<typeof loadRadarSource>
type PrivacyStats = ReturnType<typeof privacyStats>
type RadarEdge = RadarResponse["edges"][number]
type RadarEvidence = RadarEdge["evidence"][number]
type RadarRoute = RadarResponse["routes"][number]
type RadarSession = RadarResponse["sessions"][number]
type RadarDeliveryStage = NonNullable<RadarEdge["deliveryStage"]>

type RadarSessionContext = {
  reasons: Map<string, Set<string>>
  runtimeManagedSessionIDs: Set<string>
  expectedDirectories: Map<string, Set<string>>
  planIDs: Map<string, Set<string>>
  taskIDs: Map<string, Set<string>>
  attemptIDs: Map<string, Set<string>>
}

type RadarNativeResolution = {
  nativeInventory: RadarResponse["freshness"]["nativeInventory"]
  inventoryTruncated: boolean
  nativeByID: Map<string, RadarNativeSession>
  inventorySessionIDs: Set<string>
  nativeFailures: Set<string>
  foreignSessionIDs: Set<string>
  resolvedSessionIDs: Set<string>
  scopeAncestryIDs: Set<string>
  ancestryTruncated: boolean
}

type RadarNativeReader = {
  host: RadarSessionHost
  projectID: string
  signal: AbortSignal
}

type RadarRouteSink = { routes: RadarRoute[]; routeIDs: Set<string>; truncated: boolean }

type RadarEdgeBuilder = {
  edges: RadarEdge[]
  edgeIDs: Set<string>
  truncated: boolean
  stats: PrivacyStats
}

type RadarTransitionIndex = {
  byEffectID: Map<string, TransitionRecord[]>
  byOutboxID: Map<string, TransitionRecord[]>
}

type RadarSessionInputs = {
  projectID: string
  selectedIDs: string[]
  selectedSet: ReadonlySet<string>
  native: RadarNativeResolution
  context: RadarSessionContext
  routeSink: RadarRouteSink
  stats: PrivacyStats
  observedAt: number
  configuredBySession: Map<string, Set<string>>
}

function newRadarSessionContext(): RadarSessionContext {
  return {
    reasons: new Map(),
    runtimeManagedSessionIDs: new Set(),
    expectedDirectories: new Map(),
    planIDs: new Map(),
    taskIDs: new Map(),
    attemptIDs: new Map(),
  }
}

function newRadarNativeResolution(): RadarNativeResolution {
  return {
    nativeInventory: "managed-only",
    inventoryTruncated: false,
    nativeByID: new Map(),
    inventorySessionIDs: new Set(),
    nativeFailures: new Set(),
    foreignSessionIDs: new Set(),
    resolvedSessionIDs: new Set(),
    scopeAncestryIDs: new Set(),
    ancestryTruncated: false,
  }
}

function addContext(map: Map<string, Set<string>>, sessionID: string, id: string) {
  const values = map.get(sessionID) ?? new Set<string>()
  values.add(id)
  map.set(sessionID, values)
}

function reachableSessionIDs(nativeByID: Map<string, RadarNativeSession>, rootID: string) {
  const reachable = new Set([rootID])
  let expanded = true
  while (expanded) {
    expanded = false
    for (const session of nativeByID.values()) {
      if (session.parentID && reachable.has(session.parentID) && !reachable.has(session.id)) {
        reachable.add(session.id)
        expanded = true
      }
    }
  }
  return reachable
}

async function readNativeInventory(
  reader: RadarNativeReader,
  scope: SingleScope,
  native: RadarNativeResolution,
  context: RadarSessionContext,
) {
  try {
    const inventory =
      scope.kind === "project"
        ? await reader.host.project(reader.projectID, true, 500, reader.signal)
        : await reader.host.descendants(reader.projectID, scope.sessionID, true, 500, reader.signal)
    native.inventoryTruncated = inventory.truncated
    native.nativeInventory = inventory.truncated ? "bounded" : "complete"
    for (const session of inventory.sessions) {
      if (session.projectID !== reader.projectID) continue
      native.nativeByID.set(session.id, session)
    }
    if (scope.kind === "project") {
      for (const session of native.nativeByID.values()) native.inventorySessionIDs.add(session.id)
    } else {
      const reachable = reachableSessionIDs(native.nativeByID, scope.sessionID)
      for (const sessionID of reachable) {
        if (sessionID === scope.sessionID) continue
        native.inventorySessionIDs.add(sessionID)
        addContext(context.reasons, sessionID, "native-ancestry")
      }
      for (const sessionID of [...native.nativeByID.keys()])
        if (!reachable.has(sessionID)) native.nativeByID.delete(sessionID)
    }
  } catch (error) {
    if (reader.signal.aborted) throw error
    native.nativeInventory = "unavailable"
  }
}

async function resolveScopeRoot(
  reader: RadarNativeReader,
  rootID: string,
  native: RadarNativeResolution,
) {
  let current = native.nativeByID.get(rootID)
  if (current) return current
  reader.signal.throwIfAborted()
  try {
    current = (await reader.host.get(rootID, reader.signal)) ?? undefined
    native.resolvedSessionIDs.add(rootID)
    if (current?.projectID === reader.projectID) native.nativeByID.set(rootID, current)
    else if (current && current.projectID !== reader.projectID) {
      native.foreignSessionIDs.add(rootID)
      current = undefined
    }
  } catch (error) {
    if (reader.signal.aborted) throw error
    native.nativeFailures.add(rootID)
    native.resolvedSessionIDs.add(rootID)
  }
  return current
}

async function resolveScopeAncestry(
  reader: RadarNativeReader,
  rootID: string,
  native: RadarNativeResolution,
  context: RadarSessionContext,
) {
  native.scopeAncestryIDs.add(rootID)
  let current = await resolveScopeRoot(reader, rootID, native)
  const visited = new Set([rootID])
  for (let depth = 0; current?.parentID; depth++) {
    const parentID = current.parentID
    if (visited.has(parentID)) break
    if (depth >= 50) {
      native.ancestryTruncated = true
      break
    }
    visited.add(parentID)
    reader.signal.throwIfAborted()
    try {
      const parent = await reader.host.get(parentID, reader.signal)
      native.resolvedSessionIDs.add(parentID)
      if (!parent) break
      if (parent.projectID !== reader.projectID) {
        native.foreignSessionIDs.add(parentID)
        break
      }
      native.scopeAncestryIDs.add(parentID)
      addContext(context.reasons, parentID, "native-ancestry")
      native.nativeByID.set(parentID, parent)
      current = parent
    } catch (error) {
      if (reader.signal.aborted) throw error
      native.nativeFailures.add(parentID)
      native.resolvedSessionIDs.add(parentID)
      break
    }
  }
}

function recordContinuationContext(
  continuation: RadarSource["continuations"][number],
  context: RadarSessionContext,
) {
  context.runtimeManagedSessionIDs.add(continuation.session_id)
  addContext(context.reasons, continuation.session_id, "continuation")
  addContext(context.planIDs, continuation.session_id, continuation.plan_id)
  addContext(context.expectedDirectories, continuation.session_id, continuation.directory)
  if (continuation.parent_id) {
    addContext(context.reasons, continuation.parent_id, "native-ancestry")
    addContext(context.planIDs, continuation.parent_id, continuation.plan_id)
  }
}

function recordAttemptContext(attempt: RadarAttemptRecord, context: RadarSessionContext) {
  context.runtimeManagedSessionIDs.add(attempt.session_id)
  addContext(context.reasons, attempt.session_id, "attempt")
  addContext(context.planIDs, attempt.session_id, attempt.plan_id)
  addContext(context.taskIDs, attempt.session_id, attempt.task_id)
  addContext(context.attemptIDs, attempt.session_id, attempt.id)
  addContext(context.expectedDirectories, attempt.session_id, attempt.workspace)
}

function recordSourceSessionContext(source: RadarSource, context: RadarSessionContext) {
  for (const task of source.tasks)
    addContext(context.reasons, task.provenance.sessionID, "task-submitter")
  for (const plan of source.radarPlans) {
    addContext(context.reasons, plan.owner, "plan-owner")
    addContext(context.planIDs, plan.owner, plan.id)
  }
  for (const continuation of source.continuations) recordContinuationContext(continuation, context)
  for (const attempt of source.radarAttempts) recordAttemptContext(attempt, context)
  for (const task of source.tasks) addContext(context.taskIDs, task.provenance.sessionID, task.id)
}

function selectRadarSessionIDs(
  scope: SingleScope,
  source: RadarSource,
  native: RadarNativeResolution,
) {
  const requestedIDs = new Set(source.managedSessionIDs)
  for (const sessionID of native.inventorySessionIDs) requestedIDs.add(sessionID)
  for (const sessionID of native.scopeAncestryIDs) requestedIDs.add(sessionID)
  const orderedIDs = [
    ...(scope.kind === "session" ? [scope.sessionID] : []),
    ...[...source.managedSessionIDs].sort(),
    ...[...native.scopeAncestryIDs].filter((id) => !source.managedSessionIDs.has(id)).sort(),
    ...[...native.inventorySessionIDs].filter((id) => !source.managedSessionIDs.has(id)).sort(),
  ]
  const selectedIDs = [...new Set(orderedIDs)].slice(0, 500)
  return { requestedIDs, selectedIDs }
}

async function resolveSelectedSessions(
  reader: RadarNativeReader,
  selectedIDs: string[],
  native: RadarNativeResolution,
) {
  for (const sessionID of selectedIDs) {
    if (native.nativeByID.has(sessionID) || native.resolvedSessionIDs.has(sessionID)) continue
    reader.signal.throwIfAborted()
    try {
      const session = await reader.host.get(sessionID, reader.signal)
      if (session?.projectID === reader.projectID) native.nativeByID.set(sessionID, session)
      else if (session && session.projectID !== reader.projectID)
        native.foreignSessionIDs.add(sessionID)
    } catch (error) {
      if (reader.signal.aborted) throw error
      native.nativeFailures.add(sessionID)
    }
  }
}

function addRoute(sink: RadarRouteSink, route: RadarRoute) {
  if (sink.routeIDs.has(route.id)) return route.id
  if (sink.routes.length >= 20_000) {
    sink.truncated = true
    return null
  }
  sink.routeIDs.add(route.id)
  sink.routes.push(route)
  return route.id
}

function routeFromPolicy(sink: RadarRouteSink, stats: PrivacyStats, attempt: RadarAttemptRecord) {
  const policy = jsonObject(attempt.policy)
  const model = object(policy?.model)
  if (typeof model?.providerID !== "string" || typeof model.id !== "string") return null
  const providerID = safeText(model.providerID, stats, 200)
  const modelID = safeText(model.id, stats, 300)
  if (!providerID || !modelID) return null
  return addRoute(sink, {
    id: `route:attempt:${attempt.id}`,
    providerID,
    modelID,
    variant: typeof model.variant === "string" ? safeText(model.variant, stats, 200) : null,
    source: "attempt-policy",
    sessionID: attempt.session_id,
    attemptID: attempt.id,
    messageID: null,
    eventID: null,
    observedAt: null,
  })
}

function addConfiguredRoutes(sink: RadarRouteSink, stats: PrivacyStats, source: RadarSource) {
  const configuredByAttempt = new Map<string, string | null>()
  const configuredBySession = new Map<string, Set<string>>()
  for (const attempt of source.radarAttempts) {
    const routeID = routeFromPolicy(sink, stats, attempt)
    configuredByAttempt.set(attempt.id, routeID)
    if (routeID) addContext(configuredBySession, attempt.session_id, routeID)
  }
  return { configuredByAttempt, configuredBySession }
}

function radarSessionAvailability(
  native: RadarNativeSession | undefined,
  failure: boolean,
  expected: Set<string> | undefined,
): RadarSession["availability"] {
  const moved = Boolean(native && expected?.size && !expected.has(native.directory))
  return failure
    ? "unavailable"
    : !native
      ? "missing"
      : native.archived
        ? "archived"
        : moved
          ? "moved"
          : "available"
}

function radarSessionClassification(
  sessionID: string,
  reasons: Set<string>,
  inputs: RadarSessionInputs,
): RadarSession["classification"] {
  return inputs.context.runtimeManagedSessionIDs.has(sessionID)
    ? "managed"
    : inputs.native.scopeAncestryIDs.has(sessionID) ||
        [...reasons].some((reason) => reason !== "scope-anchor" && reason !== "native-ancestry")
      ? "associated"
      : "unmanaged"
}

function currentSelectionRoute(
  sessionID: string,
  native: RadarNativeSession | undefined,
  inputs: RadarSessionInputs,
) {
  if (!native?.model) return null
  return addRoute(inputs.routeSink, {
    id: `route:selection:${stableToken(sessionID)}`,
    providerID: safeText(native.model.providerID, inputs.stats, 200),
    modelID: safeText(native.model.id, inputs.stats, 300),
    variant: native.model.variant ? safeText(native.model.variant, inputs.stats, 200) : null,
    source: "session-selection",
    sessionID,
    attemptID: null,
    messageID: null,
    eventID: null,
    observedAt: inputs.observedAt,
  })
}

function radarSessionEntry(sessionID: string, inputs: RadarSessionInputs): RadarSession {
  const { native: resolution, context } = inputs
  const reasons = context.reasons.get(sessionID) ?? new Set<string>()
  const native = resolution.nativeByID.get(sessionID)
  const failure = resolution.nativeFailures.has(sessionID)
  const availability = radarSessionAvailability(
    native,
    failure,
    context.expectedDirectories.get(sessionID),
  )
  const fresh = availability === "available"
  const currentRouteID = fresh ? currentSelectionRoute(sessionID, native, inputs) : null
  const classification = radarSessionClassification(sessionID, reasons, inputs)
  return {
    id: sessionNodeID(sessionID),
    sessionID,
    projectID: inputs.projectID,
    parentSessionID:
      fresh && native?.parentID && inputs.selectedSet.has(native.parentID) ? native.parentID : null,
    classification,
    associations: [...reasons].sort() as RadarSession["associations"],
    availability,
    freshness: fresh
      ? "current"
      : availability === "missing" || availability === "unavailable"
        ? "unknown"
        : "stale",
    agent: fresh ? (native?.agent ?? null) : null,
    state: fresh ? (native?.busy === null ? "unknown" : native?.busy ? "busy" : "idle") : "unknown",
    currentRouteID,
    configuredRouteIDs: [...(inputs.configuredBySession.get(sessionID) ?? [])].sort().slice(0, 100),
    planIDs: [...(context.planIDs.get(sessionID) ?? [])].sort().slice(0, 100),
    taskIDs: [...(context.taskIDs.get(sessionID) ?? [])].sort().slice(0, 100),
    attemptIDs: [...(context.attemptIDs.get(sessionID) ?? [])].sort().slice(0, 100),
    updatedAt: fresh ? (native?.updatedAt ?? null) : null,
    observedAt: native ? inputs.observedAt : null,
  }
}

function buildRadarSessions(inputs: RadarSessionInputs) {
  const sessions: RadarResponse["sessions"] = []
  for (const sessionID of inputs.selectedIDs) {
    if (inputs.native.foreignSessionIDs.has(sessionID)) continue
    const native = inputs.native.nativeByID.get(sessionID)
    if (native && native.projectID !== inputs.projectID) continue
    sessions.push(radarSessionEntry(sessionID, inputs))
  }
  return sessions
}

function addEdge(builder: RadarEdgeBuilder, edge: RadarEdge) {
  if (builder.edgeIDs.has(edge.id)) return
  if (builder.edges.length >= 20_000) {
    builder.truncated = true
    return
  }
  builder.edgeIDs.add(edge.id)
  builder.edges.push(edge)
}

function codeEvidence(reference: string): RadarEdge["evidence"] {
  return [{ source: "code", reference, at: null }]
}

function addBaseEdge(
  builder: RadarEdgeBuilder,
  id: string,
  kind: RadarEdge["kind"],
  from: string,
  to: string,
  status: string,
  values: Partial<RadarEdge> = {},
) {
  addEdge(builder, {
    id,
    kind,
    from,
    to,
    status: safeText(status, builder.stats, 80),
    agentID: null,
    deliveryStage: null,
    planID: null,
    taskID: null,
    attemptID: null,
    messageID: null,
    callID: null,
    routeID: null,
    startedAt: null,
    observedAt: null,
    live: false,
    evidence: [],
    ...values,
  })
}

function radarComponents(): RadarResponse["components"] {
  return [
    {
      id: "component:runner-runtime",
      name: "Task runtime",
      responsibility: "Admits plans, schedules attempts, and reconciles native effects.",
      sourceFile: "src/runner/runtime.ts",
    },
    {
      id: "component:runner-store",
      name: "Runner store",
      responsibility: "Persists plans, attempts, effects, continuations, and outcome delivery.",
      sourceFile: "src/runner/store.ts",
    },
    {
      id: "component:native-session-api",
      name: "Native session API",
      responsibility: "Provides public session identity, selection, and busy/idle observations.",
      sourceFile: "src/runner/native.ts",
    },
    {
      id: "component:progress-recorder",
      name: "Progress recorder",
      responsibility:
        "Coalesces identified native step/tool observations with durable worker progress.",
      sourceFile: "src/progress/recorder.ts",
    },
    {
      id: "component:observability",
      name: "Observability projection",
      responsibility:
        "Reads bounded, scoped runner and native-session metadata without execution writes.",
      sourceFile: "src/observability/read.ts",
    },
  ]
}

function addArchitectureEdges(builder: RadarEdgeBuilder) {
  for (const [from, to, file] of [
    ["component:runner-runtime", "component:runner-store", "src/runner/runtime.ts"],
    ["component:runner-runtime", "component:native-session-api", "src/runner/native.ts"],
    ["component:progress-recorder", "component:runner-store", "src/progress/recorder.ts"],
    ["component:observability", "component:runner-store", "src/observability/read.ts"],
    ["component:observability", "component:native-session-api", "src/observability/native.ts"],
  ] as const)
    addBaseEdge(builder, `architecture:${from}:${to}`, "architecture", from, to, "structural", {
      evidence: codeEvidence(file),
    })
}

function transitionPayload(row: TransitionRecord) {
  return jsonObject(row.payload) ?? {}
}

function indexTransitions(transitions: TransitionRecord[]): RadarTransitionIndex {
  const byEffectID = new Map<string, TransitionRecord[]>()
  const byOutboxID = new Map<string, TransitionRecord[]>()
  for (const row of transitions) {
    const payload = transitionPayload(row)
    const effectID = typeof payload.effectID === "string" ? payload.effectID : null
    if (effectID) {
      const values = byEffectID.get(effectID) ?? []
      values.push(row)
      byEffectID.set(effectID, values)
    }
    const outboxID = typeof payload.outboxID === "string" ? payload.outboxID : null
    if (outboxID) {
      const values = byOutboxID.get(outboxID) ?? []
      values.push(row)
      byOutboxID.set(outboxID, values)
    }
  }
  return { byEffectID, byOutboxID }
}

function transitionEvidence(
  stats: PrivacyStats,
  row: TransitionRecord,
  payload: JsonObject,
  fallbackMessageID: string | null = null,
): RadarEvidence {
  return {
    source: "runner-transition",
    sequence: row.id,
    event: safeText(row.event, stats, 120),
    effectID: typeof payload.effectID === "string" ? safeText(payload.effectID, stats, 200) : null,
    outboxID: typeof payload.outboxID === "string" ? safeText(payload.outboxID, stats, 200) : null,
    messageID:
      typeof payload.messageID === "string"
        ? safeText(payload.messageID, stats, 200)
        : fallbackMessageID,
    at: row.created_at,
  }
}

function progressEvidence(
  stats: PrivacyStats,
  row: ProgressRow,
  at: number | null = row.at,
): RadarEvidence {
  return {
    source: "runner-record",
    recordID: `progress:${row.seq}`,
    messageID: row.message_id ? safeText(row.message_id, stats, 200) : null,
    callID: row.call_id ? safeText(row.call_id, stats, 200) : null,
    at,
  }
}

function eventEvidence(
  stats: PrivacyStats,
  eventID: string,
  eventType: string,
  sessionID: string,
  messageID: string | null,
  callID: string | null,
  at: number,
): RadarEvidence {
  return {
    source: "native-event",
    eventID: safeText(eventID, stats, 200),
    eventType: safeText(eventType, stats, 120),
    sessionID,
    messageID,
    callID,
    at,
  }
}

function runnerRecordEvidence(recordID: string): RadarEvidence[] {
  return [{ source: "runner-record", recordID, messageID: null, callID: null, at: null }]
}

function summarizeRadarPlans(source: RadarSource, stats: PrivacyStats) {
  return source.radarPlans.slice(0, 1000).map((plan) => ({
    id: plan.id,
    state: safeText(plan.state, stats, 80),
    ownerSessionID: plan.owner,
    title: planInput(plan)?.title ? safeText(planInput(plan)!.title!, stats, 120) : null,
  }))
}

function planIDByTask(source: RadarSource) {
  const planByTask = new Map<string, string>()
  for (const node of source.nodes)
    if (!planByTask.has(node.task_id)) planByTask.set(node.task_id, node.plan_id)
  return planByTask
}

function summarizeRadarTasks(source: RadarSource, planByTask: Map<string, string>) {
  const nodesByTask = new Map(source.nodes.map((node) => [node.task_id, node]))
  return source.tasks.slice(0, 1000).map((task) => ({
    id: task.id,
    planID: planByTask.get(task.id) ?? null,
    state: nodesByTask.get(task.id)?.state ?? ("submitted" as const),
  }))
}

function summarizeRadarAttempts(
  source: RadarSource,
  stats: PrivacyStats,
  configuredByAttempt: Map<string, string | null>,
) {
  return source.radarAttempts.slice(0, 10_000).map((attempt) => ({
    id: attempt.id,
    planID: attempt.plan_id,
    taskID: attempt.task_id,
    sessionID: attempt.session_id,
    number: attempt.number,
    state: safeText(attempt.state, stats, 80),
    startedAt: attempt.started_at,
    configuredRouteID: configuredByAttempt.get(attempt.id) ?? null,
  }))
}

function addAssociationEdges(
  builder: RadarEdgeBuilder,
  source: RadarSource,
  plans: ReturnType<typeof summarizeRadarPlans>,
  planByTask: Map<string, string>,
) {
  for (const plan of plans)
    addBaseEdge(
      builder,
      `association:plan:${plan.id}:${stableToken(plan.ownerSessionID)}`,
      "association",
      `plan:${plan.id}`,
      sessionNodeID(plan.ownerSessionID),
      "plan-owner",
      { planID: plan.id, evidence: runnerRecordEvidence(plan.id) },
    )
  for (const task of source.tasks) {
    const submitter = task.provenance.sessionID
    addBaseEdge(
      builder,
      `association:task:${task.id}:${stableToken(submitter)}`,
      "association",
      `task:${task.id}`,
      sessionNodeID(submitter),
      "task-submitter",
      {
        planID: planByTask.get(task.id) ?? null,
        taskID: task.id,
        evidence: runnerRecordEvidence(task.id),
      },
    )
  }
  for (const dependency of source.dependencies)
    addBaseEdge(
      builder,
      `dependency:${dependency.plan_id}:${dependency.prerequisite}:${dependency.successor}`,
      "dependency",
      `task:${dependency.prerequisite}`,
      `task:${dependency.successor}`,
      "dependency",
      {
        planID: dependency.plan_id,
        taskID: dependency.successor,
        evidence: runnerRecordEvidence(dependency.plan_id),
      },
    )
}

function effectsByAttemptID(effects: RadarEffectRecord[]) {
  const byAttempt = new Map<string, RadarEffectRecord[]>()
  for (const effect of effects) {
    if (!effect.attempt_id) continue
    const values = byAttempt.get(effect.attempt_id) ?? []
    values.push(effect)
    byAttempt.set(effect.attempt_id, values)
  }
  return byAttempt
}

function addAssignmentEdge(
  builder: RadarEdgeBuilder,
  attempt: RadarAttemptRecord,
  sessionEffect: RadarEffectRecord | undefined,
  sessionTransitions: TransitionRecord[],
) {
  addBaseEdge(
    builder,
    `assignment:${attempt.id}`,
    "assignment",
    `plan:${attempt.plan_id}`,
    sessionNodeID(attempt.session_id),
    sessionEffect?.state ?? "reserved",
    {
      planID: attempt.plan_id,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      startedAt: attempt.started_at,
      observedAt: sessionTransitions.at(-1)?.created_at ?? null,
      evidence: [
        {
          source: "runner-record" as const,
          recordID: attempt.id,
          messageID: attempt.message_id,
          callID: null,
          at: attempt.started_at,
        },
        ...sessionTransitions.map((row) =>
          transitionEvidence(builder.stats, row, transitionPayload(row)),
        ),
      ].slice(-100),
    },
  )
}

function addPromptEdge(
  builder: RadarEdgeBuilder,
  attempt: RadarAttemptRecord,
  plan: RadarPlanRecord,
  promptEffect: RadarEffectRecord,
  promptTransitions: TransitionRecord[],
) {
  const { stats } = builder
  const effectPayload = jsonObject(promptEffect.payload) ?? {}
  const messageID =
    typeof effectPayload.messageID === "string" ? effectPayload.messageID : attempt.message_id
  const stage =
    promptEffect.state === "intended"
      ? "persisted"
      : promptEffect.state === "completed"
        ? "admitted"
        : "unknown"
  addBaseEdge(
    builder,
    `prompt:${promptEffect.id}`,
    "prompt",
    sessionNodeID(plan.owner),
    sessionNodeID(attempt.session_id),
    promptEffect.state,
    {
      deliveryStage: stage,
      planID: attempt.plan_id,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      messageID: safeText(messageID, stats, 200),
      startedAt: promptTransitions[0]?.created_at ?? null,
      observedAt: promptTransitions.at(-1)?.created_at ?? null,
      evidence: promptTransitions
        .map((row) =>
          transitionEvidence(stats, row, transitionPayload(row), safeText(messageID, stats, 200)),
        )
        .slice(-100),
    },
  )
}

function addAttemptEdges(
  builder: RadarEdgeBuilder,
  source: RadarSource,
  transitions: RadarTransitionIndex,
) {
  const plansByID = new Map(source.radarPlans.map((plan) => [plan.id, plan]))
  const effectsByAttempt = effectsByAttemptID(source.radarEffects)
  for (const attempt of source.radarAttempts) {
    const plan = plansByID.get(attempt.plan_id)
    const effects = effectsByAttempt.get(attempt.id) ?? []
    const sessionEffect = effects.find((effect) => effect.kind === "session")
    const promptEffect = effects.find((effect) => effect.kind === "prompt")
    const transitionsFor = (effectID: string | undefined) =>
      effectID ? (transitions.byEffectID.get(effectID) ?? []) : []
    addAssignmentEdge(builder, attempt, sessionEffect, transitionsFor(sessionEffect?.id))
    if (promptEffect && plan)
      addPromptEdge(builder, attempt, plan, promptEffect, transitionsFor(promptEffect.id))
  }
}

function outboxDeliveryStage(state: string): RadarDeliveryStage {
  return state === "pending"
    ? "persisted"
    : state === "admitted" || state === "delivered"
      ? "admitted"
      : state === "consumed"
        ? "consumed"
        : state === "rejected"
          ? "rejected"
          : state === "superseded"
            ? "superseded"
            : "unknown"
}

function addOutboxEdges(
  builder: RadarEdgeBuilder,
  source: RadarSource,
  transitions: RadarTransitionIndex,
) {
  for (const outbox of source.outbox) {
    const transitionRows = transitions.byOutboxID.get(outbox.id) ?? []
    const stage = outboxDeliveryStage(outbox.state)
    const evidence = transitionRows.map((row) =>
      transitionEvidence(builder.stats, row, transitionPayload(row), outbox.message_id),
    )
    if (!evidence.length)
      evidence.push({
        source: "runner-record",
        recordID: outbox.id,
        messageID: outbox.message_id,
        callID: null,
        at: null,
      })
    addBaseEdge(
      builder,
      `outcome:${outbox.id}`,
      "outcome",
      "component:runner-runtime",
      sessionNodeID(outbox.session_id),
      outbox.state,
      {
        deliveryStage: stage,
        planID: outbox.plan_id,
        messageID: safeText(outbox.message_id, builder.stats, 200),
        startedAt: transitionRows[0]?.created_at ?? null,
        observedAt: transitionRows.at(-1)?.created_at ?? null,
        evidence: evidence.slice(-100),
      },
    )
  }
}

type RadarStepStart = { routeID: string; startedAt: number | null; agentID: string | null }
type RadarStepContext = {
  builder: RadarEdgeBuilder
  routeSink: RadarRouteSink
  liveEventIDs: ReadonlySet<string>
  stepStarts: Map<string, RadarStepStart>
}
type RadarStepEvent = {
  row: ProgressRow
  observation: JsonObject
  eventID: string
  messageID: string
  eventType: string
  at: number
}

function orderedStepObservations(progress: ProgressRow[]) {
  const stepObservations = progress.flatMap((row) => {
    if (row.kind !== "step") return []
    const fact = projectProgressFact(row)
    const observations = fact.observations
    if (!Array.isArray(observations)) return []
    return observations.flatMap((rawObservation, index) => {
      const observation = object(rawObservation)
      const at = observation?.at
      if (observation?.source !== "native-event" || typeof at !== "number" || !Number.isFinite(at))
        return []
      return [{ row, messageID: fact.messageID, observation, index, at }]
    })
  })
  stepObservations.sort(
    (left, right) => left.at - right.at || left.row.seq - right.row.seq || left.index - right.index,
  )
  return stepObservations
}

function stepEventOf(
  entry: ReturnType<typeof orderedStepObservations>[number],
): RadarStepEvent | null {
  const { row, messageID, observation, at } = entry
  if (
    typeof observation.eventID !== "string" ||
    !observation.eventID ||
    typeof observation.messageID !== "string" ||
    !observation.messageID ||
    observation.messageID !== messageID ||
    !["session.step.started", "session.step.ended", "session.step.failed"].includes(
      String(observation.eventType),
    )
  )
    return null
  return {
    row,
    observation,
    eventID: observation.eventID,
    messageID: observation.messageID,
    eventType: String(observation.eventType),
    at,
  }
}

function addStepStartEdge(step: RadarStepContext, event: RadarStepEvent, key: string) {
  const { builder } = step
  const { row, observation, eventID, messageID, at } = event
  const route = object(observation.route)
  if (
    !route ||
    typeof route.providerID !== "string" ||
    !route.providerID ||
    typeof route.modelID !== "string" ||
    !route.modelID
  )
    return
  const routeID = addRoute(step.routeSink, {
    id: `route:step:${stableToken(eventID)}`,
    providerID: route.providerID,
    modelID: route.modelID,
    variant: typeof route.variant === "string" ? route.variant : null,
    source: "step-event",
    sessionID: row.session_id,
    attemptID: row.attempt_id,
    messageID,
    eventID,
    observedAt: at,
  })
  if (!routeID) return
  const agentID =
    typeof observation.agent === "string" ? safeText(observation.agent, builder.stats, 200) : null
  const recordedStartedAt = observation.startedAt
  const startedAt =
    typeof recordedStartedAt === "number" && Number.isFinite(recordedStartedAt)
      ? recordedStartedAt
      : at
  step.stepStarts.set(key, { routeID, startedAt, agentID })
  addBaseEdge(
    builder,
    `model-request:${stableToken(eventID)}`,
    "model-request",
    sessionNodeID(row.session_id),
    routeID,
    "started",
    {
      planID: row.plan_id,
      taskID: row.task_id,
      attemptID: row.attempt_id,
      agentID,
      messageID,
      routeID,
      startedAt,
      observedAt: at,
      live: step.liveEventIDs.has(eventID),
      evidence: [
        eventEvidence(builder.stats, eventID, event.eventType, row.session_id, messageID, null, at),
      ],
    },
  )
}

function addStepEndEdge(step: RadarStepContext, event: RadarStepEvent, key: string) {
  const started = step.stepStarts.get(key)
  if (!started) return
  const { row, eventID, messageID, at } = event
  const failed = event.eventType === "session.step.failed"
  addBaseEdge(
    step.builder,
    `model-response:${stableToken(eventID)}`,
    "model-response",
    started.routeID,
    sessionNodeID(row.session_id),
    failed ? "failed" : "ended",
    {
      planID: row.plan_id,
      taskID: row.task_id,
      attemptID: row.attempt_id,
      agentID: started.agentID,
      messageID,
      routeID: started.routeID,
      startedAt: started.startedAt,
      observedAt: at,
      live: step.liveEventIDs.has(eventID),
      evidence: [
        eventEvidence(
          step.builder.stats,
          eventID,
          event.eventType,
          row.session_id,
          messageID,
          null,
          at,
        ),
      ],
    },
  )
}

function addStepEdges(
  builder: RadarEdgeBuilder,
  routeSink: RadarRouteSink,
  progress: ProgressRow[],
  liveEventIDs: ReadonlySet<string>,
) {
  const step: RadarStepContext = {
    builder,
    routeSink,
    liveEventIDs,
    stepStarts: new Map<string, RadarStepStart>(),
  }
  for (const entry of orderedStepObservations(progress)) {
    const event = stepEventOf(entry)
    if (!event) continue
    const key = `${event.row.session_id}\u0000${event.messageID}`
    if (event.eventType === "session.step.started") addStepStartEdge(step, event, key)
    else addStepEndEdge(step, event, key)
  }
}

type RadarToolEventType = "session.tool.called" | "session.tool.success" | "session.tool.failed"

function orderedToolObservations(observations: unknown[]) {
  return observations
    .flatMap((rawObservation, index) => {
      const observation = object(rawObservation)
      if (
        observation?.source !== "native-event" ||
        typeof observation.at !== "number" ||
        !Number.isFinite(observation.at)
      )
        return []
      return [{ observation, index, at: observation.at }]
    })
    .sort((left, right) => left.at - right.at || left.index - right.index)
}

function toolEventOf(
  observation: JsonObject,
  callID: string,
): { eventID: string; eventType: RadarToolEventType } | null {
  if (
    typeof observation.eventID !== "string" ||
    !observation.eventID ||
    observation.callID !== callID ||
    (observation.eventType !== "session.tool.called" &&
      observation.eventType !== "session.tool.success" &&
      observation.eventType !== "session.tool.failed")
  )
    return null
  return { eventID: observation.eventID, eventType: observation.eventType }
}

function addToolFlowEdge(
  builder: RadarEdgeBuilder,
  liveEventIDs: ReadonlySet<string>,
  row: ProgressRow,
  toolID: string,
  observation: JsonObject,
  event: { eventID: string; eventType: RadarToolEventType },
  at: number,
) {
  const { stats } = builder
  if (!row.call_id) return
  const isCall = event.eventType === "session.tool.called"
  const evidence = eventEvidence(
    stats,
    event.eventID,
    event.eventType,
    row.session_id,
    row.message_id ? safeText(row.message_id, stats, 200) : null,
    safeText(row.call_id, stats, 200),
    at,
  )
  addBaseEdge(
    builder,
    `tool-flow:${stableToken(event.eventID)}`,
    isCall ? "tool-call" : "tool-result",
    isCall ? sessionNodeID(row.session_id) : toolID,
    isCall ? toolID : sessionNodeID(row.session_id),
    typeof observation.status === "string" ? observation.status : "observed",
    {
      planID: row.plan_id,
      taskID: row.task_id,
      attemptID: row.attempt_id,
      messageID: row.message_id ? safeText(row.message_id, stats, 200) : null,
      callID: safeText(row.call_id, stats, 200),
      observedAt: at,
      live: liveEventIDs.has(event.eventID),
      evidence: [evidence],
    },
  )
}

function addToolEdges(
  builder: RadarEdgeBuilder,
  progress: ProgressRow[],
  liveEventIDs: ReadonlySet<string>,
) {
  const tools = new Map<string, { id: string; name: string }>()
  for (const row of progress) {
    if (row.kind !== "tool") continue
    const fact = projectProgressFact(row)
    const observations = Array.isArray(fact.observations) ? fact.observations : []
    const name = typeof fact.tool === "string" ? fact.tool : ""
    const callID = typeof fact.callID === "string" ? fact.callID : ""
    if (!name || !row.call_id || !callID) continue
    const toolID = `tool:${stableToken(name)}`
    tools.set(toolID, { id: toolID, name })
    for (const { observation, at } of orderedToolObservations(observations)) {
      const event = toolEventOf(observation, callID)
      if (!event) continue
      addToolFlowEdge(builder, liveEventIDs, row, toolID, observation, event, at)
    }
  }
  return tools
}

function reminderDeliveryStage(delivery: string): RadarDeliveryStage {
  return delivery === "dispatching"
    ? "persisted"
    : delivery === "admitted"
      ? "admitted"
      : delivery === "rejected"
        ? "rejected"
        : "unknown"
}

function addReminderEdges(
  builder: RadarEdgeBuilder,
  progress: ProgressRow[],
  liveEventIDs: ReadonlySet<string>,
) {
  const { stats } = builder
  for (const row of progress) {
    if (row.kind !== "reminder") continue
    const fact = projectProgressFact(row)
    const delivery = typeof fact.delivery === "string" ? fact.delivery : "unknown"
    const stage = reminderDeliveryStage(delivery)
    const eventID = typeof fact.nativeEventID === "string" ? fact.nativeEventID : null
    const observed = typeof fact.observedAt === "number" ? fact.observedAt : null
    const evidence: RadarEdge["evidence"] = [progressEvidence(stats, row, observed ?? row.at)]
    if (eventID && observed !== null)
      evidence.push(
        eventEvidence(
          stats,
          eventID,
          "session.synthetic",
          row.session_id,
          row.message_id,
          null,
          observed,
        ),
      )
    addBaseEdge(
      builder,
      `reminder:${row.attempt_id}`,
      "prompt",
      "component:progress-recorder",
      sessionNodeID(row.session_id),
      delivery,
      {
        planID: row.plan_id,
        taskID: row.task_id,
        attemptID: row.attempt_id,
        messageID: row.message_id ? safeText(row.message_id, stats, 200) : null,
        startedAt: row.at,
        observedAt: observed,
        live: Boolean(eventID && liveEventIDs.has(eventID)),
        deliveryStage: stage,
        evidence: evidence.slice(0, 100),
      },
    )
  }
}

function addSessionEdges(
  builder: RadarEdgeBuilder,
  sessions: RadarResponse["sessions"],
  observedAt: number,
) {
  for (const session of sessions) {
    if (session.parentSessionID)
      addBaseEdge(
        builder,
        `ancestry:${stableToken(session.parentSessionID)}:${stableToken(session.sessionID)}`,
        "ancestry",
        sessionNodeID(session.parentSessionID),
        session.id,
        "native-parent",
        {
          observedAt,
          evidence: [{ source: "native-read", sessionID: session.sessionID, at: observedAt }],
        },
      )
    if (session.availability === "available")
      addBaseEdge(
        builder,
        `observation:${session.sessionID}`,
        "observation",
        "component:observability",
        session.id,
        "metadata-read",
        {
          observedAt,
          evidence: [{ source: "native-read", sessionID: session.sessionID, at: observedAt }],
        },
      )
  }
}

export class ObservationReadChangedError extends Error {
  constructor(readonly source: "native" | "runner") {
    super(
      `${source === "native" ? "Native" : "Runner"} observation changed while reading; retry the radar projection`,
    )
    this.name = "ObservationReadChangedError"
  }
}

export type UnitReads = {
  reads: ObservationReads
  tracker: ObservationChangeTracker
  release(): void
}

const unavailable = () =>
  Promise.reject(new Error("Native sessions of this project are not loaded here"))
/** Native reads for a checkout that belongs to another OpenCode location: every call fails. */
const UNAVAILABLE_SESSION_HOST: RadarSessionHost = {
  get: unavailable,
  project: unavailable,
  descendants: unavailable,
}
const UNAVAILABLE_TRAJECTORY_HOST: TrajectoryHost = { session: unavailable, status: unavailable }

/** The OpenCode project id recorded for a LAZERS project, when one is. */
function opencodeProjectIDFor(repository: TaskRepository, key: string): string | undefined {
  return repository.read(
    (db) =>
      db
        .query<{ alias: string }, [string]>(
          "SELECT alias FROM lazers_project_aliases WHERE key=? AND kind='opencode-project-id' ORDER BY first_seen_at LIMIT 1",
        )
        .get(key)?.alias,
  )
}

export class ObservationReads {
  private readonly machine = machineDefinition()
  private readonly validTransitions = stateTransitionSet()
  private readonly history: TrajectoryHistoryCache
  private readonly live: TrajectoryLiveCache
  private readonly liveRadarReader: LiveRadarReader

  constructor(
    readonly store: RunnerStore,
    private readonly host: TrajectoryHost,
    private readonly projectID: string,
    readonly secret: Uint8Array,
    private readonly nativeSessions?: RadarSessionHost,
    private readonly taskValuationProvider?: TaskValuationProvider,
    /** `historyCacheMB` plugin option, in bytes. */
    historyCacheLimitBytes?: number,
    /** Caches of the reads this one was derived from, so a continuation cursor survives. */
    shared?: { history: TrajectoryHistoryCache; live: TrajectoryLiveCache },
  ) {
    this.history =
      shared?.history ??
      new TrajectoryHistoryCache(
        secret,
        historyCacheLimitBytes === undefined ? {} : { maxBytes: historyCacheLimitBytes },
      )
    this.live =
      shared?.live ??
      new TrajectoryLiveCache(
        historyCacheLimitBytes === undefined ? {} : { maxBytes: historyCacheLimitBytes },
      )
    this.liveRadarReader = new LiveRadarReader(store, nativeSessions, projectID, secret)
  }

  liveRadar(
    input: LiveRadarRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    streamEpoch: string,
  ) {
    singleScope(input.scope)
    return this.liveRadarReader.radar(input, tracker, signal, streamEpoch)
  }

  liveGroup(input: LiveGroupRequestInput, signal: AbortSignal) {
    singleScope(input.scope)
    return this.liveRadarReader.group(input, signal)
  }

  liveAttempt(input: LiveAttemptRequestInput, signal: AbortSignal) {
    singleScope(input.scope)
    return this.liveRadarReader.attempt(input, signal)
  }

  async radar(
    input: RadarRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
  ): Promise<RadarResponse> {
    if (!this.nativeSessions) throw new Error("Native session inventory is unavailable")
    const request = RadarInput.parse(input)
    const scope = singleScope(request.scope)
    const includeUnmanagedSessions = request.includeUnmanagedSessions
    signal.throwIfAborted()
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      let source = connection.store.read((db) =>
        loadRadarSource(db, this.store.repository.projectDirectory, scope, this.secret),
      )
      const nativeRevision = tracker.nativeRevision
      const context = newRadarSessionContext()
      if (scope.kind === "session") addContext(context.reasons, scope.sessionID, "scope-anchor")

      const reader: RadarNativeReader = {
        host: this.nativeSessions,
        projectID: this.projectID,
        signal,
      }
      const native = newRadarNativeResolution()
      if (includeUnmanagedSessions) await readNativeInventory(reader, scope, native, context)
      if (scope.kind === "session")
        await resolveScopeAncestry(reader, scope.sessionID, native, context)

      if (scope.kind === "session" && native.scopeAncestryIDs.size > 1) {
        source = connection.store.read((db) =>
          loadRadarSource(
            db,
            this.store.repository.projectDirectory,
            scope,
            this.secret,
            native.scopeAncestryIDs,
          ),
        )
      }
      recordSourceSessionContext(source, context)

      const { requestedIDs, selectedIDs } = selectRadarSessionIDs(scope, source, native)
      if (requestedIDs.size > selectedIDs.length) {
        native.inventoryTruncated = true
        native.nativeInventory =
          native.nativeInventory === "unavailable" ? "unavailable" : "bounded"
      }
      const selectedSet = new Set(selectedIDs)
      await resolveSelectedSessions(reader, selectedIDs, native)
      if (native.ancestryTruncated && native.nativeInventory !== "unavailable")
        native.nativeInventory = "bounded"
      tracker.trackScopedSessions(selectedIDs)

      const observedAt = Date.now()
      const stats = privacyStats()
      const routeSink: RadarRouteSink = { routes: [], routeIDs: new Set(), truncated: false }
      const { configuredByAttempt, configuredBySession } = addConfiguredRoutes(
        routeSink,
        stats,
        source,
      )
      const sessions = buildRadarSessions({
        projectID: this.projectID,
        selectedIDs,
        selectedSet,
        native,
        context,
        routeSink,
        stats,
        observedAt,
        configuredBySession,
      })

      const builder: RadarEdgeBuilder = { edges: [], edgeIDs: new Set(), truncated: false, stats }
      const components = radarComponents()
      addArchitectureEdges(builder)
      const transitions = indexTransitions(source.transitions)
      const plans = summarizeRadarPlans(source, stats)
      const planByTask = planIDByTask(source)
      const tasks = summarizeRadarTasks(source, planByTask)
      const attempts = summarizeRadarAttempts(source, stats, configuredByAttempt)
      addAssociationEdges(builder, source, plans, planByTask)
      const liveEventIDs = tracker.peekLiveEvents(selectedSet)
      addAttemptEdges(builder, source, transitions)
      addOutboxEdges(builder, source, transitions)
      addStepEdges(builder, routeSink, source.progress, liveEventIDs)
      const tools = addToolEdges(builder, source.progress, liveEventIDs)
      addReminderEdges(builder, source.progress, liveEventIDs)
      addSessionEdges(builder, sessions, observedAt)

      if (tracker.nativeRevision !== nativeRevision) throw new ObservationReadChangedError("native")
      const latest = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(latest)
      if (
        source.stamp.repositoryVersion !== latest.repositoryVersion ||
        source.stamp.sourceFingerprint !== latest.sourceFingerprint
      )
        throw new ObservationReadChangedError("runner")
      const boundary = tracker.boundary(latest, source.transitions.at(-1)?.id ?? 0)
      tracker.takeLiveEvents(selectedSet)
      return RadarOutput.parse({
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(scope),
        observedAt: new Date(observedAt).toISOString(),
        boundary,
        freshness: {
          runner: "current",
          nativeInventory: native.nativeInventory,
          nativeEvents: tracker.hasConnectedEventStream ? "connected" : "gap-or-unavailable",
        },
        coverage: {
          sessionCount: sessions.length,
          managedSessionCount: sessions.filter((session) => session.classification !== "unmanaged")
            .length,
          includeUnmanagedSessions,
          inventoryTruncated: native.inventoryTruncated || native.ancestryTruncated,
          workTruncated:
            source.workTruncated ||
            source.tasks.length > 1000 ||
            selectedIDs.length < requestedIDs.size,
          progressTruncated: source.progressTruncated,
          routeTruncated: routeSink.truncated,
          toolTruncated: tools.size > 200,
          edgeTruncated: builder.truncated,
        },
        components,
        sessions,
        routes: routeSink.routes,
        tools: [...tools.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, 200),
        plans,
        tasks,
        attempts,
        edges: builder.edges,
      })
    } finally {
      connection.close()
    }
  }

  topology(scope: SingleScope, tracker: ObservationChangeTracker): TopologyResponse {
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const source = connection.store.read((db) =>
        loadTopologySource(db, this.store.repository.projectDirectory, scope, this.secret),
      )
      const topology = projectTopology(source)
      const latest = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      if (
        source.stamp.repositoryVersion !== latest.repositoryVersion ||
        source.stamp.sourceFingerprint !== latest.sourceFingerprint
      )
        throw new Error("Observation changed while reading; restart from a fresh snapshot")
      tracker.observeStamp(latest)
      // Current topology has no historical cutoff and does not claim to cover transitions.
      const { transitionSequence: _transitionSequence, ...boundary } = tracker.boundary(latest, 0)
      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(scope),
        observedAt: new Date().toISOString(),
        boundary,
        ...topology,
      }
    } finally {
      connection.close()
    }
  }

  /**
   * The reads of one checkout of one project. The caller's own checkout is this object with the
   * caller's tracker. Any other checkout gets reads of its own whose native host and session
   * inventory are unavailable (those belong to another OpenCode location), so every live field of
   * such a project reads as unavailable and nothing is invented. `release` closes what was opened.
   */
  forUnit(unit: ProjectUnit, ownTracker: ObservationChangeTracker): UnitReads {
    const directory = this.store.repository.projectDirectory
    if (canonicalPath(unit.directory) === canonicalPath(directory))
      return { reads: this, tracker: ownTracker, release() {} }
    const repository = new ReadOnlyTaskRepository(this.store.repository.path, unit.directory)
    const store = RunnerStore.readOnly(repository)
    const projectID = opencodeProjectIDFor(repository, unit.project.key) ?? unit.project.key
    const reads = new ObservationReads(
      store,
      UNAVAILABLE_TRAJECTORY_HOST,
      projectID,
      this.secret,
      UNAVAILABLE_SESSION_HOST,
      this.taskValuationProvider,
      undefined,
      { history: this.history, live: this.live },
    )
    const tracker = new ObservationChangeTracker(repository, this.secret, projectID)
    return {
      reads,
      tracker,
      release() {
        tracker.close()
        repository.close()
      },
    }
  }

  /**
   * One page of an all-projects read: the first readable checkout at or after the cursor, read
   * with that checkout's own project-scope read, marked with its project and the next cursor.
   * Nothing is read for a checkout the caller may not see.
   */
  /** The OpenCode project id this reader's rows are labelled with. */
  get projectIdentity() {
    return this.projectID
  }

  /** One read at one checkout with that checkout's project-scope reads, marked with its project. */
  async atUnit<T extends object>(
    unit: ProjectUnit,
    sessionID: string,
    ownTracker: ObservationChangeTracker,
    read: (unit: UnitReads, scope: { kind: "project"; sessionID: string }) => T | Promise<T>,
  ): Promise<Omit<T, "scope"> & { project: ProjectRef }> {
    const reads = this.forUnit(unit, ownTracker)
    try {
      const page = await read(reads, { kind: "project", sessionID })
      const { scope: _scope, ...rest } = page as T & { scope?: unknown }
      return {
        ...rest,
        // Outputs that name their scope say `all`; the others (a group read) have none to rewrite.
        ...("scope" in page ? { scope: { kind: "all" as const } } : {}),
        project: unit.project,
      } as unknown as Omit<T, "scope"> & { project: ProjectRef }
    } finally {
      reads.release()
    }
  }

  async allPage<T extends object>(
    input: { scope: { kind: "all"; sessionID: string }; cursor?: string },
    ownTracker: ObservationChangeTracker,
    access: UnitAccess,
    read: (unit: UnitReads, scope: { kind: "project"; sessionID: string }) => T | Promise<T>,
  ): Promise<Omit<T, "scope"> & { project: ProjectRef; nextCursor: string | null }> {
    const picked = await pickUnit(access.units, input.cursor)
    if (!picked) throw new Error("No project is readable in this scope")
    const page = await this.atUnit(picked.unit, input.scope.sessionID, ownTracker, read)
    return { ...page, nextCursor: picked.nextCursor }
  }

  /** The unit owning what an all-projects read names, or a refusal when nothing does. */
  private ownerOf(query: OwnerQuery, access: UnitAccess, unavailable: string) {
    const owner = findOwner(this.store.repository, access.units, query)
    if (!owner) throw new Error(unavailable)
    return owner
  }

  async trajectoryAll(
    input: TrajectoryRequest,
    tracker: ObservationChangeTracker,
    signal: AbortSignal | undefined,
    access: UnitAccess,
  ): Promise<TrajectoryResponse> {
    if (input.scope.kind !== "all") throw new Error("Not an all-projects read")
    const query: OwnerQuery = input.reference
      ? { reference: input.reference }
      : input.taskID
        ? { taskID: input.taskID }
        : { attemptID: input.attemptID! }
    const owner = this.ownerOf(query, access, "No observation in this scope")
    return this.atUnit(owner.unit, input.scope.sessionID, tracker, (unit, scope) => {
      const taskID = owner.taskID ?? input.taskID
      const { reference: _reference, ...rest } = input
      return unit.reads.trajectory(
        { ...rest, scope, ...(taskID ? { taskID } : {}) },
        unit.tracker,
        signal,
      )
    }) as Promise<TrajectoryResponse>
  }

  async trajectoryHistoryAll(
    input: TrajectoryHistoryRequest,
    tracker: ObservationChangeTracker,
    signal: AbortSignal | undefined,
    access: UnitAccess,
  ): Promise<TrajectoryHistoryResponse> {
    if (input.scope.kind !== "all") throw new Error("Not an all-projects read")
    const owner = this.ownerOf({ taskID: input.taskID }, access, "No observation in this scope")
    return this.atUnit(owner.unit, input.scope.sessionID, tracker, (unit, scope) =>
      unit.reads.trajectoryHistory({ ...input, scope }, unit.tracker, signal),
    ) as Promise<TrajectoryHistoryResponse>
  }

  async trajectoryStatusAll(
    input: TrajectoryStatusRequest,
    tracker: ObservationChangeTracker,
    access: UnitAccess,
  ): Promise<TrajectoryResponse> {
    if (input.scope.kind !== "all") throw new Error("Not an all-projects read")
    const owner = this.ownerOf({ taskID: input.taskID }, access, "No observation in this scope")
    return this.atUnit(owner.unit, input.scope.sessionID, tracker, (unit, scope) =>
      unit.reads.trajectoryStatus({ ...input, scope }, unit.tracker),
    ) as Promise<TrajectoryResponse>
  }

  /** The attempt of a session of any readable project: the worker pane's counts and lane. */
  async liveAttemptAll(
    input: LiveAttemptRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    access: UnitAccess,
  ): Promise<LiveAttemptResponse> {
    if (input.scope.kind !== "all") throw new Error("Not an all-projects read")
    const owner = this.ownerOf(
      { sessionID: input.sessionID },
      access,
      "Observation scope is unavailable",
    )
    return this.atUnit(owner.unit, input.scope.sessionID, tracker, (unit, scope) =>
      unit.reads.liveAttempt({ ...input, scope }, signal),
    ) as Promise<LiveAttemptResponse>
  }

  async snapshotAll(
    input: { scope: { kind: "all"; sessionID: string }; cursor?: string },
    tracker: ObservationChangeTracker,
    access: UnitAccess,
    signal?: AbortSignal,
  ): Promise<SnapshotResponse> {
    const page = await this.allPage(input, tracker, access, (unit, scope) =>
      unit.reads.snapshot(scope, unit.tracker, signal),
    )
    return {
      ...page,
      scope: { kind: "all" },
      plans: page.plans.map((plan) => ({ ...plan, project: page.project })),
      unplannedTasks: page.unplannedTasks.map((task) => ({ ...task, project: page.project })),
    }
  }

  async radarAll(
    input: {
      scope: { kind: "all"; sessionID: string }
      includeUnmanagedSessions: boolean
      cursor?: string
    },
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    access: UnitAccess,
  ): Promise<RadarResponse> {
    const page = await this.allPage(input, tracker, access, (unit, scope) =>
      unit.reads.radar(
        { scope, includeUnmanagedSessions: input.includeUnmanagedSessions },
        unit.tracker,
        signal,
      ),
    )
    return { ...page, scope: { kind: "all" } }
  }

  async liveRadarAll(
    input: {
      scope: { kind: "all"; sessionID: string }
      includeUnmanagedSessions: boolean
      cursor?: string
    },
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    access: UnitAccess,
  ): Promise<LiveRadarResponse> {
    const page = await this.allPage(input, tracker, access, async (unit, scope) =>
      unit.reads.liveRadar(
        { scope, includeUnmanagedSessions: input.includeUnmanagedSessions },
        unit.tracker,
        signal,
        unit.tracker.streamEpoch,
      ),
    )
    return { ...page, scope: { kind: "all" } }
  }

  async liveGroupAll(
    input: {
      scope: { kind: "all"; sessionID: string }
      group: "needs-you" | "failed" | "queued"
      cursor?: string
    },
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    access: UnitAccess,
  ): Promise<LiveGroupResponse> {
    return this.allPage(input, tracker, access, async (unit, scope) =>
      unit.reads.liveGroup({ scope, group: input.group }, signal),
    )
  }

  async topologyAll(
    input: { scope: { kind: "all"; sessionID: string }; cursor?: string },
    tracker: ObservationChangeTracker,
    access: UnitAccess,
  ): Promise<TopologyResponse> {
    const page = await this.allPage(input, tracker, access, (unit, scope) =>
      unit.reads.topology(scope, unit.tracker),
    )
    return {
      ...page,
      scope: { kind: "all" },
      plans: page.plans.map((plan) => ({ ...plan, project: page.project })),
      unplannedTasks: page.unplannedTasks.map((task) => ({ ...task, project: page.project })),
    }
  }

  snapshot(
    requested: ObservationScope,
    tracker: ObservationChangeTracker,
    signal?: AbortSignal,
  ): SnapshotResponse {
    const scope = singleScope(requested)
    signal?.throwIfAborted()
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const projection = connection.store.read((db) =>
        loadProjectionSource(
          db,
          this.store.repository.projectDirectory,
          scope,
          this.secret,
          [],
          signal,
        ),
      )
      const visibleTaskIDs = new Set(projection.tasks.map((task) => task.id))
      const stats = privacyStats()
      const { plans, unplannedTasks } = projectTopology(projection)

      const attemptIDs = new Set(projection.attempts.map((attempt) => attempt.id))
      const attempts = projection.attempts
        .filter((attempt) => visibleTaskIDs.has(attempt.task_id))
        .map((attempt) => ({
          id: attempt.id,
          planID: attempt.plan_id,
          taskID: attempt.task_id,
          number: attempt.number,
          state: safeText(attempt.state, stats, 80),
          startedAt: attempt.started_at,
          endedAt: null,
          timingBasis:
            "runner_attempt.started_at is dispatch reservation; attempt end is unavailable",
          executions: recordedExecutions(attempt, projection.transitions),
        }))
      const checks = projection.checks
        .filter(
          (check) =>
            (check.task_id === null || visibleTaskIDs.has(check.task_id)) &&
            (check.attempt_id === null || attemptIDs.has(check.attempt_id)),
        )
        .map((check) => ({
          id: check.id,
          planID: check.plan_id,
          taskID: check.task_id,
          attemptID: check.attempt_id,
          checkID: safeText(check.kind.slice(check.kind.indexOf(":") + 1), stats, 120),
          scope: check.attempt_id === null ? ("plan" as const) : ("attempt" as const),
          state: safeText(check.state, stats, 80),
          startedAt: finiteTime(check.started_at),
          endedAt: finiteTime(check.ended_at),
          exitCode: finiteTime(check.exit_code),
          timingBasis:
            "Verification receipt check.startedAt/check.endedAt; absent endpoints remain unknown",
        }))
      const transitions = projection.transitions.map((row) => {
        const payload = jsonObject(row.payload)
        const from = TaskState.safeParse(payload?.from)
        const to = TaskState.safeParse(payload?.to)
        const machine =
          row.task_id !== null &&
          from.success &&
          to.success &&
          this.validTransitions.has(`${from.data}\u0000${row.event}\u0000${to.data}`)
        const attemptID =
          typeof payload?.attemptID === "string" && attemptIDs.has(payload.attemptID)
            ? payload.attemptID
            : null
        return {
          sequence: row.id,
          planID: row.plan_id,
          taskID: row.task_id && visibleTaskIDs.has(row.task_id) ? row.task_id : null,
          attemptID,
          planVersion: row.version,
          kind: machine ? ("machine" as const) : ("runtime" as const),
          event: safeText(row.event, stats, 120),
          from: machine ? from.data : null,
          to: machine ? to.data : null,
          reason: typeof payload?.reason === "string" ? safeText(payload.reason, stats) : null,
          recordedAt: row.created_at,
        }
      })
      signal?.throwIfAborted()
      const latest = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      if (
        projection.stamp.repositoryVersion !== latest.repositoryVersion ||
        projection.stamp.sourceFingerprint !== latest.sourceFingerprint
      )
        throw new Error("Observation changed while reading; restart from a fresh snapshot")
      tracker.observeStamp(latest)
      const lastTransition = transitions.at(-1)?.sequence ?? 0
      const boundary = tracker.boundary(latest, lastTransition)
      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(scope),
        observedAt: new Date().toISOString(),
        boundary,
        machine: this.machine,
        plans,
        unplannedTasks,
        transitions,
        attempts,
        checks,
        coverage: { ...projection.historyCoverage, workTruncated: projection.historyTruncated },
      }
    } finally {
      connection.close()
    }
  }

  async trajectory(
    input: TrajectoryRequest,
    tracker: ObservationChangeTracker,
    signal?: AbortSignal,
  ): Promise<TrajectoryResponse> {
    const scope = singleScope(input.scope)
    signal?.throwIfAborted()
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const before = connection.store.read((db) =>
        loadTaskObservationSource(db, this.store.repository.projectDirectory, scope, this.secret, {
          taskID: input.taskID,
          attemptID: input.attemptID,
        }),
      )
      tracker.observeStamp(before.stamp)
      const nativeRevision = tracker.nativeRevision
      const report = await inspectTrajectory(
        connection.store,
        this.host,
        this.projectID,
        {
          ...(input.taskID ? { taskID: input.taskID } : { attemptID: input.attemptID! }),
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        this.secret,
        { taskValuationProvider: this.taskValuationProvider, signal },
      )
      signal?.throwIfAborted()
      const after = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        before.stamp.repositoryVersion !== after.repositoryVersion ||
        before.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while reading; restart from a fresh snapshot")
      signal?.throwIfAborted()
      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(scope),
        boundary: tracker.boundary(after, before.transitionSequence),
        report,
      }
    } finally {
      connection.close()
    }
  }

  async trajectoryHistory(
    input: TrajectoryHistoryRequest,
    tracker: ObservationChangeTracker,
    signal?: AbortSignal,
  ): Promise<TrajectoryHistoryResponse> {
    const scope = singleScope(input.scope)
    signal?.throwIfAborted()
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const source = connection.store.read((db) =>
        loadTaskObservationSource(db, this.store.repository.projectDirectory, scope, this.secret, {
          taskID: input.taskID,
        }),
      )

      const identity = {
        projectID: this.projectID,
        projectDirectory: this.store.repository.projectDirectory,
        scope: scope,
        taskID: input.taskID,
        limit: input.limit,
      }
      if (input.cursor) return this.history.continue(identity, input.cursor)

      tracker.observeStamp(source.stamp)
      const nativeRevision = tracker.nativeRevision
      const report = await captureTrajectoryHistory(
        connection.store,
        this.host,
        this.projectID,
        { taskID: input.taskID, limit: input.limit },
        this.secret,
        { taskValuationProvider: this.taskValuationProvider, signal },
      )
      signal?.throwIfAborted()
      const after = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        source.stamp.repositoryVersion !== after.repositoryVersion ||
        source.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while capturing history; recapture explicitly")

      const boundary = tracker.boundary(after, source.transitionSequence)
      signal?.throwIfAborted()
      return this.history.capture(identity, report, boundary)
    } finally {
      connection.close()
    }
  }

  async trajectoryStatus(
    input: TrajectoryStatusRequest,
    tracker: ObservationChangeTracker,
  ): Promise<TrajectoryResponse> {
    const scope = singleScope(input.scope)
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const source = connection.store.read((db) =>
        loadTaskObservationSource(db, this.store.repository.projectDirectory, scope, this.secret, {
          taskID: input.taskID,
        }),
      )
      tracker.observeStamp(source.stamp)
      const nativeRevision = tracker.nativeRevision
      const report = await inspectTrajectoryStatus(
        connection.store,
        this.host,
        this.projectID,
        input.taskID,
        this.secret,
      )
      const after = connection.store.read((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        source.stamp.repositoryVersion !== after.repositoryVersion ||
        source.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while reading status; retry the live update")

      const delta = input.live
        ? this.live.project(
            JSON.stringify([
              this.projectID,
              this.store.repository.projectDirectory,
              scope.kind,
              scope.sessionID,
              input.taskID,
            ]),
            report.trajectory.events,
            input.live.cursor,
          )
        : undefined
      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(scope),
        boundary: tracker.boundary(after, source.transitionSequence),
        report: delta
          ? { ...report, trajectory: { ...report.trajectory, events: delta.events } }
          : report,
        ...(delta ? { live: delta.live } : {}),
      }
    } finally {
      connection.close()
    }
  }
}
