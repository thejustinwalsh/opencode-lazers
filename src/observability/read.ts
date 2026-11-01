import type { Database } from "bun:sqlite"
import { TaskState } from "../runner/schema.ts"
import { PlanInput } from "../runner/schema.ts"
import { machineVersion, taskMachine } from "../runner/machine.ts"
import type { RunnerStore } from "../runner/store.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TrajectoryHost } from "../trajectory/native.ts"
import {
  inspectTrajectory,
  captureTrajectoryHistory,
  inspectTrajectoryStatus,
} from "../trajectory/read.ts"
import { TrajectoryHistoryCache } from "../trajectory/history.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import type { ObservationChangeTracker } from "./changes.ts"
import { sourceStampFromDatabase } from "./changes.ts"
import { projectAssociations, sessionAssociations } from "./associations.ts"
import type {
  ObservationScope,
  ObservationScopeView,
  SnapshotResponse,
  TrajectoryRequest,
  TrajectoryResponse,
  TrajectoryHistoryRequest,
  TrajectoryHistoryResponse,
  TrajectoryStatusRequest,
} from "./contract.ts"

type PlanRecord = {
  id: string
  revision: number
  version: number
  state: string
  body: string
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
type TaskRecord = { id: string; body: string }
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

function planInput(plan: PlanRecord) {
  try {
    return PlanInput.parse(JSON.parse(plan.body))
  } catch {
    return null
  }
}

function initialAssociations(db: Database, projectDirectory: string, scope: ObservationScope) {
  return scope.kind === "project"
    ? projectAssociations(db, projectDirectory)
    : sessionAssociations(db, projectDirectory, scope.sessionID)
}

function loadProjectionSource(
  db: Database,
  projectDirectory: string,
  scope: ObservationScope,
  secret: Uint8Array,
) {
  const stamp = sourceStampFromDatabase(db, projectDirectory, secret)
  const associations = initialAssociations(db, projectDirectory, scope)
  const allPlans = db
    .query<PlanRecord, [string]>(
      "SELECT id,revision,version,state,body,reason FROM runner_plans WHERE project_directory=? ORDER BY rowid",
    )
    .all(projectDirectory)
  const plansByID = new Map(allPlans.map((plan) => [plan.id, plan]))

  // A session-linked plan also links the actual plans it waits on. Resolve only
  // those same-project relationships; never accept a project/plan ID as scope.
  const pending = [...associations.planIDs]
  while (pending.length) {
    const id = pending.pop()!
    const plan = plansByID.get(id)
    const input = plan && planInput(plan)
    for (const dependency of input?.afterPlans ?? []) {
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
  const taskIDs = [...associations.taskIDs]
  const tasks = taskIDs.length
    ? db
        .query<TaskRecord, (string | number)[]>(
          `SELECT id,body FROM tasks WHERE project_directory=? AND id IN (${taskIDs.map(() => "?").join(",")}) ORDER BY rowid`,
        )
        .all(projectDirectory, ...taskIDs)
        .map((row) => TaskSpecSchema.parse(JSON.parse(row.body)))
    : []
  const planIDs = [...associations.planIDs]
  const placeholders = planIDs.map(() => "?").join(",")
  const selectedPlanIDs = new Set(planIDs)
  const plans = allPlans.filter((plan) => selectedPlanIDs.has(plan.id))
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
  const transitions = planIDs.length
    ? db
        .query<TransitionRecord, string[]>(
          `SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions
           WHERE plan_id IN (${placeholders}) ORDER BY id`,
        )
        .all(...planIDs)
    : []
  const attempts = planIDs.length
    ? db
        .query<AttemptIdentity, string[]>(
          `SELECT id,task_id,plan_id,number,state,started_at FROM runner_attempts WHERE plan_id IN (${placeholders}) ORDER BY started_at,number,id`,
        )
        .all(...planIDs)
    : []
  const checks = planIDs.length
    ? db
        .query<CheckRecord, string[]>(
          `SELECT id,plan_id,task_id,attempt_id,kind,state,
          json_extract(receipt,'$.check.startedAt') AS started_at,
          json_extract(receipt,'$.check.endedAt') AS ended_at,
          json_extract(receipt,'$.check.exitCode') AS exit_code
         FROM runner_effects WHERE plan_id IN (${placeholders})
          AND (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%') ORDER BY rowid`,
        )
        .all(...planIDs)
    : []
  if (
    plans.length > 1000 ||
    transitions.length > 10_000 ||
    attempts.length > 10_000 ||
    checks.length > 10_000
  )
    throw new Error("Observation scope is too large; narrow it")
  return { stamp, associations, tasks, plans, nodes, dependencies, transitions, attempts, checks }
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

export class ObservationReads {
  private readonly machine = machineDefinition()
  private readonly validTransitions = stateTransitionSet()
  private readonly history: TrajectoryHistoryCache

  constructor(
    readonly store: RunnerStore,
    private readonly host: TrajectoryHost,
    private readonly projectID: string,
    readonly secret: Uint8Array,
  ) {
    this.history = new TrajectoryHistoryCache(secret)
  }

  snapshot(scope: ObservationScope, tracker: ObservationChangeTracker): SnapshotResponse {
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const projection = connection.store.atomic((db) =>
        loadProjectionSource(db, this.store.repository.projectDirectory, scope, this.secret),
      )
      const visibleTaskIDs = new Set(projection.tasks.map((task) => task.id))
      const taskSpecs = new Map(projection.tasks.map((task) => [task.id, task]))
      const states = new Map(projection.nodes.map((node) => [node.task_id, node.state]))
      const waitingOn = new Map<string, string[]>()
      for (const edge of projection.dependencies) {
        if (states.get(edge.prerequisite) === "accepted") continue
        const values = waitingOn.get(edge.successor) ?? []
        values.push(edge.prerequisite)
        waitingOn.set(edge.successor, values)
      }
      const stats = privacyStats()
      const plans = projection.plans.map((plan) => {
        const input = planInput(plan)
        const nodes = projection.nodes.filter((node) => node.plan_id === plan.id)
        return {
          id: plan.id,
          revision: plan.revision,
          version: plan.version,
          state: safeText(plan.state, stats, 80),
          reason: plan.reason === null ? null : safeText(plan.reason, stats),
          title: input?.title ? safeText(input.title, stats, 120) : null,
          afterPlans: (input?.afterPlans ?? []).filter((id) =>
            projection.associations.planIDs.has(id),
          ),
          nodes: nodes.map((node) => {
            const task = taskSpecs.get(node.task_id)
            if (!task) throw new Error("Observation task specification is unavailable")
            const state = TaskState.parse(node.state)
            const machineSnapshot = safeSnapshot(node)
            return {
              taskID: node.task_id,
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
      const latest = connection.store.atomic((db) =>
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
      }
    } finally {
      connection.close()
    }
  }

  async trajectory(
    input: TrajectoryRequest,
    tracker: ObservationChangeTracker,
  ): Promise<TrajectoryResponse> {
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const before = connection.store.atomic((db) => {
        const source = loadProjectionSource(
          db,
          this.store.repository.projectDirectory,
          input.scope,
          this.secret,
        )
        let taskID = input.taskID
        if (input.attemptID) {
          taskID = source.attempts.find((attempt) => attempt.id === input.attemptID)?.task_id
          if (!taskID) throw new Error("No observation in this scope")
        }
        if (!taskID || !source.associations.taskIDs.has(taskID))
          throw new Error("No observation in this scope")
        return { source, taskID }
      })
      tracker.observeStamp(before.source.stamp)
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
      )
      const after = connection.store.atomic((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        before.source.stamp.repositoryVersion !== after.repositoryVersion ||
        before.source.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while reading; restart from a fresh snapshot")
      const transitionSequence = before.source.transitions.at(-1)?.id ?? 0
      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(input.scope),
        boundary: tracker.boundary(after, transitionSequence),
        report,
      }
    } finally {
      connection.close()
    }
  }

  async trajectoryHistory(
    input: TrajectoryHistoryRequest,
    tracker: ObservationChangeTracker,
  ): Promise<TrajectoryHistoryResponse> {
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const source = connection.store.atomic((db) =>
        loadProjectionSource(db, this.store.repository.projectDirectory, input.scope, this.secret),
      )
      if (!source.associations.taskIDs.has(input.taskID))
        throw new Error("No observation in this scope")

      const identity = {
        projectID: this.projectID,
        projectDirectory: this.store.repository.projectDirectory,
        scope: input.scope,
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
      )
      const after = connection.store.atomic((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        source.stamp.repositoryVersion !== after.repositoryVersion ||
        source.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while capturing history; recapture explicitly")

      const boundary = tracker.boundary(after, source.transitions.at(-1)?.id ?? 0)
      return this.history.capture(identity, report, boundary)
    } finally {
      connection.close()
    }
  }

  async trajectoryStatus(
    input: TrajectoryStatusRequest,
    tracker: ObservationChangeTracker,
  ): Promise<TrajectoryResponse> {
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      const source = connection.store.atomic((db) =>
        loadProjectionSource(db, this.store.repository.projectDirectory, input.scope, this.secret),
      )
      if (!source.associations.taskIDs.has(input.taskID))
        throw new Error("No observation in this scope")
      tracker.observeStamp(source.stamp)
      const nativeRevision = tracker.nativeRevision
      const report = await inspectTrajectoryStatus(
        connection.store,
        this.host,
        this.projectID,
        input.taskID,
        this.secret,
      )
      const after = connection.store.atomic((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(after)
      if (
        source.stamp.repositoryVersion !== after.repositoryVersion ||
        source.stamp.sourceFingerprint !== after.sourceFingerprint ||
        nativeRevision !== tracker.nativeRevision
      )
        throw new Error("Observation changed while reading status; retry the live update")

      return {
        schemaVersion: 1,
        projectID: this.projectID,
        scope: scopeView(input.scope),
        boundary: tracker.boundary(after, source.transitions.at(-1)?.id ?? 0),
        report,
      }
    } finally {
      connection.close()
    }
  }
}
