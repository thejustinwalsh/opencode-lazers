import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"

export const DEFAULT_DELEGATED_AGENT_LIMIT = 3
const ACTIVE_ATTEMPT_STATES = ["preparing", "running", "verifying"] as const
const MAX_SQLITE_INTEGER = 2_147_483_647

export const DelegatedAgentLimit = z.number().int().min(1).max(MAX_SQLITE_INTEGER)
export const DelegatedAgentSettingsInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  limit: DelegatedAgentLimit,
})

export type DelegatedAgentSettings = {
  projectDirectory: string
  revision: number
  limit: number
}

export type DelegatedAgentStatus = DelegatedAgentSettings & {
  active: number
  queued: number
  reason: string | null
}

export type DelegatedAgentSettingsWrite =
  | { status: "updated"; settings: DelegatedAgentSettings }
  | {
      status: "conflict"
      expectedRevision: number
      currentRevision: number
      current: DelegatedAgentSettings
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
  return `${state} IN ('preparing','running','verifying')`
}

function settingsRow(db: Database, projectKey: string, projectDirectory: string) {
  const row = db
    .query<{ revision: number; agent_limit: number }, [string]>(
      "SELECT revision,agent_limit FROM delegated_agent_settings WHERE project_key=?",
    )
    .get(projectKey)
  return {
    projectDirectory,
    revision: row?.revision ?? 0,
    limit: row?.agent_limit ?? DEFAULT_DELEGATED_AGENT_LIMIT,
  }
}

function nextQueueOrder(db: Database) {
  return db
    .query<{ next: number }, []>(
      "SELECT COALESCE(MAX(queue_order),0)+1 AS next FROM delegated_agent_admissions",
    )
    .get()!.next
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
     SET state='released',updated_at=?
     WHERE project_key=? AND kind='runner' AND state='admitted'
       AND NOT EXISTS (
         SELECT 1 FROM runner_attempts r
         WHERE r.id=delegated_agent_admissions.attempt_id
           AND ${activeRunnerStateSQL("r")}
       )`,
  ).run(now, projectKey)
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
       WHERE project_key=? AND kind='native' AND state='admitted'`,
    )
    .all(projectKey)
  for (const row of rows) {
    if (!row.process_id || row.process_id === currentPID) continue
    try {
      process.kill(row.process_id, 0)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM")
        continue
      db.query(
        `UPDATE delegated_agent_admissions SET state='released',updated_at=?
         WHERE id=? AND state='admitted'`,
      ).run(now, row.id)
    }
  }
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

function reasonFor(status: Pick<DelegatedAgentStatus, "active" | "queued" | "limit">) {
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
    repository.installSchema(
      "delegated-agent-capacity",
      1,
      ["delegated_agent_settings", "delegated_agent_admissions"],
      (db) =>
        db.exec(`
          CREATE TABLE IF NOT EXISTS delegated_agent_settings (
            project_key TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            agent_limit INTEGER NOT NULL CHECK(agent_limit>0),
            updated_at INTEGER NOT NULL
          );
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
    const projectDirectory = canonicalDirectory(this.repository.projectDirectory)
    const now = this.clock.now()
    this.repository.atomic((db) => {
      db.query(
        `INSERT OR IGNORE INTO delegated_agent_settings
         (project_key,revision,agent_limit,updated_at) VALUES(?,0,?,?)`,
      ).run(projectKey, DEFAULT_DELEGATED_AGENT_LIMIT, now)
      db.query(
        `INSERT INTO lazers_projects(key,created_at,remote_url,root_commit)
         VALUES(?,?,NULL,NULL) ON CONFLICT(key) DO NOTHING`,
      ).run(projectKey, new Date(now).toISOString())
      db.query(
        `INSERT INTO lazers_project_paths(path,key,last_seen_at) VALUES(?,?,?)
         ON CONFLICT(path) DO UPDATE SET key=excluded.key,last_seen_at=excluded.last_seen_at`,
      ).run(projectDirectory, projectKey, new Date(now).toISOString())
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
         WHERE a.project_directory IN (SELECT path FROM lazers_project_paths WHERE key=?)
           AND a.state IN (${ACTIVE_ATTEMPT_STATES.map(() => "?").join(",")})`,
      )
      .all(projectKey, ...ACTIVE_ATTEMPT_STATES)
    for (const attempt of attempts)
      db.query(
        `INSERT OR IGNORE INTO delegated_agent_admissions
         (id,project_key,project_directory,request_key,kind,state,agent,priority,plan_order,
          task_order,queue_order,plan_id,task_id,attempt_number,attempt_id,created_at,updated_at)
         VALUES(?,?,?,?,'runner','admitted','lazers-implementor',?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        attempt.id,
        projectKey,
        attempt.project_directory || projectDirectory,
        `runner-existing:${attempt.id}`,
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
      const queued = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM delegated_agent_admissions WHERE project_key=? AND state='queued'",
        )
        .get(projectKey)!.count
      const status = { ...settings, active: activeCount(db, projectKey), queued, reason: null }
      return { ...status, reason: reasonFor(status) }
    })
  }

  async configure(input: unknown): Promise<DelegatedAgentSettingsWrite> {
    const update = DelegatedAgentSettingsInput.parse(input)
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      const current = this.currentSettings(db, projectKey)
      if (current.revision !== update.expectedRevision)
        return {
          status: "conflict" as const,
          expectedRevision: update.expectedRevision,
          currentRevision: current.revision,
          current,
        }
      const next = {
        ...current,
        revision: current.revision + 1,
        limit: update.limit,
      }
      db.query(
        `UPDATE delegated_agent_settings SET revision=?,agent_limit=?,updated_at=?
         WHERE project_key=? AND revision=?`,
      ).run(next.revision, next.limit, this.clock.now(), projectKey, current.revision)
      return { status: "updated" as const, settings: next }
    })
  }

  /** Current status plus runtime candidates queued by this shared scheduler database. */
  async schedulingSnapshot() {
    return this.inspectionSnapshot()
  }

  async inspectionSnapshot() {
    const projectKey = await this.projectKey()
    return this.repository.atomic((db) => {
      this.settle(db, projectKey)
      const settings = this.currentSettings(db, projectKey)
      const queued = db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM delegated_agent_admissions
           WHERE project_key=? AND state='queued'`,
        )
        .get(projectKey)!.count
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
    const requestKey = `runner:${candidate.planID}:${candidate.taskID}:${candidate.attemptNumber}`
    const now = this.clock.now()
    return this.repository.atomic((db) => {
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
      const existing = db
        .query<{ id: string; state: AdmissionRow["state"] }, [string]>(
          "SELECT id,state FROM delegated_agent_admissions WHERE request_key=?",
        )
        .get(requestKey)
      if (existing?.state === "queued" || existing?.state === "admitted") return existing.id
      const id = existing?.id ?? crypto.randomUUID()
      if (existing) {
        db.query(
          `UPDATE delegated_agent_admissions
           SET project_key=?,project_directory=?,state='queued',priority=?,plan_order=?,task_order=?,
               queue_order=?,plan_id=?,task_id=?,attempt_number=?,attempt_id=NULL,created_at=?,updated_at=?
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
          now,
          now,
          id,
        )
      } else {
        db.query(
          `INSERT INTO delegated_agent_admissions
           (id,project_key,project_directory,request_key,kind,state,agent,priority,plan_order,
            task_order,queue_order,plan_id,task_id,attempt_number,created_at,updated_at)
           VALUES(?,?,?,?,'runner','queued','lazers-implementor',?,?,?,?,?,?,?,?,?)`,
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
          now,
          now,
        )
      }
      return id
    })
  }

  async cancelRunnerQueue(planID: string, keepTaskIDs: readonly string[] = []) {
    const projectKey = await this.projectKey()
    this.repository.atomic((db) => {
      const candidates = db
        .query<{ id: string; task_id: string }, [string, string]>(
          `SELECT id,task_id FROM delegated_agent_admissions
           WHERE project_key=? AND kind='runner' AND state='queued' AND plan_id=?`,
        )
        .all(projectKey, planID)
      const keep = new Set(keepTaskIDs)
      for (const candidate of candidates)
        if (!keep.has(candidate.task_id))
          db.query(
            `UPDATE delegated_agent_admissions SET state='cancelled',updated_at=?
             WHERE id=? AND state='queued'`,
          ).run(this.clock.now(), candidate.id)
    })
  }

  async cancelRunnerRequest(requestID: string) {
    await this.projectKey()
    this.repository.atomic((db) =>
      db
        .query(
          `UPDATE delegated_agent_admissions SET state='cancelled',updated_at=?
           WHERE id=? AND kind='runner' AND state='queued'`,
        )
        .run(this.clock.now(), requestID),
    )
  }

  /** Called inside the same fenced write transaction that inserts the attempt row. */
  admitRunnerInTransaction(db: Database, requestID: string, attemptID: string) {
    const projectKey = this.resolvedProjectKey
    if (!projectKey) throw new Error("Delegated-agent project identity is not ready")
    this.settle(db, projectKey)
    const request = db
      .query<{ id: string; state: AdmissionRow["state"] }, [string, string]>(
        `SELECT id,state FROM delegated_agent_admissions
         WHERE id=? AND project_key=? AND kind='runner'`,
      )
      .get(requestID, projectKey)
    if (!request || request.state !== "queued") return false
    const settings = this.currentSettings(db, projectKey)
    if (
      activeCount(db, projectKey) >= settings.limit ||
      nextQueuedAdmission(db, projectKey) !== requestID
    )
      return false
    db.query(
      `UPDATE delegated_agent_admissions
       SET state='admitted',attempt_id=?,process_id=?,updated_at=?
       WHERE id=? AND state='queued'`,
    ).run(attemptID, this.processID(), this.clock.now(), requestID)
    return true
  }

  async ensureNativeQueued(input: NativeRequest) {
    const projectKey = await this.projectKey()
    const now = this.clock.now()
    return this.repository.atomic((db) => {
      let existing: { id: string; state: AdmissionRow["state"] } | null | undefined
      if (input.existingSessionID)
        existing = db
          .query<{ id: string; state: AdmissionRow["state"] }, [string, string]>(
            `SELECT id,state FROM delegated_agent_admissions
             WHERE project_key=? AND kind='native' AND session_id=?`,
          )
          .get(projectKey, input.existingSessionID)
      existing ??= db
        .query<{ id: string; state: AdmissionRow["state"] }, [string]>(
          `SELECT id,state FROM delegated_agent_admissions WHERE request_key=?`,
        )
        .get(`native:${input.parentSessionID}:${input.toolCallID}`)
      const id = existing?.id ?? crypto.randomUUID()
      const requestKey = `native:${input.parentSessionID}:${input.toolCallID}`
      if (existing?.state === "admitted") {
        db.query(
          `UPDATE delegated_agent_admissions
           SET parent_session_id=?,tool_call_id=?,agent=?,description=?,updated_at=?
           WHERE id=?`,
        ).run(input.parentSessionID, input.toolCallID, input.agent, input.description, now, id)
        return id
      }
      if (existing) {
        db.query(
          `UPDATE delegated_agent_admissions
           SET request_key=?,project_key=?,project_directory=?,state='queued',agent=?,description=?,
               priority=0,plan_order=?,task_order=?,queue_order=?,parent_session_id=?,tool_call_id=?,
               session_id=?,process_id=NULL,created_at=?,updated_at=?
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
          now,
          now,
          id,
        )
      } else {
        db.query(
          `INSERT INTO delegated_agent_admissions
           (id,project_key,project_directory,request_key,kind,state,agent,description,priority,
            plan_order,task_order,queue_order,parent_session_id,tool_call_id,session_id,created_at,updated_at)
           VALUES(?,?,?,?,'native','queued',?,?,0,?,?,?,?,?,?,?,?)`,
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
          const request = db
            .query<{ state: AdmissionRow["state"] }, [string, string]>(
              `SELECT state FROM delegated_agent_admissions
               WHERE id=? AND project_key=? AND kind='native'`,
            )
            .get(requestID, projectKey)
          if (!request) throw new Error("Delegated-agent request is unavailable")
          if (request.state === "admitted") return true
          if (request.state !== "queued") return false
          const settings = this.currentSettings(db, projectKey)
          if (
            activeCount(db, projectKey) >= settings.limit ||
            nextQueuedAdmission(db, projectKey) !== requestID
          )
            return false
          db.query(
            `UPDATE delegated_agent_admissions SET state='admitted',process_id=?,updated_at=?
             WHERE id=? AND state='queued'`,
          ).run(this.processID(), this.clock.now(), requestID)
          return true
        })
        if (admitted) return
        await this.clock.sleep(150, signal)
      }
    } catch (error) {
      this.repository.atomic((db) =>
        db
          .query(
            `UPDATE delegated_agent_admissions SET state='cancelled',updated_at=?
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

  async bindNativeChild(requestID: string, sessionID: string) {
    await this.projectKey()
    this.repository.atomic((db) =>
      db
        .query(
          `UPDATE delegated_agent_admissions SET session_id=?,updated_at=?
           WHERE id=? AND kind='native' AND state='admitted'`,
        )
        .run(sessionID, this.clock.now(), requestID),
    )
  }

  async observeNativeIdle(input: {
    sessionID: string
    parentSessionID: string
    agent: string
    description: string
  }) {
    const projectKey = await this.projectKey()
    this.repository.atomic((db) => {
      const row = db
        .query<{ id: string }, [string, string, string, string, string]>(
          `SELECT id FROM delegated_agent_admissions
           WHERE project_key=? AND kind='native' AND state='admitted'
             AND parent_session_id=? AND agent=? AND description=?
             AND (session_id IS NULL OR session_id=?) ORDER BY queue_order LIMIT 1`,
        )
        .get(projectKey, input.parentSessionID, input.agent, input.description, input.sessionID)
      if (!row) return
      db.query(
        `UPDATE delegated_agent_admissions SET session_id=?,state='released',updated_at=?
         WHERE id=? AND state='admitted'`,
      ).run(input.sessionID, this.clock.now(), row.id)
    })
  }

  async releaseNativeRequest(requestID: string) {
    await this.projectKey()
    this.repository.atomic((db) =>
      db
        .query(
          `UPDATE delegated_agent_admissions SET state='released',updated_at=?
           WHERE id=? AND kind='native' AND state IN ('queued','admitted')`,
        )
        .run(this.clock.now(), requestID),
    )
  }

  async releaseNativeChild(sessionID: string) {
    const projectKey = await this.projectKey()
    this.repository.atomic((db) =>
      db
        .query(
          `UPDATE delegated_agent_admissions SET state='released',updated_at=?
           WHERE project_key=? AND kind='native' AND session_id=? AND state='admitted'`,
        )
        .run(this.clock.now(), projectKey, sessionID),
    )
  }
}
