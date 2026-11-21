import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import type { TaskRepository } from "../storage.ts"
import { projectSettingsIn } from "../projects/settings.ts"
import { registerLifecycleTransitions } from "./lifecycle-machines.ts"

const ACTIVE_ATTEMPT_STATES = ["preparing", "running"] as const
const MAX_SQLITE_INTEGER = 2_147_483_647

/**
 * The project's limit is the Projects section's `limit` (`src/projects/settings.ts`), read in the
 * admitting transaction, so a change applies on the next pass. `null` (never set) means no limit:
 * every request is admitted at once, as before capacity existed.
 */
export type DelegatedAgentSettings = {
  projectDirectory: string
  limit: number | null
}

export type DelegatedAgentStatus = DelegatedAgentSettings & {
  active: number
  queued: number
  reason: string | null
}

export type RunnerCandidate = {
  planID: string
  taskID: string
  attemptNumber: number
}

export type DelegatedAgentSchedulingSnapshot = DelegatedAgentStatus & {
  queuedNative: number
  queuedRunnerTasks: Array<{ planID: string; taskID: string }>
  queuedRunnerTasksComplete: boolean
}

type NativeRequest = {
  parentSessionID: string
  toolCallID: string
  agent: string
  description: string
  existingSessionID?: string
}

export type NativeExecution = { id: string; key: string; sessionID: string; createdAt: number }

type AdmissionRow = {
  id: string
  request_key: string
  kind: "runner" | "native"
  state: "queued" | "admitted" | "released" | "cancelled"
  parent_session_id: string | null
  tool_call_id: string | null
  agent: string
  description: string
  session_id: string | null
}

type AdmissionState = AdmissionRow["state"]

type Clock = {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

const systemClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve()
      }, ms)
      timer.unref?.()
      function abort() {
        clearTimeout(timer)
        reject(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
    }),
}

function canonicalDirectory(directory: string) {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

function activeRunnerStateSQL(alias = "") {
  const state = alias ? `${alias}.state` : "state"
  return `${state} IN (${ACTIVE_ATTEMPT_STATES.map((value) => `'${value}'`).join(",")})`
}

function settingsRow(
  db: Database,
  projectKey: string,
  projectDirectory: string,
): DelegatedAgentSettings {
  return { projectDirectory, limit: projectSettingsIn(db, projectKey).limit }
}

function nextQueueOrder(db: Database) {
  return db
    .query<{ next: number }, []>(
      "SELECT COALESCE(MAX(queue_order),0)+1 AS next FROM delegated_agent_admissions",
    )
    .get()!.next
}

function queuedAdmissionCount(db: Database, projectKey: string) {
  return db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM delegated_agent_admissions WHERE project_key=? AND state='queued'",
    )
    .get(projectKey)!.count
}

function activeCount(db: Database, projectKey: string) {
  const runnerStates = ACTIVE_ATTEMPT_STATES.map(() => "?").join(",")
  const native = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM delegated_agent_admissions
       WHERE project_key=? AND kind='native' AND state='admitted'`,
    )
    .get(projectKey)!.count
  const runners = db
    .query<{ count: number }, [string, ...string[]]>(
      `SELECT COUNT(*) AS count
       FROM delegated_agent_admissions a
       JOIN runner_attempts r ON r.id=a.attempt_id
       WHERE a.project_key=? AND a.kind='runner' AND a.state='admitted'
         AND r.state IN (${runnerStates})`,
    )
    .get(projectKey, ...ACTIVE_ATTEMPT_STATES)!.count
  return native + runners
}

function reconcileRunnerAdmissions(db: Database, projectKey: string, now: number) {
  db.query(
    `UPDATE delegated_agent_admissions
     SET state=lz_runner_transition('capacity',state,'released'),updated_at=?
     WHERE project_key=? AND kind='runner' AND state='admitted'
       AND NOT EXISTS (
         SELECT 1 FROM runner_attempts r
         WHERE r.id=delegated_agent_admissions.attempt_id
           AND ${activeRunnerStateSQL("r")}
       )`,
  ).run(now, projectKey)
}

function nativeQueueOwnerGone(processID: number | null, currentPID: number) {
  if (!processID) return true
  if (processID === currentPID) return false
  try {
    process.kill(processID, 0)
    return false
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    )
  }
}

function releaseDeadNativeOwners(
  db: Database,
  projectKey: string,
  currentPID: number,
  now: number,
) {
  const rows = db
    .query<{ id: string; process_id: number | null }, [string]>(
      `SELECT id,process_id FROM delegated_agent_admissions
       WHERE project_key=? AND kind='native' AND state='queued'`,
    )
    .all(projectKey)
  for (const row of rows)
    if (nativeQueueOwnerGone(row.process_id, currentPID))
      db.query(
        `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'cancelled'),updated_at=?
         WHERE id=? AND state='queued'`,
      ).run(now, row.id)
}

function nextQueuedAdmission(db: Database, projectKey: string) {
  return db
    .query<{ id: string }, [string]>(
      `SELECT id FROM delegated_agent_admissions
       WHERE project_key=? AND state='queued'
       ORDER BY
         CASE WHEN priority>0 THEN priority ELSE ${MAX_SQLITE_INTEGER + 1} END,
         CASE WHEN priority>0 THEN plan_order ELSE queue_order END,
         CASE WHEN priority>0 THEN task_order ELSE 0 END,
         queue_order
       LIMIT 1`,
    )
    .get(projectKey)?.id
}

function canAdmit(db: Database, projectKey: string, requestID: string, limit: number | null) {
  if (limit === null) return true
  return activeCount(db, projectKey) < limit && nextQueuedAdmission(db, projectKey) === requestID
}

function tryAdmitQueued(
  db: Database,
  input: {
    requestID: string
    projectKey: string
    projectDirectory: string
    kind: AdmissionRow["kind"]
    processID: number
    now: number
    attemptID?: string
  },
) {
  const request = db
    .query<{ state: AdmissionState }, [string, string, AdmissionRow["kind"]]>(
      "SELECT state FROM delegated_agent_admissions WHERE id=? AND project_key=? AND kind=?",
    )
    .get(input.requestID, input.projectKey, input.kind)
  if (!request) return "unavailable" as const
  if (request.state === "admitted") return "already-admitted" as const
  if (request.state !== "queued") return "waiting" as const
  const limit = settingsRow(db, input.projectKey, input.projectDirectory).limit
  if (!canAdmit(db, input.projectKey, input.requestID, limit)) return "waiting" as const

  const setAttempt = input.attemptID ? "attempt_id=?," : ""
  const values = [
    ...(input.attemptID ? [input.attemptID] : []),
    input.processID,
    input.now,
    input.requestID,
    input.projectKey,
    input.kind,
  ]
  const changed = db
    .query(
      `UPDATE delegated_agent_admissions
       SET state=lz_runner_transition('capacity',state,'admitted'),${setAttempt}process_id=?,updated_at=?
       WHERE id=? AND project_key=? AND kind=? AND state='queued'`,
    )
    .run(...values).changes
  return changed === 1 ? ("admitted" as const) : ("waiting" as const)
}

function transitionAdmission(
  db: Database,
  input: {
    id: string
    kind: AdmissionRow["kind"]
    from: AdmissionState[]
    to: AdmissionState
    now: number
  },
) {
  db.query(
    `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,?),updated_at=?
     WHERE id=? AND kind=? AND state IN (${input.from.map(() => "?").join(",")})`,
  ).run(input.to, input.now, input.id, input.kind, ...input.from)
}

function reasonFor(status: Pick<DelegatedAgentStatus, "active" | "queued" | "limit">) {
  if (status.limit === null) return null
  if (status.active > status.limit)
    return `The limit is ${status.limit}, but ${status.active} agents are already active; they will finish without preemption.`
  if (status.active < status.limit || status.queued === 0) return null
  return `All ${status.limit} delegated-agent slots are in use; ${status.queued} eligible ${status.queued === 1 ? "task or helper is" : "tasks or helpers are"} waiting.`
}

/**
 * Durable, cross-process delegated-agent admission for one canonical project.
 * Attempt creation and slot reservation share the same SQLite write transaction.
 */
export class DelegatedAgentCapacity {
  private readonly projectKeyPromise: Promise<string>
  private readonly readyPromise: Promise<string>
  private resolvedProjectKey: string | undefined

  constructor(
    private readonly repository: TaskRepository,
    projectKey:
      string | Promise<string> = `path:${canonicalDirectory(repository.projectDirectory)}`,
    private readonly clock: Clock = systemClock,
    private readonly processID = () => process.pid,
  ) {
    this.projectKeyPromise = Promise.resolve(projectKey)
    repository.installSchema("delegated-agent-capacity", 1, ["delegated_agent_admissions"], (db) =>
      db.exec(`
          CREATE TABLE IF NOT EXISTS delegated_agent_admissions (
            id TEXT PRIMARY KEY,
            project_key TEXT NOT NULL,
            project_directory TEXT NOT NULL,
            request_key TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('runner','native')),
            state TEXT NOT NULL CHECK(state IN ('queued','admitted','released','cancelled')),
            agent TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority INTEGER NOT NULL DEFAULT 0,
            plan_order INTEGER NOT NULL DEFAULT 2147483647,
            task_order INTEGER NOT NULL DEFAULT 2147483647,
            queue_order INTEGER NOT NULL UNIQUE,
            plan_id TEXT,
            task_id TEXT,
            attempt_number INTEGER,
            attempt_id TEXT,
            parent_session_id TEXT,
            tool_call_id TEXT,
            session_id TEXT,
            process_id INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS delegated_agent_admissions_project_queue
            ON delegated_agent_admissions(project_key,state,priority,queue_order);
          CREATE INDEX IF NOT EXISTS delegated_agent_admissions_child
            ON delegated_agent_admissions(project_key,session_id,state);
          CREATE INDEX IF NOT EXISTS delegated_agent_admissions_plan
            ON delegated_agent_admissions(project_key,plan_id,task_id,state);
        `),
    )
    this.readyPromise = this.initialize()
  }

  private async initialize() {
    const projectKey = await this.projectKeyPromise
    this.resolvedProjectKey = projectKey
    // A core released while the key resolved: touching the repository would reopen its database.
    if (this.repository.isClosed) return projectKey
    const projectDirectory = canonicalDirectory(this.repository.projectDirectory)
    const now = this.clock.now()
    // The project registry (`registerProject`) owns lazers_projects and its paths; this only
    // backfills admissions for attempts already active in this checkout or the project's others.
    this.repository.atomic((db) => {
      registerLifecycleTransitions(db)
      this.backfillActiveAttempts(db, projectKey, projectDirectory, now)
    })
    return projectKey
  }

  private backfillActiveAttempts(
    db: Database,
    projectKey: string,
    projectDirectory: string,
    now: number,
  ) {
    // The runner schema belongs to the runner store; a database it has not prepared has no attempts.
    const hasAttempts = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runner_attempts','runner_plans','runner_nodes')",
      )
      .all()
    if (hasAttempts.length < 3) return
    const projectPaths = new Set([
      projectDirectory,
      canonicalDirectory(this.repository.projectDirectory),
      ...db
        .query<{ path: string }, [string]>("SELECT path FROM lazers_project_paths WHERE key=?")
        .all(projectKey)
        .map((row) => canonicalDirectory(row.path)),
    ])
    const attempts = db
      .query<
        {
          id: string
          project_directory: string
          plan_id: string
          task_id: string
          number: number
          priority: number
          plan_order: number
          task_order: number
          started_at: number
        },
        [string, ...string[]]
      >(
        `SELECT a.id,a.project_directory,a.plan_id,a.task_id,a.number,
                COALESCE(json_extract(p.body,'$.priority'),0) AS priority,
                p.rowid AS plan_order,n.ordinal AS task_order,a.started_at
         FROM runner_attempts a
          JOIN runner_plans p ON p.id=a.plan_id
          JOIN runner_nodes n ON n.plan_id=a.plan_id AND n.task_id=a.task_id
         WHERE a.state IN (${ACTIVE_ATTEMPT_STATES.map(() => "?").join(",")})`,
      )
      .all(...ACTIVE_ATTEMPT_STATES)
    for (const attempt of attempts)
      if (projectPaths.has(canonicalDirectory(attempt.project_directory)))
        this.backfillAttemptAdmission(db, projectKey, projectDirectory, attempt, now)
  }

  private backfillAttemptAdmission(
    db: Database,
    projectKey: string,
    projectDirectory: string,
    attempt: {
      id: string
      project_directory: string
      plan_id: string
      task_id: string
      number: number
      priority: number
      plan_order: number
      task_order: number
      started_at: number
    },
    now: number,
  ) {
    const requestKey = `runner:${attempt.plan_id}:${attempt.task_id}:${attempt.number}`
    const canonical = db
      .query<{ id: string; state: AdmissionState }, [string]>(
        "SELECT id,state FROM delegated_agent_admissions WHERE request_key=?",
      )
      .get(requestKey)
    const legacy = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM delegated_agent_admissions WHERE request_key=?",
      )
      .get(`runner-existing:${attempt.id}`)
    if (canonical) {
      db.query(
        `UPDATE delegated_agent_admissions
         SET project_key=?,project_directory=?,attempt_id=?,agent='lazers-implementor',
             priority=?,plan_order=?,task_order=?,plan_id=?,task_id=?,attempt_number=?,
             state=CASE WHEN state IN ('released','cancelled') THEN 'admitted' ELSE state END,
             updated_at=?
         WHERE id=?`,
      ).run(
        projectKey,
        attempt.project_directory || projectDirectory,
        attempt.id,
        attempt.priority,
        attempt.plan_order,
        attempt.task_order,
        attempt.plan_id,
        attempt.task_id,
        attempt.number,
        now,
        canonical.id,
      )
      if (legacy && legacy.id !== canonical.id)
        db.query(
          `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'released'),updated_at=?
           WHERE id=? AND state='admitted'`,
        ).run(now, legacy.id)
      return
    }
    if (legacy) {
      db.query(
        `UPDATE delegated_agent_admissions
         SET request_key=?,project_key=?,project_directory=?,state=lz_runner_transition('capacity',state,'admitted'),
             agent='lazers-implementor',priority=?,plan_order=?,task_order=?,plan_id=?,task_id=?,
             attempt_number=?,attempt_id=?,updated_at=?
         WHERE id=?`,
      ).run(
        requestKey,
        projectKey,
        attempt.project_directory || projectDirectory,
        attempt.priority,
        attempt.plan_order,
        attempt.task_order,
        attempt.plan_id,
        attempt.task_id,
        attempt.number,
        attempt.id,
        now,
        legacy.id,
      )
      return
    }
    db.query(
      `INSERT INTO delegated_agent_admissions
       (id,project_key,project_directory,request_key,kind,state,agent,priority,plan_order,
        task_order,queue_order,plan_id,task_id,attempt_number,attempt_id,created_at,updated_at)
       VALUES(?,?,?,?,'runner','admitted','lazers-implementor',?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attempt.id,
      projectKey,
      attempt.project_directory || projectDirectory,
      requestKey,
      attempt.priority,
      attempt.plan_order,
      attempt.task_order,
      nextQueueOrder(db),
      attempt.plan_id,
      attempt.task_id,
      attempt.number,
      attempt.id,
      attempt.started_at,
      now,
    )
  }

  async ready() {
    return this.readyPromise
  }

  private async projectKey() {
    return this.readyPromise
  }

  /** The project key whose `limit` in the Projects settings governs this capacity. */
  async key() {
    return this.readyPromise
  }

  private currentSettings(db: Database, projectKey: string) {
    return settingsRow(db, projectKey, canonicalDirectory(this.repository.projectDirectory))
  }

  private settle(db: Database, projectKey: string) {
    const now = this.clock.now()
    releaseDeadNativeOwners(db, projectKey, this.processID(), now)
    reconcileRunnerAdmissions(db, projectKey, now)
  }

  async settings(): Promise<DelegatedAgentStatus> {
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      this.settle(db, projectKey)
      const settings = this.currentSettings(db, projectKey)
      const queued = queuedAdmissionCount(db, projectKey)
      const status = { ...settings, active: activeCount(db, projectKey), queued, reason: null }
      return { ...status, reason: reasonFor(status) }
    })
  }

  /** Current status plus runtime candidates queued by this shared scheduler database. */
  async schedulingSnapshot() {
    return this.inspectionSnapshot()
  }

  async inspectionSnapshot() {
    const projectKey = await this.projectKey()
    return this.repository.read((db) => {
      const settings = this.currentSettings(db, projectKey)
      const queued = queuedAdmissionCount(db, projectKey)
      const queuedNative = db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM delegated_agent_admissions
           WHERE project_key=? AND kind='native' AND state='queued'`,
        )
        .get(projectKey)!.count
      const queuedRunnerTasks = db
        .query<{ plan_id: string; task_id: string }, [string]>(
          `SELECT plan_id,task_id FROM delegated_agent_admissions
           WHERE project_key=? AND kind='runner' AND state='queued'
             AND plan_id IS NOT NULL AND task_id IS NOT NULL
           ORDER BY queue_order LIMIT 5001`,
        )
        .all(projectKey)
      const status = {
        ...settings,
        active: activeCount(db, projectKey),
        queued,
        reason: null,
        queuedNative,
        queuedRunnerTasks: queuedRunnerTasks.slice(0, 5000).map((row) => ({
          planID: row.plan_id,
          taskID: row.task_id,
        })),
        queuedRunnerTasksComplete: queuedRunnerTasks.length <= 5000,
      }
      return {
        ...status,
        reason: reasonFor(status),
      }
    })
  }

  async ensureRunnerQueued(candidate: RunnerCandidate) {
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      this.settle(db, projectKey)
      return this.ensureRunnerQueuedInTransaction(db, candidate, projectKey)
    })
  }

  private ensureRunnerQueuedInTransaction(
    db: Database,
    candidate: RunnerCandidate,
    projectKey: string,
    options: { attemptID?: string; requeueAdmitted?: boolean } = {},
  ) {
    const ordering = db
      .query<
        { project_directory: string; priority: number; plan_order: number; task_order: number },
        [string, string, string]
      >(
        `SELECT p.project_directory,COALESCE(json_extract(p.body,'$.priority'),0) AS priority,
                p.rowid AS plan_order,n.ordinal AS task_order
         FROM runner_plans p JOIN runner_nodes n ON n.plan_id=p.id
         WHERE p.id=? AND n.task_id=? AND p.project_directory=?`,
      )
      .get(candidate.planID, candidate.taskID, this.repository.projectDirectory)
    if (!ordering) throw new Error("Runner candidate is no longer available for admission")

    const requestKey = `runner:${candidate.planID}:${candidate.taskID}:${candidate.attemptNumber}`
    const existing = db
      .query<{ id: string; state: AdmissionRow["state"] }, [string]>(
        "SELECT id,state FROM delegated_agent_admissions WHERE request_key=?",
      )
      .get(requestKey)
    if (existing?.state === "queued") {
      if (options.attemptID)
        db.query(
          "UPDATE delegated_agent_admissions SET attempt_id=?,updated_at=? WHERE id=? AND state='queued'",
        ).run(options.attemptID, this.clock.now(), existing.id)
      return existing.id
    }
    if (existing?.state === "admitted" && !options.requeueAdmitted) return existing.id

    const now = this.clock.now()
    const id = existing?.id ?? crypto.randomUUID()
    const attemptID = options.attemptID ?? null
    if (existing) {
      db.query(
        `UPDATE delegated_agent_admissions
         SET project_key=?,project_directory=?,state=lz_runner_transition('capacity',state,'queued'),priority=?,plan_order=?,task_order=?,
             queue_order=?,plan_id=?,task_id=?,attempt_number=?,attempt_id=?,process_id=NULL,
             created_at=?,updated_at=?
         WHERE id=?`,
      ).run(
        projectKey,
        ordering.project_directory,
        ordering.priority,
        ordering.plan_order,
        ordering.task_order,
        nextQueueOrder(db),
        candidate.planID,
        candidate.taskID,
        candidate.attemptNumber,
        attemptID,
        now,
        now,
        id,
      )
    } else {
      db.query(
        `INSERT INTO delegated_agent_admissions
         (id,project_key,project_directory,request_key,kind,state,agent,priority,plan_order,
          task_order,queue_order,plan_id,task_id,attempt_number,attempt_id,created_at,updated_at)
         VALUES(?,?,?,?,'runner','queued','lazers-implementor',?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        projectKey,
        ordering.project_directory,
        requestKey,
        ordering.priority,
        ordering.plan_order,
        ordering.task_order,
        nextQueueOrder(db),
        candidate.planID,
        candidate.taskID,
        candidate.attemptNumber,
        attemptID,
        now,
        now,
      )
    }
    return id
  }

  /** Queue a reused attempt in the command transaction before it returns to preparing. */
  requeueRunnerInTransaction(db: Database, candidate: RunnerCandidate, attemptID: string) {
    const projectKey = this.resolvedProjectKey
    if (!projectKey) throw new Error("Delegated-agent project identity is not ready")
    this.settle(db, projectKey)
    return this.ensureRunnerQueuedInTransaction(db, candidate, projectKey, {
      attemptID,
      requeueAdmitted: true,
    })
  }

  /**
   * An Architect takeover holds the task's slot: in the takeover's own transaction the worker's
   * admission is released and the Architect's attempt is admitted, so the task counts once. It is
   * never queued or refused, even above the limit (the limit reason then says active work is
   * finishing without preemption).
   */
  holdTaskSlotInTransaction(
    db: Database,
    candidate: RunnerCandidate,
    attemptID: string,
    fromAttemptID?: string,
  ) {
    const projectKey = this.resolvedProjectKey
    if (!projectKey) return
    const now = this.clock.now()
    if (fromAttemptID)
      db.query(
        `UPDATE delegated_agent_admissions
         SET state=lz_runner_transition('capacity',state,'released'),updated_at=?
         WHERE kind='runner' AND attempt_id=? AND state='admitted'`,
      ).run(now, fromAttemptID)
    const requestID = this.ensureRunnerQueuedInTransaction(db, candidate, projectKey, {
      attemptID,
      requeueAdmitted: true,
    })
    db.query(
      `UPDATE delegated_agent_admissions
       SET state=lz_runner_transition('capacity',state,'admitted'),attempt_id=?,process_id=?,updated_at=?
       WHERE id=? AND state='queued'`,
    ).run(attemptID, this.processID(), now, requestID)
  }

  /** Atomically reserves the reused attempt's slot immediately before native execution. */
  async admitRunnerAttempt(candidate: RunnerCandidate, attemptID: string) {
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      this.settle(db, projectKey)
      const requestID = this.ensureRunnerQueuedInTransaction(db, candidate, projectKey, {
        attemptID,
      })
      const existing = db
        .query<{ state: AdmissionState; attempt_id: string | null }, [string]>(
          "SELECT state,attempt_id FROM delegated_agent_admissions WHERE id=?",
        )
        .get(requestID)
      if (existing?.state === "admitted") return existing.attempt_id === attemptID
      return (
        tryAdmitQueued(db, {
          requestID,
          projectKey,
          projectDirectory: this.repository.projectDirectory,
          kind: "runner",
          processID: this.processID(),
          now: this.clock.now(),
          attemptID,
        }) === "admitted"
      )
    })
  }

  async cancelRunnerQueue(planID: string, keepTaskIDs: readonly string[] = []) {
    const projectKey = await this.projectKey()
    const queued = (db: Database) =>
      db
        .query<{ id: string; task_id: string }, [string, string]>(
          `SELECT id,task_id FROM delegated_agent_admissions
           WHERE project_key=? AND kind='runner' AND state='queued' AND plan_id=?`,
        )
        .all(projectKey, planID)
    const keep = new Set(keepTaskIDs)
    // Nothing queued is the idle case: it takes no write lock.
    if (this.repository.read((db) => queued(db).every((entry) => keep.has(entry.task_id)))) return
    this.repository.atomic((db) => {
      const candidates = queued(db)
      for (const candidate of candidates)
        if (!keep.has(candidate.task_id))
          db.query(
            `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'cancelled'),updated_at=?
             WHERE id=? AND state='queued'`,
          ).run(this.clock.now(), candidate.id)
    })
  }

  async cancelRunnerRequest(requestID: string) {
    await this.projectKey()
    this.repository.atomic((db) => {
      transitionAdmission(db, {
        id: requestID,
        kind: "runner",
        from: ["queued"],
        to: "cancelled",
        now: this.clock.now(),
      })
    })
  }

  /** A scope/prerequisite-blocked continuation must not head the capacity queue. */
  async cancelRunnerAttemptQueue(attemptID: string) {
    const projectKey = await this.projectKey()
    this.repository.atomic((db) =>
      db
        .query(
          `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'cancelled'),updated_at=?
         WHERE project_key=? AND kind='runner' AND attempt_id=? AND state='queued'`,
        )
        .run(this.clock.now(), projectKey, attemptID),
    )
  }

  /** Called inside the same fenced write transaction that inserts the attempt row. */
  admitRunnerInTransaction(db: Database, requestID: string, attemptID: string) {
    const projectKey = this.resolvedProjectKey
    if (!projectKey) throw new Error("Delegated-agent project identity is not ready")
    this.settle(db, projectKey)
    return (
      tryAdmitQueued(db, {
        requestID,
        projectKey,
        projectDirectory: this.repository.projectDirectory,
        kind: "runner",
        processID: this.processID(),
        now: this.clock.now(),
        attemptID,
      }) === "admitted"
    )
  }

  async ensureNativeQueued(input: NativeRequest) {
    const projectKey = await this.projectKey()
    const now = this.clock.now()
    return this.repository.atomic((db) => {
      let existing: { id: string; state: AdmissionRow["state"] } | null | undefined
      if (input.existingSessionID)
        existing = db
          .query<{ id: string; state: AdmissionRow["state"] }, [string, string, string]>(
            `SELECT id,state FROM delegated_agent_admissions
              WHERE project_key=? AND kind='native' AND session_id=? AND parent_session_id=?
                AND state='admitted'`,
          )
          .get(projectKey, input.existingSessionID, input.parentSessionID)
      existing ??= db
        .query<{ id: string; state: AdmissionRow["state"] }, [string]>(
          `SELECT id,state FROM delegated_agent_admissions WHERE request_key=?`,
        )
        .get(`native:${input.parentSessionID}:${input.toolCallID}`)
      const id = existing?.id ?? crypto.randomUUID()
      const requestKey = `native:${input.parentSessionID}:${input.toolCallID}`
      if (existing?.state === "admitted") {
        // Renew callback ownership, not the execution's start boundary. A
        // followup can join the very first loop, with no prior native idle time.
        db.query(
          `UPDATE delegated_agent_admissions
            SET request_key=?,parent_session_id=?,tool_call_id=?,agent=?,description=?,process_id=?,updated_at=?
           WHERE id=?`,
        ).run(
          requestKey,
          input.parentSessionID,
          input.toolCallID,
          input.agent,
          input.description,
          this.processID(),
          now,
          id,
        )
        return id
      }
      if (existing) {
        db.query(
          `UPDATE delegated_agent_admissions
            SET request_key=?,project_key=?,project_directory=?,state=lz_runner_transition('capacity',state,'queued'),agent=?,description=?,
                priority=0,plan_order=?,task_order=?,queue_order=?,parent_session_id=?,tool_call_id=?,
                session_id=?,process_id=?,created_at=?,updated_at=?
           WHERE id=?`,
        ).run(
          requestKey,
          projectKey,
          canonicalDirectory(this.repository.projectDirectory),
          input.agent,
          input.description,
          MAX_SQLITE_INTEGER,
          MAX_SQLITE_INTEGER,
          nextQueueOrder(db),
          input.parentSessionID,
          input.toolCallID,
          input.existingSessionID ?? null,
          this.processID(),
          now,
          now,
          id,
        )
      } else {
        db.query(
          `INSERT INTO delegated_agent_admissions
           (id,project_key,project_directory,request_key,kind,state,agent,description,priority,
            plan_order,task_order,queue_order,parent_session_id,tool_call_id,session_id,process_id,
            created_at,updated_at)
           VALUES(?,?,?,?,'native','queued',?,?,0,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          projectKey,
          canonicalDirectory(this.repository.projectDirectory),
          requestKey,
          input.agent,
          input.description,
          MAX_SQLITE_INTEGER,
          MAX_SQLITE_INTEGER,
          nextQueueOrder(db),
          input.parentSessionID,
          input.toolCallID,
          input.existingSessionID ?? null,
          this.processID(),
          now,
          now,
        )
      }
      return id
    })
  }

  async waitForNative(requestID: string, signal: AbortSignal) {
    const projectKey = await this.projectKey()
    try {
      for (;;) {
        signal.throwIfAborted()
        const admitted = this.repository.atomic((db) => {
          this.settle(db, projectKey)
          const result = tryAdmitQueued(db, {
            requestID,
            projectKey,
            projectDirectory: this.repository.projectDirectory,
            kind: "native",
            processID: this.processID(),
            now: this.clock.now(),
          })
          if (result === "unavailable") throw new Error("Delegated-agent request is unavailable")
          if (result === "waiting") {
            const state = db
              .query<{ state: AdmissionState }, [string]>(
                "SELECT state FROM delegated_agent_admissions WHERE id=? AND kind='native'",
              )
              .get(requestID)?.state
            if (state === "cancelled" || state === "released")
              throw new Error("Delegated-agent request is no longer available")
          }
          return result === "admitted" || result === "already-admitted"
        })
        if (admitted) return
        await this.clock.sleep(150, signal)
      }
    } catch (error) {
      this.repository.atomic((db) =>
        db
          .query(
            `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'cancelled'),updated_at=?
             WHERE id=? AND kind='native' AND state='queued'`,
          )
          .run(this.clock.now(), requestID),
      )
      throw error
    }
  }

  async nativeRequest(parentSessionID: string, toolCallID: string) {
    await this.projectKey()
    return this.repository.read((db) =>
      db
        .query<AdmissionRow, [string, string]>(
          `SELECT id,request_key,kind,state,parent_session_id,tool_call_id,agent,description,session_id
           FROM delegated_agent_admissions
           WHERE kind='native' AND parent_session_id=? AND tool_call_id=?`,
        )
        .get(parentSessionID, toolCallID),
    )
  }

  async nativeRequestForChild(parentSessionID: string, agent: string, description: string) {
    await this.projectKey()
    return this.repository.read((db) =>
      db
        .query<AdmissionRow, [string, string, string]>(
          `SELECT id,request_key,kind,state,parent_session_id,tool_call_id,agent,description,session_id
           FROM delegated_agent_admissions
           WHERE kind='native' AND state='admitted' AND parent_session_id=?
             AND agent=? AND description=? AND session_id IS NULL
           ORDER BY queue_order LIMIT 1`,
        )
        .get(parentSessionID, agent, description),
    )
  }

  async isLazersNativeParent(sessionID: string) {
    const projectKey = await this.projectKey()
    return this.repository.read((db) => {
      const paths = new Set([
        canonicalDirectory(this.repository.projectDirectory),
        ...db
          .query<{ path: string }, [string]>("SELECT path FROM lazers_project_paths WHERE key=?")
          .all(projectKey)
          .map((row) => canonicalDirectory(row.path)),
      ])
      const attempts = db
        .query<{ project_directory: string }, [string, ...string[]]>(
          `SELECT DISTINCT COALESCE(a.project_directory,p.project_directory) AS project_directory
           FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
           WHERE a.session_id=? AND a.state IN (${ACTIVE_ATTEMPT_STATES.map(() => "?").join(",")})`,
        )
        .all(sessionID, ...ACTIVE_ATTEMPT_STATES)
      if (attempts.some((attempt) => paths.has(canonicalDirectory(attempt.project_directory))))
        return true
      const plans = db
        .query<{ project_directory: string }, [string]>(
          `SELECT DISTINCT project_directory FROM runner_plans
           WHERE owner=? AND state NOT IN ('integrated','cancelled','failed')`,
        )
        .all(sessionID)
      if (plans.some((plan) => paths.has(canonicalDirectory(plan.project_directory)))) return true
      return Boolean(
        db
          .query<{ found: number }, [string, string]>(
            `SELECT 1 AS found FROM delegated_agent_admissions
             WHERE project_key=? AND kind='native' AND session_id=? AND state<>'cancelled'
             LIMIT 1`,
          )
          .get(projectKey, sessionID),
      )
    })
  }

  async admittedNativeExecutions(): Promise<NativeExecution[]> {
    const projectKey = await this.projectKey()
    return this.repository.read((db) =>
      db
        .query<
          { id: string; request_key: string; session_id: string; created_at: number },
          [string]
        >(
          `SELECT id,request_key,session_id,created_at FROM delegated_agent_admissions
           WHERE project_key=? AND kind='native' AND state='admitted' AND session_id IS NOT NULL`,
        )
        .all(projectKey)
        .map((row) => ({
          id: row.id,
          key: row.request_key,
          sessionID: row.session_id,
          createdAt: row.created_at,
        })),
    )
  }

  async nativeExecution(sessionID: string) {
    const projectKey = await this.projectKey()
    return this.repository.read((db) => {
      const row = db
        .query<
          { id: string; request_key: string; session_id: string; created_at: number },
          [string, string]
        >(
          `SELECT id,request_key,session_id,created_at FROM delegated_agent_admissions
         WHERE project_key=? AND kind='native' AND session_id=? AND state='admitted'
         ORDER BY queue_order DESC LIMIT 1`,
        )
        .get(projectKey, sessionID)
      return row
        ? { id: row.id, key: row.request_key, sessionID: row.session_id, createdAt: row.created_at }
        : undefined
    })
  }

  async bindNativeChild(requestID: string, sessionID: string) {
    await this.projectKey()
    return this.repository.atomic(
      (db) =>
        db
          .query(
            `UPDATE delegated_agent_admissions SET session_id=?,updated_at=?
           WHERE id=? AND kind='native' AND state='admitted'
             AND (session_id IS NULL OR session_id=?)`,
          )
          .run(sessionID, this.clock.now(), requestID, sessionID).changes === 1,
    )
  }

  async bindNativeChildFromCreatedSession(input: {
    sessionID: string
    parentSessionID: string
    agent: string
    description: string
  }) {
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      const request = db
        .query<{ id: string }, [string, string, string, string]>(
          `SELECT id FROM delegated_agent_admissions
           WHERE project_key=? AND kind='native' AND state='admitted'
             AND parent_session_id=? AND agent=? AND description=? AND session_id IS NULL
            ORDER BY queue_order LIMIT 2`,
        )
        .all(projectKey, input.parentSessionID, input.agent, input.description)
      if (request.length !== 1) return undefined
      const changed = db
        .query(
          `UPDATE delegated_agent_admissions SET session_id=?,updated_at=?
           WHERE id=? AND state='admitted' AND session_id IS NULL`,
        )
        .run(input.sessionID, this.clock.now(), request[0]!.id).changes
      return changed === 1 ? request[0]!.id : undefined
    })
  }

  async releaseNativeRequest(requestID: string, requestKey?: string) {
    await this.projectKey()
    return this.repository.atomic(
      (db) =>
        db
          .query(
            `UPDATE delegated_agent_admissions SET state=lz_runner_transition('capacity',state,'released'),updated_at=?
            WHERE id=? AND kind='native' AND state IN ('queued','admitted')
              AND (? IS NULL OR request_key=?)`,
          )
          .run(this.clock.now(), requestID, requestKey ?? null, requestKey ?? null).changes === 1,
    )
  }
}
