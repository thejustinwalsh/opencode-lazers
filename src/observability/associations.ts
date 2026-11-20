import type { Database } from "bun:sqlite"
import { observationRevisionStamp, StampGate } from "../core/stamp-gate.ts"

export type SessionAssociations = {
  taskIDs: Set<string>
  planIDs: Set<string>
}

/** Resolve only durable submission, plan-owner, and worker-attempt links. */
export function sessionAssociations(
  db: Database,
  projectDirectory: string,
  sessionID: string,
): SessionAssociations {
  const taskIDs = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM tasks WHERE project_directory=? AND CASE WHEN json_valid(body) THEN json_extract(body,'$.provenance.sessionID') END=?",
      )
      .all(projectDirectory, sessionID)
      .map((row) => row.id),
  )
  const planIDs = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner_plans WHERE project_directory=? AND owner=?",
      )
      .all(projectDirectory, sessionID)
      .map((row) => row.id),
  )
  for (const row of db
    .query<{ task_id: string; plan_id: string }, [string, string]>(
      `SELECT DISTINCT a.task_id,a.plan_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id
       WHERE p.project_directory=? AND a.session_id=?`,
    )
    .all(projectDirectory, sessionID)) {
    taskIDs.add(row.task_id)
    planIDs.add(row.plan_id)
  }
  for (const row of db
    .query<{ id: string }, [string, string, string]>(
      `SELECT c.plan_id AS id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id
       WHERE p.project_directory=? AND (c.session_id=? OR c.parent_id=?)`,
    )
    .all(projectDirectory, sessionID, sessionID))
    planIDs.add(row.id)

  if (taskIDs.size > 0) {
    const ids = [...taskIDs]
    const placeholders = ids.map(() => "?").join(",")
    for (const row of db
      .query<{ plan_id: string }, (string | number)[]>(
        `SELECT DISTINCT n.plan_id FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id
         WHERE p.project_directory=? AND n.task_id IN (${placeholders})`,
      )
      .all(projectDirectory, ...ids))
      planIDs.add(row.plan_id)
  }

  if (planIDs.size > 0) {
    const ids = [...planIDs]
    const placeholders = ids.map(() => "?").join(",")
    for (const row of db
      .query<{ task_id: string }, (string | number)[]>(
        `SELECT task_id FROM runner_nodes WHERE plan_id IN (${placeholders})`,
      )
      .all(...ids))
      taskIDs.add(row.task_id)
  }
  return { taskIDs, planIDs }
}

export function projectAssociations(db: Database, projectDirectory: string): SessionAssociations {
  return {
    taskIDs: new Set(
      db
        .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE project_directory=?")
        .all(projectDirectory)
        .map((row) => row.id),
    ),
    planIDs: new Set(
      db
        .query<{ id: string }, [string]>("SELECT id FROM runner_plans WHERE project_directory=?")
        .all(projectDirectory)
        .map((row) => row.id),
    ),
  }
}

/**
 * Every session id the project's tasks, plans, attempts and continuations name. The caller needs
 * a set of session ids, so each statement returns DISTINCT ids (rows are bounded by the number of
 * sessions, not by tasks or attempts) and the NULL provenance of tasks without one is dropped in
 * SQL. Run it through {@link projectSessionIDs} so an unchanged project reads nothing.
 */
export function associatedSessionIDs(db: Database, projectDirectory: string) {
  const ids = new Set<string>()
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT DISTINCT session_id FROM (
         SELECT CASE WHEN json_valid(body) THEN json_extract(body,'$.provenance.sessionID') END AS session_id
         FROM tasks WHERE project_directory=?
       ) WHERE session_id IS NOT NULL AND session_id<>''`,
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      "SELECT DISTINCT owner AS session_id FROM runner_plans WHERE project_directory=?",
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT DISTINCT a.session_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string | null }, [string]>(
      `SELECT DISTINCT c.session_id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id
       WHERE p.project_directory=? AND c.session_id IS NOT NULL AND c.session_id<>''`,
    )
    .all(projectDirectory))
    ids.add(row.session_id!)
  for (const row of db
    .query<{ parent_id: string | null }, [string]>(
      `SELECT DISTINCT c.parent_id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id
       WHERE p.project_directory=? AND c.parent_id IS NOT NULL AND c.parent_id<>''`,
    )
    .all(projectDirectory))
    ids.add(row.parent_id!)
  return ids
}

/**
 * Gate instances, one per observation secret (one per core), like the topology gate. The stamp
 * is the project's observation revision: every write to tasks, plans, attempts and continuations
 * bumps it (source-revision.ts), so an unchanged project returns the held list and reads nothing.
 * Each entry is one id list per project and location database; the byte budget is a ceiling for
 * many projects, estimated at 40 bytes an id and not measured on live data.
 */
const sessionGates = new WeakMap<Uint8Array, StampGate<string[]>>()

/** {@link associatedSessionIDs}, read once per observation revision. Returns a fresh set. */
export function projectSessionIDs(
  db: Database,
  projectDirectory: string,
  secret: Uint8Array,
): Set<string> {
  let gate = sessionGates.get(secret)
  if (!gate) {
    gate = new StampGate<string[]>({ maxBytes: 4 * 1024 * 1024 })
    sessionGates.set(secret, gate)
  }
  return new Set(
    gate.runSync(
      JSON.stringify([db.filename, projectDirectory]),
      observationRevisionStamp(db, projectDirectory),
      () => [...associatedSessionIDs(db, projectDirectory)],
    ),
  )
}

type MembershipState = {
  tasks: Set<string>
  taskMaxRowid: number
  taskCount: number
  attempts: Set<string>
  attemptMaxRowid: number
  attemptCount: number
}

export type AssociationIndex = {
  /** Same result as {@link associatedSessionIDs}, maintained incrementally. */
  read(db: Database, projectDirectory: string): Set<string>
  /** Test hook: count of full rebuilds. */
  readonly rebuilds: number
}

const TASK_BATCH = 500

/**
 * Incremental session membership for one database. Task provenance and attempt session ids
 * are immutable, so those tables are read as a rowid delta (verified by count and max rowid;
 * any disagreement triggers a full rebuild). Plans and continuations are tiny and are
 * updated in place (renewals), so they are re-read each time.
 */
export function createAssociationIndex(): AssociationIndex {
  const states = new Map<string, MembershipState>()
  let rebuilds = 0
  const taskSession = (row: { body_session: string | null }) => row.body_session
  const readTasks = (db: Database, projectDirectory: string, state: MembershipState) => {
    const head = db
      .query<{ count: number; max: number }, [string]>(
        "SELECT COUNT(*) AS count, COALESCE(MAX(rowid),0) AS max FROM tasks WHERE project_directory=?",
      )
      .get(projectDirectory)!
    if (head.max < state.taskMaxRowid || head.count < state.taskCount) return false
    if (head.max === state.taskMaxRowid && head.count === state.taskCount) return true
    let cursor = state.taskMaxRowid
    let added = 0
    for (;;) {
      const rows = db
        .query<{ rowid: number; body_session: string | null }, [string, number, number]>(
          `SELECT rowid,CASE WHEN json_valid(body) THEN json_extract(body,'$.provenance.sessionID') END AS body_session
           FROM tasks WHERE project_directory=? AND rowid>? ORDER BY rowid LIMIT ?`,
        )
        .all(projectDirectory, cursor, TASK_BATCH)
      for (const row of rows) {
        const session = taskSession(row)
        if (session) state.tasks.add(session)
        cursor = row.rowid
        added++
      }
      if (rows.length < TASK_BATCH) break
    }
    if (state.taskCount + added !== head.count) return false
    state.taskMaxRowid = head.max
    state.taskCount = head.count
    return true
  }
  const readAttempts = (db: Database, projectDirectory: string, state: MembershipState) => {
    const head = db
      .query<{ count: number; max: number }, [string]>(
        `SELECT COUNT(*) AS count, COALESCE(MAX(a.rowid),0) AS max FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=?`,
      )
      .get(projectDirectory)!
    if (head.max < state.attemptMaxRowid || head.count < state.attemptCount) return false
    if (head.max === state.attemptMaxRowid && head.count === state.attemptCount) return true
    const rows = db
      .query<{ session_id: string }, [string, number]>(
        `SELECT a.session_id FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=? AND a.rowid>?`,
      )
      .all(projectDirectory, state.attemptMaxRowid)
    if (state.attemptCount + rows.length !== head.count) return false
    for (const row of rows) state.attempts.add(row.session_id)
    state.attemptMaxRowid = head.max
    state.attemptCount = head.count
    return true
  }
  return {
    get rebuilds() {
      return rebuilds
    },
    read(db, projectDirectory) {
      const key = JSON.stringify([db.filename, projectDirectory])
      let state = states.get(key)
      const fresh = (): MembershipState => ({
        tasks: new Set(),
        taskMaxRowid: 0,
        taskCount: 0,
        attempts: new Set(),
        attemptMaxRowid: 0,
        attemptCount: 0,
      })
      if (!state) {
        state = fresh()
        states.set(key, state)
        rebuilds++
      }
      if (!readTasks(db, projectDirectory, state) || !readAttempts(db, projectDirectory, state)) {
        state = fresh()
        states.set(key, state)
        rebuilds++
        readTasks(db, projectDirectory, state)
        readAttempts(db, projectDirectory, state)
      }
      const ids = new Set<string>([...state.tasks, ...state.attempts])
      for (const row of db
        .query<{ session_id: string }, [string]>(
          "SELECT owner AS session_id FROM runner_plans WHERE project_directory=?",
        )
        .all(projectDirectory))
        ids.add(row.session_id)
      for (const row of db
        .query<{ session_id: string | null; parent_id: string | null }, [string]>(
          `SELECT c.session_id,c.parent_id FROM runner_continuations c
           JOIN runner_plans p ON p.id=c.plan_id WHERE p.project_directory=?`,
        )
        .all(projectDirectory)) {
        if (row.session_id) ids.add(row.session_id)
        if (row.parent_id) ids.add(row.parent_id)
      }
      return ids
    },
  }
}

/** Process-wide index so every loaded observer shares one membership state per database. */
const indexKey = Symbol.for("opencode-lazers.observation-association-index.v1")
const indexHost = globalThis as typeof globalThis & { [indexKey]?: AssociationIndex }
export const associationIndex: AssociationIndex = (indexHost[indexKey] ??= createAssociationIndex())
