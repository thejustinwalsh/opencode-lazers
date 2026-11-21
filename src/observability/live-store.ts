import type { Database } from "bun:sqlite"
import { z } from "zod"
import { LIVE_GROUP_TASKS } from "./contract.ts"
import type { ObservationScope } from "./contract.ts"
import { AttemptModel, readAttemptSummary } from "../tasks/attempt-summary.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { projectIdsJSON, sameProject } from "../project-key.ts"
import { taskTitle } from "../tasks/presentation.ts"
import { storedGroupHead, storedWorkload } from "../tasks/schedule/stored.ts"
import { openConcerns } from "../recovery/detector.ts"
import { attemptIs, planIs } from "../runner/identity-read.ts"

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Recent native calls read per session that has no runner assignment. */
const NATIVE_CALLS_PER_SESSION = 17

export type NativeCallRow = {
  session_id: string
  call_id: string
  message_id: string | null
  tool: string | null
  first_observed_at: number
  last_observed_at: number
  status: string | null
  detail: string | null
  error: string | null
}

/** Recent call summaries read per live snapshot. */
const TOOL_DETAIL_ROWS = 400

export const LIVE_LIMITS = {
  sessions: 32,
  inventoryCandidates: 256,
  progressRowsPerSession: 17,
  toolRowsPerSession: 17,
  progressRowsPerAttempt: 50,
  journalFacts: 257,
  journalHydrationFacts: 16,
  progressPayloadBytes: 4096,
  sourceRows: 1500,
  sourceBytes: 10_000_000,
  sourceQueries: 100,
  nativeMetadataBytes: 256_000,
  nativeSessionReads: 32,
  retainedStateEntries: 32,
  responseBytes: 512_000,
  nativeInventoryReads: 1,
} as const

const JOURNAL_FACTS = LIVE_LIMITS.journalFacts - 1
const JOURNAL_HYDRATION_FACTS = LIVE_LIMITS.journalHydrationFacts
const EVENT_IDS_BYTES = 2048
const SMALL_ID_BYTES = 200
const POLICY_BYTES = 8192

export type LiveAttemptAssignment = {
  sessionID: string
  planID: string
  taskID: string
  attemptID: string
  state: "preparing" | "running" | "verifying"
  startedAt: number
  policy: string | null
  policyBytes: number
  policyOmitted: boolean
  workspace: string | null
  workspaceOmitted: boolean
  workspaceMatches: boolean | null
  /** Runner attempt ordinal for the task; always present on an active attempt row. */
  attemptNumber: number
  /** From the task record; absent when the task tables or fields are missing. */
  taskTitle?: string
  taskReference?: string
  /** The task node's and plan's recorded state; absent when the runner tables cannot supply it. */
  task?: { state: string; reason: string | null; planState: string; planReason: string | null }
}

/** Counts of recorded task states in non-terminal plans; no new notion, just the runner nodes. */
export type LiveWorkload = { queued: number; needsYou: number; failed: number }

export type LiveProgressRow = {
  seq: number
  at: number
  recorded_at: number | null
  source: string
  kind: string
  event_ids_json: string | null
  event_ids_omitted: number
  call_id: string | null
  message_id: string | null
  payload: string | null
  payload_bytes: number
  payload_omitted: number
  recent_lane?: number
  tool_lane?: number
}

export type LiveStoreMetrics = {
  sourceQueries: number
  sourceRowsRead: number
  sourceBytesRead: number
  sourcePayloadBytesRead: number
  assignmentTruncated: boolean
  progressTruncated: boolean
  payloadTruncated: boolean
  journalTruncated: boolean
  journal: "available" | "legacy-or-unavailable" | "unavailable"
}

export type LiveSourceSnapshot = LiveStoreMetrics & {
  runnerRevision: number | null
  workload?: LiveWorkload
  assignments: Map<string, LiveAttemptAssignment>
  progress: Map<string, LiveProgressRow[]>
}

type AssignmentRow = {
  session_id: string
  plan_id: string
  task_id: string
  attempt_id: string
  state: "preparing" | "running" | "verifying"
  started_at: number
  attempt_number: number
  policy: string | null
  policy_bytes: number
  policy_omitted: number
  workspace: string | null
  workspace_omitted: number
}

type JournalFactRow = {
  change_id: number
  session_id: string
  attempt_id: string
  source_seq: number
  source_kind: string
}

type ProgressRow = LiveProgressRow

export class LiveHistoryUnavailableError extends Error {
  constructor(readonly reason: "session-unavailable") {
    super("Selected session history is unavailable in this project scope")
    this.name = "LiveHistoryUnavailableError"
  }
}

const textEncoder = new TextEncoder()

function utf8Bytes(value: unknown): number {
  if (typeof value === "string") return textEncoder.encode(value).byteLength
  if (typeof value === "number" || typeof value === "boolean")
    return textEncoder.encode(String(value)).byteLength
  if (Array.isArray(value)) return value.reduce((total, item) => total + utf8Bytes(item), 0)
  if (typeof value === "object" && value !== null)
    return Object.values(value).reduce((total, item) => total + utf8Bytes(item), 0)
  return 0
}

function countQuery(metrics: LiveStoreMetrics) {
  metrics.sourceQueries++
  if (metrics.sourceQueries > LIVE_LIMITS.sourceQueries)
    throw new Error("Bounded live source exceeded its declared query budget")
}

function countRows(metrics: LiveStoreMetrics, rows: readonly unknown[]) {
  metrics.sourceRowsRead += rows.length
  for (const row of rows) metrics.sourceBytesRead += utf8Bytes(row)
  if (
    metrics.sourceRowsRead > LIVE_LIMITS.sourceRows ||
    metrics.sourceBytesRead > LIVE_LIMITS.sourceBytes
  )
    throw new Error("Bounded live source exceeded its declared work budget")
}

function boundedBytePrefix(column: string, maximum: number) {
  return `length(substr(CAST(${column} AS BLOB),1,${maximum + 1}))`
}

function countPayload(metrics: LiveStoreMetrics, row: LiveProgressRow) {
  if (row.payload !== null)
    metrics.sourcePayloadBytesRead += new TextEncoder().encode(row.payload).byteLength
  if (row.payload_omitted || row.event_ids_omitted) metrics.payloadTruncated = true
}

function tableExists(db: Database, metrics: LiveStoreMetrics, name: string) {
  countQuery(metrics)
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name)
  if (row) countRows(metrics, [row])
  return Boolean(row)
}

function revisionIn(db: Database, metrics: LiveStoreMetrics, projectDirectory: string) {
  countQuery(metrics)
  const row = db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM observation_revisions WHERE project_directory=?",
    )
    .get(projectDirectory)
  if (row) countRows(metrics, [row])
  return row?.revision ?? null
}

function revisionIfAvailable(
  db: Database,
  metrics: LiveStoreMetrics,
  available: boolean,
  projectDirectory: string,
) {
  if (!available) return null
  return revisionIn(db, metrics, projectDirectory)
}

function journalCoverage(
  db: Database,
  metrics: LiveStoreMetrics,
  factsAvailable: boolean,
  projectDirectory: string,
) {
  if (!factsAvailable) {
    metrics.journal = "unavailable"
    return
  }
  const coverageAvailable = tableExists(db, metrics, "recovery_progress_coverage")
  if (!coverageAvailable) {
    metrics.journal = "legacy-or-unavailable"
    return
  }
  countQuery(metrics)
  const row = db
    .query<{ coverage_kind: string }, [string]>(
      "SELECT coverage_kind FROM recovery_progress_coverage WHERE project_directory=?",
    )
    .get(projectDirectory)
  if (row) countRows(metrics, [row])
  metrics.journal =
    row?.coverage_kind === "legacy-or-unavailable" ? row.coverage_kind : "unavailable"
}

/**
 * A tool row whose stored payload is over the live limit usually carries a large result. The live
 * read needs only the call's identity, status, timing, targets, detail and error, so those fields
 * are lifted out and the result body is left behind; the row is not dropped. Null when even this
 * summary is over the limit.
 */
function compactToolPayload(column: string) {
  const field = (name: string) => `'${name}',json(json_extract(${column},'$.${name}'))`
  const compact = `json_object('tool',json_extract(${column},'$.tool'),'status',json_extract(${column},'$.status'),'callStatus',json_extract(${column},'$.callStatus'),'detail',json_extract(${column},'$.detail'),${[
    "statusProvenance",
    "execution",
    "timing",
    "observations",
    "fileTargets",
    "error",
  ]
    .map(field)
    .join(",")})`
  return `CASE WHEN json_valid(${column}) AND length(${compact})<=${LIVE_LIMITS.progressPayloadBytes} THEN ${compact} END`
}

function progressQuery(db: Database) {
  return db.query<ProgressRow, (string | number)[]>(
    `WITH recent AS (
       SELECT seq FROM runner_progress
        WHERE project_directory=? AND ${attemptIs(db)} AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
          AND ${planIs(db, "runner_progress")} AND task_id=? ORDER BY seq DESC LIMIT ?
     ), tools AS (
       SELECT seq FROM runner_progress
        WHERE project_directory=? AND ${attemptIs(db)} AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
          AND ${planIs(db, "runner_progress")} AND task_id=? AND kind='tool' AND call_id IS NOT NULL
        ORDER BY seq DESC LIMIT ?
     ), selected AS (
       SELECT seq,MAX(recent_lane) AS recent_lane,MAX(tool_lane) AS tool_lane FROM (
         SELECT seq,1 AS recent_lane,0 AS tool_lane FROM recent
         UNION ALL SELECT seq,0 AS recent_lane,1 AS tool_lane FROM tools
       ) GROUP BY seq
     )
     SELECT p.seq,p.at,p.recorded_at,substr(p.source,1,80) AS source,substr(p.kind,1,80) AS kind,
            selected.recent_lane,selected.tool_lane,
            CASE WHEN ${boundedBytePrefix("p.event_ids_json", EVENT_IDS_BYTES)}<=? THEN p.event_ids_json END AS event_ids_json,
            ${boundedBytePrefix("p.event_ids_json", EVENT_IDS_BYTES)}>? AS event_ids_omitted,
            CASE WHEN ${boundedBytePrefix("p.call_id", SMALL_ID_BYTES)}<=? THEN p.call_id END AS call_id,
            CASE WHEN ${boundedBytePrefix("p.message_id", SMALL_ID_BYTES)}<=? THEN p.message_id END AS message_id,
            CASE WHEN ${boundedBytePrefix("p.payload", LIVE_LIMITS.progressPayloadBytes)}<=? THEN p.payload
                 WHEN p.kind='tool' THEN ${compactToolPayload("p.payload")} END AS payload,
            ${boundedBytePrefix("p.payload", LIVE_LIMITS.progressPayloadBytes)} AS payload_bytes,
            ${boundedBytePrefix("p.payload", LIVE_LIMITS.progressPayloadBytes)}>? AS payload_omitted
       FROM runner_progress p JOIN selected ON selected.seq=p.seq ORDER BY p.seq DESC`,
  )
}

function progressArgs(
  projectDirectory: string,
  projectID: string,
  assignment: LiveAttemptAssignment,
  sessionID: string,
) {
  return [
    projectDirectory,
    assignment.attemptID,
    sessionID,
    projectIdsJSON(projectID),
    assignment.planID,
    assignment.taskID,
    LIVE_LIMITS.progressRowsPerSession + 1,
    projectDirectory,
    assignment.attemptID,
    sessionID,
    projectIdsJSON(projectID),
    assignment.planID,
    assignment.taskID,
    LIVE_LIMITS.toolRowsPerSession + 1,
    EVENT_IDS_BYTES,
    EVENT_IDS_BYTES,
    SMALL_ID_BYTES,
    SMALL_ID_BYTES,
    LIVE_LIMITS.progressPayloadBytes,
    LIVE_LIMITS.progressPayloadBytes,
  ]
}

function assignmentFromRow(row: AssignmentRow): LiveAttemptAssignment {
  return {
    sessionID: row.session_id,
    planID: row.plan_id,
    taskID: row.task_id,
    attemptID: row.attempt_id,
    state: row.state,
    startedAt: row.started_at,
    attemptNumber: row.attempt_number,
    policy: row.policy,
    policyBytes: row.policy_bytes,
    policyOmitted: row.policy_omitted !== 0,
    workspace: row.workspace,
    workspaceOmitted: row.workspace_omitted !== 0,
    workspaceMatches: null,
  }
}

/**
 * Queued, blocked and failed task counts, read from the stored per-bucket counters the Tasks
 * panel's chips show (`task_schedule_counts`, one row per bucket); absent while the project is
 * not indexed or the counters are unreadable.
 */
function readWorkload(db: Database, metrics: LiveStoreMetrics, projectDirectory: string) {
  try {
    countQuery(metrics)
    const workload = storedWorkload(db, projectDirectory)
    if (!workload) return undefined
    countRows(metrics, [workload])
    return workload satisfies LiveWorkload
  } catch {
    return undefined
  }
}

/** Each active attempt's task node and plan state, by primary key; best effort. */
function readTaskStates(
  db: Database,
  metrics: LiveStoreMetrics,
  assignments: Map<string, LiveAttemptAssignment>,
) {
  try {
    const query = db.query<
      {
        state: string
        reason: string | null
        plan_state: string
        plan_reason: string | null
      },
      [string, string]
    >(
      `SELECT n.state AS state,substr(n.reason,1,600) AS reason,
              p.state AS plan_state,substr(p.reason,1,600) AS plan_reason
         FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
        WHERE n.plan_id=? AND n.task_id=?`,
    )
    for (const assignment of assignments.values()) {
      countQuery(metrics)
      const row = query.get(assignment.planID, assignment.taskID)
      if (!row) continue
      countRows(metrics, [row])
      assignment.task = {
        state: row.state,
        reason: row.reason,
        planState: row.plan_state,
        planReason: row.plan_reason,
      }
    }
  } catch {
    // An older store without these tables leaves the session's own state.
  }
}

/** Task title and reference for the active attempts, by primary-key lookup; best effort. */
function readTaskLabels(
  db: Database,
  metrics: LiveStoreMetrics,
  projectDirectory: string,
  assignments: Map<string, LiveAttemptAssignment>,
) {
  if (assignments.size === 0) return
  try {
    const taskIDs = [...new Set([...assignments.values()].map((item) => item.taskID))]
    countQuery(metrics)
    const rows = db
      .query<{ id: string; title: string | null; reference: string | null }, string[]>(
        `SELECT t.id AS id,substr(json_extract(t.body,'$.proposal.objective'),1,600) AS title,
                substr(r.reference,1,40) AS reference
           FROM tasks t
           LEFT JOIN task_references r ON r.project_directory=t.project_directory AND r.task_id=t.id
          WHERE t.project_directory=? AND t.id IN (${taskIDs.map(() => "?").join(",")})`,
      )
      .all(projectDirectory, ...taskIDs)
    countRows(metrics, rows)
    const byTask = new Map(rows.map((row) => [row.id, row]))
    for (const assignment of assignments.values()) {
      const row = byTask.get(assignment.taskID)
      if (row?.title?.trim()) assignment.taskTitle = taskTitle(row.title)
      if (row?.reference) assignment.taskReference = row.reference
    }
  } catch {
    // Older stores without task references simply omit the labels.
  }
}

/** The denormalized project key and partial index keep historical attempts out of the live scan. */
export function activeAssignmentsQuery(sessionScoped: boolean) {
  return `SELECT a.session_id,a.plan_id,a.task_id,a.id AS attempt_id,a.state,a.started_at,a.number AS attempt_number,
                 CASE WHEN ${boundedBytePrefix("a.policy", POLICY_BYTES)}<=? THEN a.policy END AS policy,
                 ${boundedBytePrefix("a.policy", POLICY_BYTES)} AS policy_bytes,
                 ${boundedBytePrefix("a.policy", POLICY_BYTES)}>? AS policy_omitted,
                 CASE WHEN ${boundedBytePrefix("a.workspace", 4096)}<=? THEN a.workspace END AS workspace,
                 ${boundedBytePrefix("a.workspace", 4096)}>? AS workspace_omitted
            FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
           WHERE a.project_directory=? AND p.project_directory=?
             AND a.state IN ('preparing','running','verifying')
             ${sessionScoped ? "AND a.session_id=?" : ""}
           ORDER BY a.started_at DESC,a.id DESC LIMIT ?`
}

function progressRowQuery(db: Database, metrics: LiveStoreMetrics, args: (string | number)[]) {
  countQuery(metrics)
  const rows = progressQuery(db).all(...args)
  countRows(metrics, rows)
  for (const row of rows) countPayload(metrics, row)
  return rows
}

/** Read-only bounded SQL projections for the Radar live hot path and selected history. */
function newLiveStoreMetrics(): LiveStoreMetrics {
  return {
    sourceQueries: 0,
    sourceRowsRead: 0,
    sourceBytesRead: 0,
    sourcePayloadBytesRead: 0,
    assignmentTruncated: false,
    progressTruncated: false,
    payloadTruncated: false,
    journalTruncated: false,
    journal: "unavailable",
  }
}

function readRevisionAndJournal(db: Database, metrics: LiveStoreMetrics, projectDirectory: string) {
  const revisionAvailable = tableExists(db, metrics, "observation_revisions")
  const runnerRevision = revisionIfAvailable(db, metrics, revisionAvailable, projectDirectory)
  const factsAvailable = tableExists(db, metrics, "recovery_progress_facts")
  journalCoverage(db, metrics, factsAvailable, projectDirectory)
  return { runnerRevision, factsAvailable }
}

export class LiveReadStore {
  constructor(
    private readonly path: string,
    private readonly projectDirectory: string,
    private readonly projectID: string,
  ) {}

  /**
   * One-line call summaries recorded for the given sessions, keyed `sessionID` NUL `callID`. This
   * is the canonical per-call record, so it covers sessions with no runner assignment, such as
   * the Architect. Bounded to the most recent calls; empty when the table does not exist yet.
   */
  toolDetails(sessionIDs: readonly string[], signal: AbortSignal): Map<string, string> {
    const details = new Map<string, string>()
    if (sessionIDs.length === 0) return details
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    try {
      connection.store.read((db) => {
        signal.throwIfAborted()
        const exists = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='native_tool_calls'",
          )
          .get()
        if (!exists) return
        const rows = db
          .query<
            { session_id: string; call_id: string; detail: string | null },
            (string | number)[]
          >(
            `SELECT session_id,COALESCE(native_call_id,context_call_id,invocation_id) AS call_id,
                    substr(json_extract(payload,'$.detail'),1,200) AS detail
               FROM native_tool_calls
              WHERE project_directory=? AND session_id IN (SELECT value FROM json_each(?))
                AND json_extract(payload,'$.detail') IS NOT NULL
              ORDER BY last_observed_at DESC LIMIT ?`,
          )
          .all(this.projectDirectory, JSON.stringify(sessionIDs), TOOL_DETAIL_ROWS)
        for (const row of rows)
          if (row.detail) details.set(`${row.session_id}\u0000${row.call_id}`, row.detail)
      })
    } catch {
      // A missing or unreadable detail table leaves rows with their tool name and targets.
    } finally {
      connection.close()
    }
    return details
  }

  /**
   * The most recent native calls of sessions with no runner assignment, from the canonical
   * per-call record. The Architect has no progress rows, so this is where its calls live. Bounded
   * to the latest 17 per session; empty when the table does not exist yet.
   */
  nativeCalls(sessionIDs: readonly string[], signal: AbortSignal): NativeCallRow[] {
    if (sessionIDs.length === 0) return []
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    try {
      return connection.store.read((db) => {
        signal.throwIfAborted()
        const exists = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='native_tool_calls'",
          )
          .get()
        if (!exists) return []
        return db
          .query<NativeCallRow, (string | number)[]>(
            `SELECT session_id,call_id,message_id,tool,first_observed_at,last_observed_at,status,detail,error FROM (
               SELECT session_id,COALESCE(native_call_id,invocation_id) AS call_id,message_id,tool,
                      first_observed_at,last_observed_at,
                      json_extract(payload,'$.status') AS status,
                      substr(json_extract(payload,'$.detail'),1,200) AS detail,
                      substr(json_extract(payload,'$.error.message'),1,240) AS error,
                      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY last_observed_at DESC) AS rn
                 FROM native_tool_calls
                WHERE project_directory=? AND identity_kind='native-call'
                  AND session_id IN (SELECT value FROM json_each(?))
             ) WHERE rn<=?
             ORDER BY last_observed_at DESC`,
          )
          .all(this.projectDirectory, JSON.stringify(sessionIDs), NATIVE_CALLS_PER_SESSION)
      })
    } catch {
      return []
    } finally {
      connection.close()
    }
  }

  readCurrent(sessionID: string | null, signal: AbortSignal): LiveSourceSnapshot {
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    const metrics = newLiveStoreMetrics()
    try {
      const source = connection.store.read((db) => {
        signal.throwIfAborted()
        const { runnerRevision, factsAvailable } = readRevisionAndJournal(
          db,
          metrics,
          this.projectDirectory,
        )

        const assignments = new Map<string, LiveAttemptAssignment>()
        const progress = new Map<string, LiveProgressRow[]>()
        signal.throwIfAborted()
        countQuery(metrics)
        const activeAssignments = db
          .query<AssignmentRow, (string | number)[]>(activeAssignmentsQuery(sessionID !== null))
          .all(
            POLICY_BYTES,
            POLICY_BYTES,
            4096,
            4096,
            this.projectDirectory,
            this.projectDirectory,
            ...(sessionID === null ? [] : [sessionID]),
            LIVE_LIMITS.sessions + 1,
          )
        countRows(metrics, activeAssignments)
        if (activeAssignments.length > LIVE_LIMITS.sessions) metrics.assignmentTruncated = true
        for (const row of activeAssignments.slice(0, LIVE_LIMITS.sessions)) {
          const assignment = assignmentFromRow(row)
          assignments.set(assignment.sessionID, assignment)
          if (assignment.policyOmitted || assignment.workspaceOmitted)
            metrics.payloadTruncated = true

          signal.throwIfAborted()
          const rows = progressRowQuery(
            db,
            metrics,
            progressArgs(this.projectDirectory, this.projectID, assignment, assignment.sessionID),
          )
          const recentRows = rows.filter((row) => row.recent_lane === 1)
          const toolRows = rows.filter((row) => row.tool_lane === 1)
          if (
            recentRows.length > LIVE_LIMITS.progressRowsPerSession ||
            toolRows.length > LIVE_LIMITS.toolRowsPerSession
          )
            metrics.progressTruncated = true
          const retainedSequences = new Set([
            ...recentRows.slice(0, LIVE_LIMITS.progressRowsPerSession).map((row) => row.seq),
            ...toolRows.slice(0, LIVE_LIMITS.toolRowsPerSession).map((row) => row.seq),
          ])
          progress.set(
            assignment.sessionID,
            rows.filter((row) => retainedSequences.has(row.seq)),
          )
        }

        signal.throwIfAborted()
        const workload = readWorkload(db, metrics, this.projectDirectory)
        readTaskLabels(db, metrics, this.projectDirectory, assignments)
        readTaskStates(db, metrics, assignments)

        if (factsAvailable && assignments.size) {
          signal.throwIfAborted()
          countQuery(metrics)
          const facts = db
            .query<JournalFactRow, [string, number]>(
              `SELECT change_id,substr(session_id,1,200) AS session_id,
                      substr(attempt_id,1,200) AS attempt_id,source_seq,
                      substr(source_kind,1,80) AS source_kind
                 FROM recovery_progress_facts
                WHERE project_directory=? ORDER BY change_id DESC LIMIT ?`,
            )
            .all(this.projectDirectory, LIVE_LIMITS.journalFacts)
          countRows(metrics, facts)
          if (facts.length === LIVE_LIMITS.journalFacts) metrics.journalTruncated = true

          const knownSequences = new Map<string, Set<number>>()
          for (const [sessionID, rows] of progress) {
            const assignment = assignments.get(sessionID)!
            knownSequences.set(assignment.attemptID, new Set(rows.map((row) => row.seq)))
          }
          const changed = new Map<string, Map<number, number>>()
          for (const fact of facts.slice(0, JOURNAL_FACTS)) {
            const assignment = assignments.get(fact.session_id)
            if (
              !assignment ||
              assignment.attemptID !== fact.attempt_id ||
              (fact.source_kind !== "tool" && fact.source_kind !== "step") ||
              !Number.isSafeInteger(fact.source_seq) ||
              fact.source_seq < 1 ||
              knownSequences.get(assignment.attemptID)?.has(fact.source_seq)
            )
              continue
            const sequences = changed.get(assignment.attemptID) ?? new Map<number, number>()
            sequences.set(fact.source_seq, fact.change_id)
            changed.set(assignment.attemptID, sequences)
          }
          const selectedChanges = [...changed.entries()].flatMap(([attemptID, rows]) =>
            [...rows.entries()].map(([sequence, changeID]) => ({ attemptID, sequence, changeID })),
          )
          selectedChanges.sort((left, right) => right.changeID - left.changeID)
          const hydration = selectedChanges.slice(0, JOURNAL_HYDRATION_FACTS)
          if (selectedChanges.length > hydration.length) metrics.journalTruncated = true
          const byAttempt = new Map<string, number[]>()
          for (const item of hydration) {
            const sequences = byAttempt.get(item.attemptID) ?? []
            sequences.push(item.sequence)
            byAttempt.set(item.attemptID, sequences)
          }
          for (const [attemptID, sequences] of byAttempt) {
            signal.throwIfAborted()
            const sessionID = [...assignments].find(
              ([, assignment]) => assignment.attemptID === attemptID,
            )?.[0]
            const assignment = sessionID ? assignments.get(sessionID) : undefined
            if (!sessionID || !assignment) continue
            const placeholders = sequences.map(() => "?").join(",")
            countQuery(metrics)
            const rows = db
              .query<ProgressRow, (string | number)[]>(
                `SELECT seq,at,recorded_at,substr(source,1,80) AS source,substr(kind,1,80) AS kind,
                        CASE WHEN ${boundedBytePrefix("event_ids_json", EVENT_IDS_BYTES)}<=? THEN event_ids_json END AS event_ids_json,
                        ${boundedBytePrefix("event_ids_json", EVENT_IDS_BYTES)}>? AS event_ids_omitted,
                        CASE WHEN ${boundedBytePrefix("call_id", SMALL_ID_BYTES)}<=? THEN call_id END AS call_id,
                        CASE WHEN ${boundedBytePrefix("message_id", SMALL_ID_BYTES)}<=? THEN message_id END AS message_id,
                        CASE WHEN ${boundedBytePrefix("payload", LIVE_LIMITS.progressPayloadBytes)}<=? THEN payload END AS payload,
                        ${boundedBytePrefix("payload", LIVE_LIMITS.progressPayloadBytes)} AS payload_bytes,
                        ${boundedBytePrefix("payload", LIVE_LIMITS.progressPayloadBytes)}>? AS payload_omitted
                   FROM runner_progress
                  WHERE project_directory=? AND ${attemptIs(db)} AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
                    AND ${planIs(db, "runner_progress")} AND task_id=? AND seq IN (${placeholders})
                  ORDER BY seq DESC`,
              )
              .all(
                EVENT_IDS_BYTES,
                EVENT_IDS_BYTES,
                SMALL_ID_BYTES,
                SMALL_ID_BYTES,
                LIVE_LIMITS.progressPayloadBytes,
                LIVE_LIMITS.progressPayloadBytes,
                this.projectDirectory,
                assignment.attemptID,
                sessionID,
                projectIdsJSON(this.projectID),
                assignment.planID,
                assignment.taskID,
                ...sequences,
              )
            countRows(metrics, rows)
            for (const row of rows) countPayload(metrics, row)
            const prior = progress.get(sessionID) ?? []
            const merged = new Map([...prior, ...rows].map((row) => [row.seq, row]))
            progress.set(
              sessionID,
              [...merged.values()].sort((left, right) => right.seq - left.seq),
            )
          }
        }
        return { runnerRevision, assignments, progress, ...(workload ? { workload } : {}) }
      })

      signal.throwIfAborted()
      return { ...source, ...metrics }
    } finally {
      connection.close()
    }
  }

  /**
   * One session's latest-attempt summary: the attempt row and the compact `runner_progress` read
   * Tasks uses, so the worker pane and the task pane draw the same lane. Null without an attempt.
   */
  readAttempt(input: { scope: ObservationScope; sessionID: string }, signal: AbortSignal) {
    if (input.scope.kind === "session" && input.sessionID !== input.scope.sessionID)
      throw new LiveHistoryUnavailableError("session-unavailable")
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    try {
      return connection.store.read((db) => {
        signal.throwIfAborted()
        const row = db
          .query<
            {
              id: string
              task_id: string
              number: number
              state: string
              started_at: number
              tool_count: number
              model: string | null
              takeover: number
              node_state: string | null
              node_reason: string | null
              plan_state: string
              plan_reason: string | null
            },
            [string, string]
          >(
            `SELECT a.id,a.task_id,a.number,a.state,a.started_at,a.tool_count,
                    json_extract(a.policy,'$.model') AS model,
                    json_extract(a.policy,'$.takeover') IS NOT NULL AS takeover,
                    n.state AS node_state,substr(n.reason,1,600) AS node_reason,
                    p.state AS plan_state,substr(p.reason,1,600) AS plan_reason
               FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
               LEFT JOIN runner_nodes n ON n.plan_id=a.plan_id AND n.task_id=a.task_id
              WHERE a.session_id=? AND p.project_directory=? LIMIT 1`,
          )
          .get(input.sessionID, this.projectDirectory)
        if (!row) return null
        const model = AttemptModel.safeParse(row.model ? safeJSON(row.model) : undefined)
        // One indexed read of this task's open concerns; an unsettled node only.
        const concern = row.node_state
          ? openConcerns(db, this.projectDirectory, { taskID: row.task_id })
          : []
        // One point read: the backfill's watermark above the attempt's oldest row.
        let indexing = false
        try {
          indexing =
            db
              .query<{ one: number }, [string, string]>(
                `SELECT 1 AS one FROM runner_progress_display_backfill b
                  WHERE b.below_seq > (SELECT MIN(seq) FROM runner_progress WHERE project_directory=? AND ${attemptIs(db)})`,
              )
              .get(this.projectDirectory, row.id) !== null
        } catch {
          // A database older than the display table has nothing to index.
        }
        return {
          id: row.id,
          number: row.number,
          state: row.state,
          startedAt: row.started_at,
          toolCount: row.tool_count,
          ...(indexing ? { historyIndexing: true as const } : {}),
          ...(model.success ? { model: model.data } : {}),
          summary: readAttemptSummary(db, this.projectDirectory, row.id),
          ...(concern.length
            ? {
                concern: {
                  line: concern
                    .map((item) => item.reason)
                    .join("; ")
                    .slice(0, 600),
                  ...(concern[0]!.advice
                    ? {
                        action: concern[0]!.advice.action,
                        because: concern[0]!.advice.because.slice(0, 600),
                      }
                    : {}),
                },
              }
            : {}),
          ...(row.takeover ? { takeover: true as const } : {}),
          ...(row.node_state
            ? {
                task: {
                  state: row.node_state,
                  reason: row.node_reason,
                  planState: row.plan_state,
                  planReason: row.plan_reason,
                },
              }
            : {}),
        }
      })
    } finally {
      connection.close()
    }
  }

  /**
   * The tasks behind a Map group: the first `LIVE_GROUP_TASKS` of the stored bucket the workload
   * counts, in schedule order, plus the bucket's total. A project that is not indexed yet says so.
   */
  readGroupTasks(group: "needs-you" | "failed" | "queued", signal: AbortSignal) {
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    try {
      return connection.store.read((db) => {
        signal.throwIfAborted()
        const head = storedGroupHead(db, this.projectDirectory, group, LIVE_GROUP_TASKS)
        if (!head) return { indexing: true as const, total: 0, tasks: [] }
        return {
          total: head.total,
          tasks: head.rows.map((row) => ({
            taskID: row.task_id,
            reference: row.reference,
            title: row.title,
          })),
        }
      })
    } finally {
      connection.close()
    }
  }
}
