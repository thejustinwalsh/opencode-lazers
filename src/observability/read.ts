import type { Database } from "bun:sqlite"
import { TaskState } from "../runner/schema.ts"
import { PlanInput } from "../runner/schema.ts"
import { machineVersion } from "../runner/machine.ts"
import { taskMachineDefinition } from "../runner/task-machine-config.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TrajectoryHost } from "../trajectory/native.ts"
import { inspectTrajectory } from "../trajectory/read.ts"
import { StampGate } from "../core/stamp-gate.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { sourceStampFromDatabase } from "./changes.ts"
import { projectAssociations, sessionAssociations } from "./associations.ts"
import type { TaskValuationProvider } from "../models/task-valuation.ts"
import type {
  ObservationScope,
  SingleScope,
  ObservationScopeView,
  SnapshotResponse,
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
import { outerPauseIn, outerPauseReason } from "../projects/pause.ts"
import { planIn } from "../runner/identity-read.ts"

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
  // The same data the GUI's statechart reads; states are task states by construction.
  return taskMachineDefinition()
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
          // Only what the attempts' recorded executions read (Trajectory's timeline until its
          // streams land): a task's worker start and stop. No plan-level transition is read.
          `SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions
           WHERE ${planIn(db, "runner_transitions", placeholders)} AND task_id IS NOT NULL
             AND event IN ('WORKER_STARTED','WORKER_STOPPED') ORDER BY id DESC LIMIT 10001`,
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
           WHERE ${planIn(db, "runner_transitions", planIDs.map(() => "?").join(","))}`,
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

export type UnitReads = {
  reads: ObservationReads
  tracker: ObservationChangeTracker
  release(): void
}

const unavailable = () =>
  Promise.reject(new Error("Native sessions of this project are not loaded here"))
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

  constructor(
    readonly store: RunnerStore,
    private readonly host: TrajectoryHost,
    private readonly projectID: string,
    readonly secret: Uint8Array,
    private readonly taskValuationProvider?: TaskValuationProvider,
  ) {
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
      this.taskValuationProvider,
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
      const lastTransition = projection.transitions.at(-1)?.id ?? 0
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
        attempts,
        checks,
        coverage: { ...projection.historyCoverage, workTruncated: projection.historyTruncated },
      }
    } finally {
      connection.close()
    }
  }
}
