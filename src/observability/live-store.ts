import type { Database } from "bun:sqlite"
import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { LiveHistoryRequest } from "./contract.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { projectIdsJSON, sameProject } from "../project-key.ts"
import { taskTitle } from "../tasks/presentation.ts"
import { taskStatePredicate } from "../tasks/state-filter.ts"

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

export const LIVE_HISTORY_LIMITS = {
  sourceQueries: 10,
  sourceRows: 40,
  sourceBytes: 250_000,
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

export type LiveHistorySourcePage = LiveStoreMetrics & {
  runnerRevision: number | null
  /** Null for an authorized session that has no runner attempt, such as an Architect session. */
  attemptID: string | null
  rows: LiveProgressRow[]
  hasMore: boolean
  nextCursor: string | null
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

const CursorPayload = z.strictObject({
  version: z.literal(1),
  projectID: z.string().min(1).max(200),
  scope: z.unknown(),
  sessionID: z.string().min(1).max(200),
  limit: z.int().min(1).max(25),
  attemptID: z.uuid(),
  runnerRevision: z.int().nonnegative().nullable(),
  beforeSequence: z.int().positive(),
})

export class LiveHistoryUnavailableError extends Error {
  constructor(readonly reason: "invalid-cursor" | "session-unavailable" | "changed-during-read") {
    super(
      reason === "invalid-cursor"
        ? "Selected history cursor is invalid for this scope"
        : reason === "changed-during-read"
          ? "Selected history changed during the read; restart from a fresh page"
          : "Selected session history is unavailable in this project scope",
    )
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

function progressQuery(db: Database) {
  return db.query<ProgressRow, (string | number)[]>(
    `WITH recent AS (
       SELECT seq FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
          AND plan_id=? AND task_id=? ORDER BY seq DESC LIMIT ?
     ), tools AS (
       SELECT seq FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
          AND plan_id=? AND task_id=? AND kind='tool' AND call_id IS NOT NULL
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
            CASE WHEN ${boundedBytePrefix("p.payload", LIVE_LIMITS.progressPayloadBytes)}<=? THEN p.payload END AS payload,
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
 * Queued, blocked and failed task counts with the Tasks panel's own definition: each count is a
 * sum of `taskStatePredicate` for that filter over the project's non-retired tasks, the same
 * scope `TaskRepository.stateCounts` uses. The repository method is private to a writable store
 * handle, so this read applies the shared predicates itself. One pass; absent when unreadable.
 */
function readWorkload(db: Database, metrics: LiveStoreMetrics, projectDirectory: string) {
  try {
    const filters = ["queued", "blocked", "failed"] as const
    const sums = filters.map(
      (state) =>
        `COALESCE(SUM(CASE WHEN ${taskStatePredicate(state, "tasks")} THEN 1 ELSE 0 END),0) AS "${state}"`,
    )
    countQuery(metrics)
    const row = db
      .query<Record<string, number>, string[]>(
        `SELECT ${sums.join(",")} FROM tasks
          WHERE tasks.project_directory=?
            AND NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)`,
      )
      .get(projectDirectory)
    if (!row) return undefined
    countRows(metrics, [row])
    return {
      queued: row.queued ?? 0,
      needsYou: row.blocked ?? 0,
      failed: row.failed ?? 0,
    } satisfies LiveWorkload
  } catch {
    return undefined
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

function historyCursor(secret: Uint8Array, payload: z.infer<typeof CursorPayload>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("hex")
  return `${body}.${signature}`
}

function readHistoryCursor(
  secret: Uint8Array,
  value: string,
  request: LiveHistoryRequest,
  projectID: string,
): z.infer<typeof CursorPayload> {
  const separator = value.lastIndexOf(".")
  if (separator <= 0) throw new LiveHistoryUnavailableError("invalid-cursor")
  const body = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new LiveHistoryUnavailableError("invalid-cursor")
  const expected = createHmac("sha256", secret).update(body).digest()
  const supplied = Buffer.from(signature, "hex")
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new LiveHistoryUnavailableError("invalid-cursor")
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    throw new LiveHistoryUnavailableError("invalid-cursor")
  }
  const payload = CursorPayload.safeParse(raw)
  if (!payload.success) throw new LiveHistoryUnavailableError("invalid-cursor")
  const scope = ObservationScopeSchema.safeParse(payload.data.scope)
  const sameScope =
    scope.success &&
    scope.data.kind === request.scope.kind &&
    scope.data.sessionID === request.scope.sessionID
  if (
    !sameScope ||
    !sameProject(payload.data.projectID, projectID) ||
    payload.data.sessionID !== request.sessionID ||
    payload.data.limit !== request.limit
  )
    throw new LiveHistoryUnavailableError("invalid-cursor")
  return payload.data
}

const ObservationScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project"), sessionID: z.string().min(1).max(200) }),
])

/** Read-only bounded SQL projections for the Radar live hot path and selected history. */
export class LiveReadStore {
  constructor(
    private readonly path: string,
    private readonly projectDirectory: string,
    private readonly projectID: string,
    private readonly secret: Uint8Array,
  ) {}

  readCurrent(sessionID: string | null, signal: AbortSignal): LiveSourceSnapshot {
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    const metrics: LiveStoreMetrics = {
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
    try {
      const source = connection.store.read((db) => {
        signal.throwIfAborted()
        const revisionAvailable = tableExists(db, metrics, "observation_revisions")
        const runnerRevision = revisionIfAvailable(
          db,
          metrics,
          revisionAvailable,
          this.projectDirectory,
        )
        const factsAvailable = tableExists(db, metrics, "recovery_progress_facts")
        journalCoverage(db, metrics, factsAvailable, this.projectDirectory)

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
                  WHERE project_directory=? AND attempt_id=? AND session_id=? AND project_id IN (SELECT value FROM json_each(?))
                    AND plan_id=? AND task_id=? AND seq IN (${placeholders})
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

  readHistory(input: LiveHistoryRequest, signal: AbortSignal): LiveHistorySourcePage {
    if (input.scope.kind === "session" && input.sessionID !== input.scope.sessionID)
      throw new LiveHistoryUnavailableError("session-unavailable")
    const cursor = input.cursor
      ? readHistoryCursor(this.secret, input.cursor, input, this.projectID)
      : undefined
    const connection = openReadOnlyTrajectoryStore(this.path, this.projectDirectory)
    const metrics: LiveStoreMetrics = {
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
    try {
      const source = connection.store.read((db) => {
        signal.throwIfAborted()
        const revisionAvailable = tableExists(db, metrics, "observation_revisions")
        const runnerRevision = revisionIfAvailable(
          db,
          metrics,
          revisionAvailable,
          this.projectDirectory,
        )
        const factsAvailable = tableExists(db, metrics, "recovery_progress_facts")
        journalCoverage(db, metrics, factsAvailable, this.projectDirectory)

        countQuery(metrics)
        const assignment = db
          .query<{ attempt_id: string }, [string, string]>(
            `SELECT a.id AS attempt_id FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
              WHERE a.session_id=? AND p.project_directory=? LIMIT 1`,
          )
          .get(input.sessionID, this.projectDirectory)
        if (!assignment) {
          // Runner progress is the only history source. A session with no runner
          // attempt (an Architect session) has none: an empty page, not a failure.
          // A cursor can only have come from an attempt, so it is no longer valid.
          if (cursor) throw new LiveHistoryUnavailableError("invalid-cursor")
          return {
            runnerRevision,
            attemptID: null,
            rows: [] as ProgressRow[],
            hasMore: false,
            nextCursor: null,
          }
        }
        countRows(metrics, [assignment])
        if (cursor && cursor.attemptID !== assignment.attempt_id)
          throw new LiveHistoryUnavailableError("invalid-cursor")

        signal.throwIfAborted()
        const beforeSequence = cursor?.beforeSequence
        const predicate = beforeSequence === undefined ? "" : "AND seq<?"
        const values: (string | number)[] = [
          EVENT_IDS_BYTES,
          EVENT_IDS_BYTES,
          SMALL_ID_BYTES,
          SMALL_ID_BYTES,
          LIVE_LIMITS.progressPayloadBytes,
          LIVE_LIMITS.progressPayloadBytes,
          this.projectDirectory,
          assignment.attempt_id,
          input.sessionID,
          projectIdsJSON(this.projectID),
          input.limit + 1,
        ]
        if (beforeSequence !== undefined) values.splice(values.length - 1, 0, beforeSequence)
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
              WHERE project_directory=? AND attempt_id=? AND session_id=? AND project_id IN (SELECT value FROM json_each(?)) ${predicate}
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(...values)
        countRows(metrics, rows)
        for (const row of rows) countPayload(metrics, row)
        const hasMore = rows.length > input.limit
        const pageRows = rows.slice(0, input.limit)
        const nextCursor =
          hasMore && pageRows.length
            ? historyCursor(this.secret, {
                version: 1,
                projectID: this.projectID,
                scope: input.scope,
                sessionID: input.sessionID,
                limit: input.limit,
                attemptID: assignment.attempt_id,
                runnerRevision,
                beforeSequence: pageRows.at(-1)!.seq,
              })
            : null
        return {
          runnerRevision,
          attemptID: assignment.attempt_id,
          rows: pageRows,
          hasMore,
          nextCursor,
        }
      })

      signal.throwIfAborted()
      const latestRevision = connection.store.read((db) => {
        const available = tableExists(db, metrics, "observation_revisions")
        return revisionIfAvailable(db, metrics, available, this.projectDirectory)
      })
      if (source.runnerRevision !== latestRevision)
        throw new LiveHistoryUnavailableError("changed-during-read")
      if (cursor && cursor.runnerRevision !== source.runnerRevision)
        throw new LiveHistoryUnavailableError("changed-during-read")
      if (
        metrics.sourceQueries > LIVE_HISTORY_LIMITS.sourceQueries ||
        metrics.sourceRowsRead > LIVE_HISTORY_LIMITS.sourceRows ||
        metrics.sourceBytesRead > LIVE_HISTORY_LIMITS.sourceBytes
      )
        throw new Error("Bounded selected history exceeded its declared source budget")
      return { ...source, ...metrics }
    } finally {
      connection.close()
    }
  }
}
