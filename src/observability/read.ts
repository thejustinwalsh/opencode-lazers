import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import type { ProgressRow } from "../runner/store.ts"
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
import { associatedSessionIDs } from "./associations.ts"
import { projectProgressFact } from "../progress/projection.ts"
import type {
  ObservationScope,
  ObservationScopeView,
  RadarRequestInput,
  RadarResponse,
  SnapshotResponse,
  TrajectoryRequest,
  TrajectoryResponse,
  TrajectoryHistoryRequest,
  TrajectoryHistoryResponse,
  TrajectoryStatusRequest,
} from "./contract.ts"
import { RadarInput, RadarOutput } from "./contract.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"

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

function planInput(plan: Pick<PlanRecord, "body">) {
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
  extraSessionIDs: Iterable<string> = [],
) {
  const stamp = sourceStampFromDatabase(db, projectDirectory, secret)
  const associations = initialAssociations(db, projectDirectory, scope)
  if (scope.kind === "session") {
    for (const sessionID of extraSessionIDs) {
      if (sessionID === scope.sessionID) continue
      const extra = sessionAssociations(db, projectDirectory, sessionID)
      for (const taskID of extra.taskIDs) associations.taskIDs.add(taskID)
      for (const planID of extra.planIDs) associations.planIDs.add(planID)
    }
  }
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

function loadRadarSource(
  db: Database,
  projectDirectory: string,
  scope: ObservationScope,
  secret: Uint8Array,
  extraSessionIDs: Iterable<string> = [],
) {
  const projection = loadProjectionSource(db, projectDirectory, scope, secret, extraSessionIDs)
  const planIDs = [...projection.associations.planIDs]
  const managedSessionIDs =
    scope.kind === "project"
      ? associatedSessionIDs(db, projectDirectory)
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
      workTruncated: projection.tasks.length > 1000,
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
  const hasRecordedAt = db
    .query<{ name: string }, []>("PRAGMA table_info(runner_progress)")
    .all()
    .some((column) => column.name === "recorded_at")
  const recordedAtColumn = hasRecordedAt ? "g.recorded_at" : "NULL AS recorded_at"
  // JSONB iteration avoids serializing each observation object to JSON text and
  // reparsing it for every timestamp access. Older host SQLite builds retain the
  // same query semantics through json_each.
  let observations = "json_each"
  try {
    db.query("SELECT value FROM jsonb_each('[]')").all()
    observations = "jsonb_each"
  } catch {
    // jsonb_each was added in SQLite 3.51; no database/schema change is needed.
  }
  // Sort only row identities and observation times. Carrying every payload through
  // SQLite's history sort repeatedly copies large tool/step records into its temp
  // B-tree; fetch the unchanged records by primary key after selecting the window.
  const progressRows = db
    .query<ProgressRow, (string | number)[]>(
      `WITH scoped AS MATERIALIZED (
         SELECT g.seq,g.at,
                 (SELECT MAX(
                    CASE WHEN observation.type='object' THEN
                      CASE WHEN json_type(observation.value,'$.at') IN ('integer','real') THEN
                        CASE WHEN json_extract(observation.value,'$.at')
                          BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
                        THEN json_extract(observation.value,'$.at') END
                      END
                    END
                  )
                  FROM ${observations}(
                    CASE WHEN json_valid(g.payload) THEN
                      CASE WHEN json_type(g.payload,'$.observations')='array'
                        THEN g.payload ELSE '{"observations":[]}' END
                    ELSE '{"observations":[]}'
                    END,
                    '$.observations'
                  ) AS observation) AS observed_at
           FROM runner_progress g JOIN runner_plans p ON p.id=g.plan_id
          WHERE p.project_directory=? AND g.plan_id IN (${placeholders})
       )
        SELECT g.seq,g.project_directory,g.project_id,g.plan_id,g.task_id,g.attempt_id,
               g.session_id,g.at,${recordedAtColumn},g.source,g.sources_json,g.kind,
               g.event_ids_json,g.call_id,g.message_id,g.dedupe_key,g.payload
          FROM runner_progress g JOIN (
            SELECT seq,max(at, COALESCE(observed_at,at)) AS latest_at FROM scoped
            ORDER BY latest_at DESC, seq DESC LIMIT 5001
          ) recent ON recent.seq=g.seq
         ORDER BY recent.latest_at DESC, g.seq DESC`,
    )
    .all(projectDirectory, ...planIDs)
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

export class ObservationReads {
  private readonly machine = machineDefinition()
  private readonly validTransitions = stateTransitionSet()
  private readonly history: TrajectoryHistoryCache

  constructor(
    readonly store: RunnerStore,
    private readonly host: TrajectoryHost,
    private readonly projectID: string,
    readonly secret: Uint8Array,
    private readonly nativeSessions?: RadarSessionHost,
  ) {
    this.history = new TrajectoryHistoryCache(secret)
  }

  async radar(
    input: RadarRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
  ): Promise<RadarResponse> {
    if (!this.nativeSessions) throw new Error("Native session inventory is unavailable")
    const request = RadarInput.parse(input)
    const scope = request.scope
    const includeUnmanagedSessions = request.includeUnmanagedSessions
    signal.throwIfAborted()
    const connection = openReadOnlyTrajectoryStore(
      this.store.repository.path,
      this.store.repository.projectDirectory,
    )
    try {
      let source = connection.store.atomic((db) =>
        loadRadarSource(db, this.store.repository.projectDirectory, scope, this.secret),
      )
      const nativeRevision = tracker.nativeRevision
      const sessionReasons = new Map<string, Set<string>>()
      const addReason = (sessionID: string, reason: string) => {
        const reasons = sessionReasons.get(sessionID) ?? new Set<string>()
        reasons.add(reason)
        sessionReasons.set(sessionID, reasons)
      }
      const runtimeManagedSessionIDs = new Set<string>()
      const expectedDirectories = new Map<string, Set<string>>()
      const sessionPlanIDs = new Map<string, Set<string>>()
      const sessionTaskIDs = new Map<string, Set<string>>()
      const sessionAttemptIDs = new Map<string, Set<string>>()
      const addContext = (map: Map<string, Set<string>>, sessionID: string, id: string) => {
        const values = map.get(sessionID) ?? new Set<string>()
        values.add(id)
        map.set(sessionID, values)
      }
      if (scope.kind === "session") addReason(scope.sessionID, "scope-anchor")

      let nativeInventory: RadarResponse["freshness"]["nativeInventory"] = "managed-only"
      let inventoryTruncated = false
      const nativeByID = new Map<string, RadarNativeSession>()
      const inventorySessionIDs = new Set<string>()
      const nativeFailures = new Set<string>()
      const foreignSessionIDs = new Set<string>()
      const resolvedSessionIDs = new Set<string>()
      if (includeUnmanagedSessions) {
        try {
          const inventory =
            scope.kind === "project"
              ? await this.nativeSessions.project(this.projectID, true, 500, signal)
              : await this.nativeSessions.descendants(
                  this.projectID,
                  scope.sessionID,
                  true,
                  500,
                  signal,
                )
          inventoryTruncated = inventory.truncated
          nativeInventory = inventory.truncated ? "bounded" : "complete"
          for (const session of inventory.sessions) {
            if (session.projectID !== this.projectID) continue
            nativeByID.set(session.id, session)
          }
          if (scope.kind === "project") {
            for (const session of nativeByID.values()) inventorySessionIDs.add(session.id)
          } else {
            const reachable = new Set([scope.sessionID])
            let expanded = true
            while (expanded) {
              expanded = false
              for (const session of nativeByID.values()) {
                if (
                  session.parentID &&
                  reachable.has(session.parentID) &&
                  !reachable.has(session.id)
                ) {
                  reachable.add(session.id)
                  expanded = true
                }
              }
            }
            for (const sessionID of reachable) {
              if (sessionID === scope.sessionID) continue
              inventorySessionIDs.add(sessionID)
              addReason(sessionID, "native-ancestry")
            }
            for (const sessionID of [...nativeByID.keys()])
              if (!reachable.has(sessionID)) nativeByID.delete(sessionID)
          }
        } catch (error) {
          if (signal.aborted) throw error
          nativeInventory = "unavailable"
        }
      }

      const scopeAncestryIDs = new Set<string>()
      let ancestryTruncated = false
      if (scope.kind === "session") {
        const rootID = scope.sessionID
        scopeAncestryIDs.add(rootID)
        let current = nativeByID.get(rootID)
        if (!current) {
          signal.throwIfAborted()
          try {
            current = (await this.nativeSessions.get(rootID, signal)) ?? undefined
            resolvedSessionIDs.add(rootID)
            if (current?.projectID === this.projectID) nativeByID.set(rootID, current)
            else if (current && current.projectID !== this.projectID) {
              foreignSessionIDs.add(rootID)
              current = undefined
            }
          } catch (error) {
            if (signal.aborted) throw error
            nativeFailures.add(rootID)
            resolvedSessionIDs.add(rootID)
          }
        }
        const visited = new Set([rootID])
        for (let depth = 0; current?.parentID; depth++) {
          const parentID = current.parentID
          if (visited.has(parentID)) break
          if (depth >= 50) {
            ancestryTruncated = true
            break
          }
          visited.add(parentID)
          signal.throwIfAborted()
          try {
            const parent = await this.nativeSessions.get(parentID, signal)
            resolvedSessionIDs.add(parentID)
            if (!parent) break
            if (parent.projectID !== this.projectID) {
              foreignSessionIDs.add(parentID)
              break
            }
            scopeAncestryIDs.add(parentID)
            addReason(parentID, "native-ancestry")
            nativeByID.set(parentID, parent)
            current = parent
          } catch (error) {
            if (signal.aborted) throw error
            nativeFailures.add(parentID)
            resolvedSessionIDs.add(parentID)
            break
          }
        }
      }

      if (scope.kind === "session" && scopeAncestryIDs.size > 1) {
        source = connection.store.atomic((db) =>
          loadRadarSource(
            db,
            this.store.repository.projectDirectory,
            scope,
            this.secret,
            scopeAncestryIDs,
          ),
        )
      }
      for (const task of source.tasks) addReason(task.provenance.sessionID, "task-submitter")
      for (const plan of source.radarPlans) {
        addReason(plan.owner, "plan-owner")
        addContext(sessionPlanIDs, plan.owner, plan.id)
      }
      for (const continuation of source.continuations) {
        runtimeManagedSessionIDs.add(continuation.session_id)
        addReason(continuation.session_id, "continuation")
        addContext(sessionPlanIDs, continuation.session_id, continuation.plan_id)
        const expected = expectedDirectories.get(continuation.session_id) ?? new Set<string>()
        expected.add(continuation.directory)
        expectedDirectories.set(continuation.session_id, expected)
        if (continuation.parent_id) {
          addReason(continuation.parent_id, "native-ancestry")
          addContext(sessionPlanIDs, continuation.parent_id, continuation.plan_id)
        }
      }
      for (const attempt of source.radarAttempts) {
        runtimeManagedSessionIDs.add(attempt.session_id)
        addReason(attempt.session_id, "attempt")
        addContext(sessionPlanIDs, attempt.session_id, attempt.plan_id)
        addContext(sessionTaskIDs, attempt.session_id, attempt.task_id)
        addContext(sessionAttemptIDs, attempt.session_id, attempt.id)
        const expected = expectedDirectories.get(attempt.session_id) ?? new Set<string>()
        expected.add(attempt.workspace)
        expectedDirectories.set(attempt.session_id, expected)
      }
      for (const task of source.tasks)
        addContext(sessionTaskIDs, task.provenance.sessionID, task.id)

      const requestedIDs = new Set(source.managedSessionIDs)
      for (const sessionID of inventorySessionIDs) requestedIDs.add(sessionID)
      for (const sessionID of scopeAncestryIDs) requestedIDs.add(sessionID)
      const orderedIDs = [
        ...(scope.kind === "session" ? [scope.sessionID] : []),
        ...[...source.managedSessionIDs].sort(),
        ...[...scopeAncestryIDs].filter((id) => !source.managedSessionIDs.has(id)).sort(),
        ...[...inventorySessionIDs].filter((id) => !source.managedSessionIDs.has(id)).sort(),
      ]
      const selectedIDs = [...new Set(orderedIDs)].slice(0, 500)
      if (requestedIDs.size > selectedIDs.length) {
        inventoryTruncated = true
        nativeInventory = nativeInventory === "unavailable" ? "unavailable" : "bounded"
      }
      const selectedSet = new Set(selectedIDs)
      for (const sessionID of selectedIDs) {
        if (nativeByID.has(sessionID) || resolvedSessionIDs.has(sessionID)) continue
        signal.throwIfAborted()
        try {
          const session = await this.nativeSessions.get(sessionID, signal)
          if (session?.projectID === this.projectID) nativeByID.set(sessionID, session)
          else if (session && session.projectID !== this.projectID) foreignSessionIDs.add(sessionID)
        } catch (error) {
          if (signal.aborted) throw error
          nativeFailures.add(sessionID)
        }
      }
      if (ancestryTruncated && nativeInventory !== "unavailable") nativeInventory = "bounded"
      tracker.trackScopedSessions(selectedIDs)

      const observedAt = Date.now()
      const stats = privacyStats()
      const routes: RadarResponse["routes"] = []
      const routeIDs = new Set<string>()
      let routeTruncated = false
      const addRoute = (route: RadarResponse["routes"][number]) => {
        if (routeIDs.has(route.id)) return route.id
        if (routes.length >= 20_000) {
          routeTruncated = true
          return null
        }
        routeIDs.add(route.id)
        routes.push(route)
        return route.id
      }
      const routeFromPolicy = (attempt: RadarAttemptRecord) => {
        const policy = jsonObject(attempt.policy)
        const model = object(policy?.model)
        if (typeof model?.providerID !== "string" || typeof model.id !== "string") return null
        const providerID = safeText(model.providerID, stats, 200)
        const modelID = safeText(model.id, stats, 300)
        if (!providerID || !modelID) return null
        return addRoute({
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
      const configuredByAttempt = new Map<string, string | null>()
      const configuredBySession = new Map<string, Set<string>>()
      for (const attempt of source.radarAttempts) {
        const routeID = routeFromPolicy(attempt)
        configuredByAttempt.set(attempt.id, routeID)
        if (routeID) addContext(configuredBySession, attempt.session_id, routeID)
      }

      const sessions: RadarResponse["sessions"] = []
      for (const sessionID of selectedIDs) {
        if (foreignSessionIDs.has(sessionID)) continue
        const reasons = sessionReasons.get(sessionID) ?? new Set<string>()
        const native = nativeByID.get(sessionID)
        const failure = nativeFailures.has(sessionID)
        if (native && native.projectID !== this.projectID) continue
        const expected = expectedDirectories.get(sessionID)
        const moved = Boolean(native && expected?.size && !expected.has(native.directory))
        const availability: RadarResponse["sessions"][number]["availability"] = failure
          ? "unavailable"
          : !native
            ? "missing"
            : native.archived
              ? "archived"
              : moved
                ? "moved"
                : "available"
        const fresh = availability === "available"
        const currentRouteID =
          fresh && native?.model
            ? addRoute({
                id: `route:selection:${stableToken(sessionID)}`,
                providerID: safeText(native.model.providerID, stats, 200),
                modelID: safeText(native.model.id, stats, 300),
                variant: native.model.variant ? safeText(native.model.variant, stats, 200) : null,
                source: "session-selection",
                sessionID,
                attemptID: null,
                messageID: null,
                eventID: null,
                observedAt,
              })
            : null
        const classification = runtimeManagedSessionIDs.has(sessionID)
          ? "managed"
          : scopeAncestryIDs.has(sessionID) ||
              [...reasons].some(
                (reason) => reason !== "scope-anchor" && reason !== "native-ancestry",
              )
            ? "associated"
            : "unmanaged"
        sessions.push({
          id: sessionNodeID(sessionID),
          sessionID,
          projectID: this.projectID,
          parentSessionID:
            fresh && native?.parentID && selectedSet.has(native.parentID) ? native.parentID : null,
          classification,
          associations: [...reasons].sort() as RadarResponse["sessions"][number]["associations"],
          availability,
          freshness: fresh
            ? "current"
            : availability === "missing" || availability === "unavailable"
              ? "unknown"
              : "stale",
          agent: fresh ? (native?.agent ?? null) : null,
          state: fresh
            ? native?.busy === null
              ? "unknown"
              : native?.busy
                ? "busy"
                : "idle"
            : "unknown",
          currentRouteID,
          configuredRouteIDs: [...(configuredBySession.get(sessionID) ?? [])].sort().slice(0, 100),
          planIDs: [...(sessionPlanIDs.get(sessionID) ?? [])].sort().slice(0, 100),
          taskIDs: [...(sessionTaskIDs.get(sessionID) ?? [])].sort().slice(0, 100),
          attemptIDs: [...(sessionAttemptIDs.get(sessionID) ?? [])].sort().slice(0, 100),
          updatedAt: fresh ? (native?.updatedAt ?? null) : null,
          observedAt: native ? observedAt : null,
        })
      }

      const edges: RadarResponse["edges"] = []
      const edgeIDs = new Set<string>()
      let edgeTruncated = false
      const addEdge = (edge: RadarResponse["edges"][number]) => {
        if (edgeIDs.has(edge.id)) return
        if (edges.length >= 20_000) {
          edgeTruncated = true
          return
        }
        edgeIDs.add(edge.id)
        edges.push(edge)
      }
      const codeEvidence = (reference: string): RadarResponse["edges"][number]["evidence"] => [
        { source: "code", reference, at: null },
      ]
      const baseEdge = (
        id: string,
        kind: RadarResponse["edges"][number]["kind"],
        from: string,
        to: string,
        status: string,
        values: Partial<RadarResponse["edges"][number]> = {},
      ): RadarResponse["edges"][number] => ({
        id,
        kind,
        from,
        to,
        status: safeText(status, stats, 80),
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

      const components: RadarResponse["components"] = [
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
          responsibility:
            "Provides public session identity, selection, and busy/idle observations.",
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
      for (const [from, to, file] of [
        ["component:runner-runtime", "component:runner-store", "src/runner/runtime.ts"],
        ["component:runner-runtime", "component:native-session-api", "src/runner/native.ts"],
        ["component:progress-recorder", "component:runner-store", "src/progress/recorder.ts"],
        ["component:observability", "component:runner-store", "src/observability/read.ts"],
        ["component:observability", "component:native-session-api", "src/observability/native.ts"],
      ] as const)
        addEdge(
          baseEdge(`architecture:${from}:${to}`, "architecture", from, to, "structural", {
            evidence: codeEvidence(file),
          }),
        )

      const transitionPayload = (row: TransitionRecord) => jsonObject(row.payload) ?? {}
      const transitionsByEffectID = new Map<string, TransitionRecord[]>()
      const transitionsByOutboxID = new Map<string, TransitionRecord[]>()
      for (const row of source.transitions) {
        const payload = transitionPayload(row)
        const effectID = typeof payload.effectID === "string" ? payload.effectID : null
        if (effectID) {
          const values = transitionsByEffectID.get(effectID) ?? []
          values.push(row)
          transitionsByEffectID.set(effectID, values)
        }
        const outboxID = typeof payload.outboxID === "string" ? payload.outboxID : null
        if (outboxID) {
          const values = transitionsByOutboxID.get(outboxID) ?? []
          values.push(row)
          transitionsByOutboxID.set(outboxID, values)
        }
      }
      const transitionEvidence = (
        row: TransitionRecord,
        payload: JsonObject,
        fallbackMessageID: string | null = null,
      ): RadarResponse["edges"][number]["evidence"][number] => ({
        source: "runner-transition",
        sequence: row.id,
        event: safeText(row.event, stats, 120),
        effectID:
          typeof payload.effectID === "string" ? safeText(payload.effectID, stats, 200) : null,
        outboxID:
          typeof payload.outboxID === "string" ? safeText(payload.outboxID, stats, 200) : null,
        messageID:
          typeof payload.messageID === "string"
            ? safeText(payload.messageID, stats, 200)
            : fallbackMessageID,
        at: row.created_at,
      })
      const progressEvidence = (
        row: ProgressRow,
        at: number | null = row.at,
      ): RadarResponse["edges"][number]["evidence"][number] => ({
        source: "runner-record",
        recordID: `progress:${row.seq}`,
        messageID: row.message_id ? safeText(row.message_id, stats, 200) : null,
        callID: row.call_id ? safeText(row.call_id, stats, 200) : null,
        at,
      })
      const eventEvidence = (
        eventID: string,
        eventType: string,
        sessionID: string,
        messageID: string | null,
        callID: string | null,
        at: number,
      ): RadarResponse["edges"][number]["evidence"][number] => ({
        source: "native-event",
        eventID: safeText(eventID, stats, 200),
        eventType: safeText(eventType, stats, 120),
        sessionID,
        messageID,
        callID,
        at,
      })

      const plans = source.radarPlans.slice(0, 1000).map((plan) => ({
        id: plan.id,
        state: safeText(plan.state, stats, 80),
        ownerSessionID: plan.owner,
        title: planInput(plan)?.title ? safeText(planInput(plan)!.title!, stats, 120) : null,
      }))
      const nodesByTask = new Map(source.nodes.map((node) => [node.task_id, node]))
      const planByTask = new Map<string, string>()
      for (const node of source.nodes)
        if (!planByTask.has(node.task_id)) planByTask.set(node.task_id, node.plan_id)
      const tasks = source.tasks.slice(0, 1000).map((task) => ({
        id: task.id,
        planID: planByTask.get(task.id) ?? null,
        state: nodesByTask.get(task.id)?.state ?? ("submitted" as const),
      }))
      const attempts = source.radarAttempts.slice(0, 10_000).map((attempt) => ({
        id: attempt.id,
        planID: attempt.plan_id,
        taskID: attempt.task_id,
        sessionID: attempt.session_id,
        number: attempt.number,
        state: safeText(attempt.state, stats, 80),
        startedAt: attempt.started_at,
        configuredRouteID: configuredByAttempt.get(attempt.id) ?? null,
      }))

      const plansByID = new Map(source.radarPlans.map((plan) => [plan.id, plan]))
      for (const plan of plans) {
        addEdge(
          baseEdge(
            `association:plan:${plan.id}:${stableToken(plan.ownerSessionID)}`,
            "association",
            `plan:${plan.id}`,
            sessionNodeID(plan.ownerSessionID),
            "plan-owner",
            {
              planID: plan.id,
              evidence: [
                {
                  source: "runner-record",
                  recordID: plan.id,
                  messageID: null,
                  callID: null,
                  at: null,
                },
              ],
            },
          ),
        )
      }
      for (const task of source.tasks) {
        const submitter = task.provenance.sessionID
        addEdge(
          baseEdge(
            `association:task:${task.id}:${stableToken(submitter)}`,
            "association",
            `task:${task.id}`,
            sessionNodeID(submitter),
            "task-submitter",
            {
              planID: planByTask.get(task.id) ?? null,
              taskID: task.id,
              evidence: [
                {
                  source: "runner-record",
                  recordID: task.id,
                  messageID: null,
                  callID: null,
                  at: null,
                },
              ],
            },
          ),
        )
      }
      for (const dependency of source.dependencies)
        addEdge(
          baseEdge(
            `dependency:${dependency.plan_id}:${dependency.prerequisite}:${dependency.successor}`,
            "dependency",
            `task:${dependency.prerequisite}`,
            `task:${dependency.successor}`,
            "dependency",
            {
              planID: dependency.plan_id,
              taskID: dependency.successor,
              evidence: [
                {
                  source: "runner-record",
                  recordID: dependency.plan_id,
                  messageID: null,
                  callID: null,
                  at: null,
                },
              ],
            },
          ),
        )

      const liveEventIDs = tracker.peekLiveEvents(selectedSet)
      const effectsByAttempt = new Map<string, RadarEffectRecord[]>()
      for (const effect of source.radarEffects) {
        if (!effect.attempt_id) continue
        const values = effectsByAttempt.get(effect.attempt_id) ?? []
        values.push(effect)
        effectsByAttempt.set(effect.attempt_id, values)
      }
      for (const attempt of source.radarAttempts) {
        const plan = plansByID.get(attempt.plan_id)
        const effects = effectsByAttempt.get(attempt.id) ?? []
        const sessionEffect = effects.find((effect) => effect.kind === "session")
        const promptEffect = effects.find((effect) => effect.kind === "prompt")
        const transitionsFor = (effectID: string | undefined) =>
          effectID ? (transitionsByEffectID.get(effectID) ?? []) : []
        const sessionTransitions = transitionsFor(sessionEffect?.id)
        addEdge(
          baseEdge(
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
                ...sessionTransitions.map((row) => transitionEvidence(row, transitionPayload(row))),
              ].slice(-100),
            },
          ),
        )
        if (promptEffect && plan) {
          const effectPayload = jsonObject(promptEffect.payload) ?? {}
          const messageID =
            typeof effectPayload.messageID === "string"
              ? effectPayload.messageID
              : attempt.message_id
          const promptTransitions = transitionsFor(promptEffect.id)
          const stage =
            promptEffect.state === "intended"
              ? "persisted"
              : promptEffect.state === "completed"
                ? "admitted"
                : "unknown"
          addEdge(
            baseEdge(
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
                    transitionEvidence(
                      row,
                      transitionPayload(row),
                      safeText(messageID, stats, 200),
                    ),
                  )
                  .slice(-100),
              },
            ),
          )
        }
      }

      for (const outbox of source.outbox) {
        const transitionRows = transitionsByOutboxID.get(outbox.id) ?? []
        const stage: NonNullable<RadarResponse["edges"][number]["deliveryStage"]> =
          outbox.state === "pending"
            ? "persisted"
            : outbox.state === "admitted" || outbox.state === "delivered"
              ? "admitted"
              : outbox.state === "consumed"
                ? "consumed"
                : outbox.state === "rejected"
                  ? "rejected"
                  : outbox.state === "superseded"
                    ? "superseded"
                    : "unknown"
        const evidence = transitionRows.map((row) =>
          transitionEvidence(row, transitionPayload(row), outbox.message_id),
        )
        if (!evidence.length)
          evidence.push({
            source: "runner-record",
            recordID: outbox.id,
            messageID: outbox.message_id,
            callID: null,
            at: null,
          })
        addEdge(
          baseEdge(
            `outcome:${outbox.id}`,
            "outcome",
            "component:runner-runtime",
            sessionNodeID(outbox.session_id),
            outbox.state,
            {
              deliveryStage: stage,
              planID: outbox.plan_id,
              messageID: safeText(outbox.message_id, stats, 200),
              startedAt: transitionRows[0]?.created_at ?? null,
              observedAt: transitionRows.at(-1)?.created_at ?? null,
              evidence: evidence.slice(-100),
            },
          ),
        )
      }

      const stepStarts = new Map<
        string,
        { routeID: string; startedAt: number | null; agentID: string | null }
      >()
      const stepObservations = source.progress.flatMap((row) => {
        if (row.kind !== "step") return []
        const fact = projectProgressFact(row)
        const observations = fact.observations
        if (!Array.isArray(observations)) return []
        return observations.flatMap((rawObservation, index) => {
          const observation = object(rawObservation)
          const at = observation?.at
          if (
            observation?.source !== "native-event" ||
            typeof at !== "number" ||
            !Number.isFinite(at)
          )
            return []
          return [{ row, messageID: fact.messageID, observation, index, at }]
        })
      })
      stepObservations.sort(
        (left, right) =>
          left.at - right.at || left.row.seq - right.row.seq || left.index - right.index,
      )
      for (const { row, messageID, observation, at } of stepObservations) {
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
          continue
        const key = `${row.session_id}\u0000${observation.messageID}`
        if (observation.eventType === "session.step.started") {
          const route = object(observation.route)
          if (
            !route ||
            typeof route.providerID !== "string" ||
            !route.providerID ||
            typeof route.modelID !== "string" ||
            !route.modelID
          )
            continue
          const routeID = addRoute({
            id: `route:step:${stableToken(observation.eventID)}`,
            providerID: route.providerID,
            modelID: route.modelID,
            variant: typeof route.variant === "string" ? route.variant : null,
            source: "step-event",
            sessionID: row.session_id,
            attemptID: row.attempt_id,
            messageID: observation.messageID,
            eventID: observation.eventID,
            observedAt: at,
          })
          if (!routeID) continue
          const agentID =
            typeof observation.agent === "string" ? safeText(observation.agent, stats, 200) : null
          const recordedStartedAt = observation.startedAt
          const startedAt =
            typeof recordedStartedAt === "number" && Number.isFinite(recordedStartedAt)
              ? recordedStartedAt
              : at
          stepStarts.set(key, { routeID, startedAt, agentID })
          addEdge(
            baseEdge(
              `model-request:${stableToken(observation.eventID)}`,
              "model-request",
              sessionNodeID(row.session_id),
              routeID,
              "started",
              {
                planID: row.plan_id,
                taskID: row.task_id,
                attemptID: row.attempt_id,
                agentID,
                messageID: observation.messageID,
                routeID,
                startedAt,
                observedAt: at,
                live: liveEventIDs.has(observation.eventID),
                evidence: [
                  eventEvidence(
                    observation.eventID,
                    String(observation.eventType),
                    row.session_id,
                    observation.messageID,
                    null,
                    at,
                  ),
                ],
              },
            ),
          )
        } else {
          const started = stepStarts.get(key)
          if (!started) continue
          const failed = observation.eventType === "session.step.failed"
          addEdge(
            baseEdge(
              `model-response:${stableToken(observation.eventID)}`,
              "model-response",
              started.routeID,
              sessionNodeID(row.session_id),
              failed ? "failed" : "ended",
              {
                planID: row.plan_id,
                taskID: row.task_id,
                attemptID: row.attempt_id,
                agentID: started.agentID,
                messageID: observation.messageID,
                routeID: started.routeID,
                startedAt: started.startedAt,
                observedAt: at,
                live: liveEventIDs.has(observation.eventID),
                evidence: [
                  eventEvidence(
                    observation.eventID,
                    String(observation.eventType),
                    row.session_id,
                    observation.messageID,
                    null,
                    at,
                  ),
                ],
              },
            ),
          )
        }
      }
      const tools = new Map<string, { id: string; name: string }>()
      for (const row of source.progress) {
        if (row.kind !== "tool") continue
        const fact = projectProgressFact(row)
        const observations = Array.isArray(fact.observations) ? fact.observations : []
        const name = typeof fact.tool === "string" ? fact.tool : ""
        const callID = typeof fact.callID === "string" ? fact.callID : ""
        if (!name || !row.call_id || !callID) continue
        const toolID = `tool:${stableToken(name)}`
        tools.set(toolID, { id: toolID, name })
        const orderedObservations = observations
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
        for (const { observation, at } of orderedObservations) {
          if (
            typeof observation.eventID !== "string" ||
            !observation.eventID ||
            observation.callID !== callID ||
            (observation.eventType !== "session.tool.called" &&
              observation.eventType !== "session.tool.success" &&
              observation.eventType !== "session.tool.failed")
          )
            continue
          const isCall = observation.eventType === "session.tool.called"
          const evidence = eventEvidence(
            observation.eventID,
            observation.eventType,
            row.session_id,
            row.message_id ? safeText(row.message_id, stats, 200) : null,
            safeText(row.call_id, stats, 200),
            at,
          )
          addEdge(
            baseEdge(
              `tool-flow:${stableToken(observation.eventID)}`,
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
                live: liveEventIDs.has(observation.eventID),
                evidence: [evidence],
              },
            ),
          )
        }
      }
      for (const row of source.progress) {
        if (row.kind !== "reminder") continue
        const fact = projectProgressFact(row)
        const delivery = typeof fact.delivery === "string" ? fact.delivery : "unknown"
        const stage: NonNullable<RadarResponse["edges"][number]["deliveryStage"]> =
          delivery === "dispatching"
            ? "persisted"
            : delivery === "admitted"
              ? "admitted"
              : delivery === "rejected"
                ? "rejected"
                : "unknown"
        const eventID = typeof fact.nativeEventID === "string" ? fact.nativeEventID : null
        const observed = typeof fact.observedAt === "number" ? fact.observedAt : null
        const evidence: RadarResponse["edges"][number]["evidence"] = [
          progressEvidence(row, observed ?? row.at),
        ]
        if (eventID && observed !== null)
          evidence.push(
            eventEvidence(
              eventID,
              "session.synthetic",
              row.session_id,
              row.message_id,
              null,
              observed,
            ),
          )
        addEdge(
          baseEdge(
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
          ),
        )
      }

      for (const session of sessions) {
        if (session.parentSessionID)
          addEdge(
            baseEdge(
              `ancestry:${stableToken(session.parentSessionID)}:${stableToken(session.sessionID)}`,
              "ancestry",
              sessionNodeID(session.parentSessionID),
              session.id,
              "native-parent",
              {
                observedAt,
                evidence: [{ source: "native-read", sessionID: session.sessionID, at: observedAt }],
              },
            ),
          )
        if (session.availability === "available")
          addEdge(
            baseEdge(
              `observation:${session.sessionID}`,
              "observation",
              "component:observability",
              session.id,
              "metadata-read",
              {
                observedAt,
                evidence: [{ source: "native-read", sessionID: session.sessionID, at: observedAt }],
              },
            ),
          )
      }

      if (tracker.nativeRevision !== nativeRevision)
        throw new Error(
          "Native observation changed while reading; restart from a fresh radar projection",
        )
      const latest = connection.store.atomic((db) =>
        sourceStampFromDatabase(db, this.store.repository.projectDirectory, this.secret),
      )
      tracker.observeStamp(latest)
      if (
        source.stamp.repositoryVersion !== latest.repositoryVersion ||
        source.stamp.sourceFingerprint !== latest.sourceFingerprint
      )
        throw new Error(
          "Runner observation changed while reading; restart from a fresh radar projection",
        )
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
          nativeInventory,
          nativeEvents: tracker.hasConnectedEventStream ? "connected" : "gap-or-unavailable",
        },
        coverage: {
          sessionCount: sessions.length,
          managedSessionCount: sessions.filter((session) => session.classification !== "unmanaged")
            .length,
          includeUnmanagedSessions,
          inventoryTruncated: inventoryTruncated || ancestryTruncated,
          workTruncated:
            source.workTruncated ||
            source.tasks.length > 1000 ||
            selectedIDs.length < requestedIDs.size,
          progressTruncated: source.progressTruncated,
          routeTruncated,
          toolTruncated: tools.size > 200,
          edgeTruncated,
        },
        components,
        sessions,
        routes,
        tools: [...tools.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, 200),
        plans,
        tasks,
        attempts,
        edges,
      })
    } finally {
      connection.close()
    }
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
