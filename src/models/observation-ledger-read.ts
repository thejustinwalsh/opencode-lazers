import type { Database } from "bun:sqlite"
import { acquireSharedConnection } from "../storage.ts"
import type { SharedConnection } from "../storage.ts"

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { TaskClassificationRevision, TaskKindV1 } from "../task-classification.ts"
import type { TaskClassificationSnapshot } from "../task-classification.ts"
import { TaskReferenceSchema, TaskSpecSchema } from "../task.ts"
import type { TaskSpec } from "../task.ts"
import { PlanInput } from "../runner/schema.ts"
import { projectTaskEffortBasis } from "../trajectory/accounting.ts"
import type { AccountingAttempt, AccountingRoute } from "../trajectory/accounting.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import {
  decisionProgressFact,
  list,
  nonnegativeOrNull,
  numberOrNull,
  object,
  parseArray,
  parseObject,
  projectDecisionProgressRow,
  safeRoute,
  stringList,
} from "./decision-progress-fact.ts"
import { DECISION_PROJECTION_TABLES, decisionProjectionStats } from "./decision-projection.ts"
import {
  FACT_MALFORMED_PAYLOAD,
  FACT_UNREADABLE_EVENTS,
  FACT_UNREADABLE_SOURCES,
} from "./decision-progress-fact.ts"
import type { DecisionProgressSource, JsonObject, Route } from "./decision-progress-fact.ts"
import { projectProgressFact } from "../progress/projection.ts"
import type {
  AdoptionRow as StoredAdoptionRow,
  AttemptRow,
  PlanRow,
  ProgressRow,
} from "../runner/store.ts"
import { classificationSnapshotFor } from "../tasks/classification.ts"
import type { ClassificationAnnotationRow } from "../tasks/classification.ts"
import {
  OBSERVATION_LEDGER_CATALOG,
  OBSERVATION_LEDGER_TASK_KINDS,
  ObservationLedgerOutputSchema,
  ObservationLedgerReadInputSchema,
} from "./observation-ledger-schema.ts"
import type {
  ObservationLedgerOutput,
  ObservationLedgerReadInput,
} from "./observation-ledger-schema.ts"

// Decision reads keep only retained usage measurements and route-bearing step
// observations. The SQL projection is intentionally separate from the public ledger's
// richer progress view. The batch size is a unit of work, not a ceiling: the reader
// keeps paging by sequence until the table is exhausted. 512 is not measured;
// changing it changes only how many queries a read makes.
const DECISION_PROGRESS_BATCH_SIZE = 512

type SourceStatus = ObservationLedgerOutput["completeness"]["sources"][number]
type RawTask = { id: string; created_at: string; body: string }
type RawReference = { task_id: string; reference: string }
type RawDisposition = {
  id: number
  task_id: string
  request_id: string
  disposition: string
  reason: string
  evidence: string
  related_task_ids: string
  session_id: string
  agent: string
  created_at: string
}
type RawNode = {
  plan_id: string
  task_id: string
  state: string
  artifact: string | null
}
type RawTransition = {
  id: number
  plan_id: string
  task_id: string
  version: number
  event: string
  payload: string
  created_at: number
}
/** The adoption columns the ledger reads; the table carries many more. */
type AdoptionRow = Pick<
  StoredAdoptionRow,
  | "id"
  | "plan_id"
  | "task_id"
  | "attempt_id"
  | "attempt_state"
  | "old_artifact"
  | "descendant_commit"
  | "combined_artifact"
  | "reason"
  | "state"
  | "created_at"
  | "updated_at"
>
type RawProgress = ProgressRow
type RawCapture = {
  tasks: RawTask[]
  references: RawReference[]
  dispositions: RawDisposition[]
  classifications: Array<Record<string, unknown>>
  plans: PlanRow[]
  nodes: RawNode[]
  attempts: AttemptRow[]
  transitions: RawTransition[]
  adoptions: AdoptionRow[]
  progress: RawProgress[]
  decisionProgressFacts: Record<string, unknown>[]
  decisionProgressFingerprint: string | null
  sourceStatuses: SourceStatus[]
  notes: string[]
  fingerprint: string
  effectiveClassifications: Map<string, TaskClassificationSnapshot | null>
}

export type ObservationLedgerDecisionAttempt = {
  accounting: AccountingAttempt
  number: number
  retryCount: number
  startedAt: number
}

export type ObservationLedgerDecisionTask = {
  taskID: string
  taskReference: string | null
  createdAt: string
  submittedStatus: string | null
  classification: {
    kind: TaskKindV1 | null
    revision: number | null
    provenance: TaskClassificationSnapshot["current"]["provenance"] | null
    history: TaskClassificationSnapshot["history"]
    status: "available" | "unavailable"
  }
  acceptance: {
    accepted: boolean
    acceptedAt: number | null
    evidence: ObservationLedgerOutput["tasks"][number]["logicalOutcome"]["evidence"]
  }
  attempts: ObservationLedgerDecisionAttempt[]
  terminal: boolean
}

export type ObservationLedgerDecisionCapture = {
  status: "captured"
  projectDirectory: string
  capturedAt: number
  sourceFingerprint: string
  sourceRevision: number
  sources: SourceStatus[]
  notes: string[]
  tasks: ObservationLedgerDecisionTask[]
  progressFacts: Record<string, unknown>[]
  classificationCoverage: {
    classifiedTaskCount: number
    unclassifiedTaskCount: number
    unavailableTaskCount: number
    totalTaskCount: number
  }
}

export type ObservationLedgerDecisionRead =
  | ObservationLedgerDecisionCapture
  | {
      status: "incomplete"
      projectDirectory: string
      sourceRevision: number | null
      reason: string
      sources: SourceStatus[]
      notes: string[]
    }
  | {
      status: "unavailable"
      projectDirectory: string
      sourceRevision: number | null
      reason: "database-missing" | "database-unavailable" | "task-table-missing"
      sources: SourceStatus[]
    }

type CaptureResult =
  | { status: "captured"; capture: RawCapture }
  | { status: "unavailable"; reason: "task-table-missing"; sources: SourceStatus[] }

type TableStatus = SourceStatus["status"]
type TableInfo = { name: string; status: TableStatus; missingColumns: string[] }
type RouteOccurrence =
  ObservationLedgerOutput["tasks"][number]["attempts"][number]["observedRoutes"]["occurrences"][number]
type UsageCategory = keyof ReturnType<
  typeof projectTaskEffortBasis
>["usage"]["sessions"][number]["categories"]
type CategoryView = ObservationLedgerOutput["tasks"][number]["usage"]["categories"][UsageCategory]
type TotalView = ObservationLedgerOutput["tasks"][number]["usage"]["totalTokens"]

const TASK_COLUMNS = ["id", "project_directory", "created_at", "body"]
const RUNNER_PLAN_COLUMNS = [
  "id",
  "project_directory",
  "owner",
  "revision",
  "version",
  "state",
  "body",
  "model",
  "reason",
  "artifact",
]
const NODE_COLUMNS = ["plan_id", "task_id", "ordinal", "state", "artifact"]
const ATTEMPT_COLUMNS = [
  "id",
  "plan_id",
  "task_id",
  "number",
  "session_id",
  "message_id",
  "workspace",
  "base_commit",
  "artifact",
  "policy",
  "state",
  "started_at",
  "token_count",
  "tool_count",
  "retry_count",
  "cost",
]
const TRANSITION_COLUMNS = ["id", "plan_id", "task_id", "version", "event", "payload", "created_at"]
const ADOPTION_COLUMNS = [
  "id",
  "plan_id",
  "task_id",
  "attempt_id",
  "attempt_state",
  "old_artifact",
  "descendant_commit",
  "combined_artifact",
  "reason",
  "state",
  "created_at",
  "updated_at",
]
const PROGRESS_COLUMNS = [
  "seq",
  "project_directory",
  "project_id",
  "plan_id",
  "task_id",
  "attempt_id",
  "session_id",
  "at",
  "recorded_at",
  "source",
  "sources_json",
  "kind",
  "event_ids_json",
  "call_id",
  "message_id",
  "dedupe_key",
  "payload",
]

const DISPOSITION_COLUMNS = [
  "id",
  "project_directory",
  "task_id",
  "request_id",
  "disposition",
  "reason",
  "evidence",
  "related_task_ids",
  "session_id",
  "agent",
  "created_at",
]
const CLASSIFICATION_COLUMNS = [
  "id",
  "project_directory",
  "task_id",
  "request_id",
  "revision",
  "classification",
  "reason",
  "session_id",
  "agent",
  "created_at",
]

function accountingRoute(route: Route | null): AccountingRoute | null {
  return route
    ? {
        providerID: route.providerID,
        modelID: route.modelID,
        variant: route.variant,
        identity: {
          providerID: route.providerID,
          modelID: route.modelID,
          variant: route.variant,
        },
      }
    : null
}

function inspectTable(db: Database, name: string, requiredColumns: string[]): TableInfo {
  const exists = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name)
  if (!exists)
    return {
      name,
      status: "missing-table",
      missingColumns: requiredColumns,
    }
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${name})`)
      .all()
      .map((column) => column.name),
  )
  const missingColumns = requiredColumns.filter((column) => !columns.has(column))
  return {
    name,
    status: missingColumns.length ? "missing-columns" : "available",
    missingColumns,
  }
}

function source(info: TableInfo, legacyAbsent = false): SourceStatus {
  return {
    name: info.name,
    status: legacyAbsent && info.status === "missing-table" ? "legacy-absent" : info.status,
    missingColumns: info.missingColumns,
  }
}

function sourceAvailable(statuses: SourceStatus[], name: string): boolean {
  return statuses.find((item) => item.name === name)?.status === "available"
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Row-by-row digest, so the capture is never serialized whole. */
function fingerprintOf(value: Record<string, unknown>) {
  const digest = createHash("sha256")
  const write = (part: string) => {
    digest.update(part)
  }
  write("{")
  for (const [index, [key, field]] of Object.entries(value).entries()) {
    if (index) write(",")
    write(JSON.stringify(key))
    write(":")
    if (Array.isArray(field)) {
      write("[")
      for (const [rowIndex, row] of field.entries()) {
        if (rowIndex) write(",")
        write(JSON.stringify(row))
      }
      write("]")
    } else write(JSON.stringify(field))
  }
  write("}")
  return digest.digest("hex")
}

// F-S10-3: sequence pagination must seek the rowid, not re-sort the project's
// dedupe index on every page. The payload is projected in JS, not in SQL: building the same
// objects with json_object/json_each cost about a second on the live 111k-row table and was
// parsed again here; a plain JSON.parse of the stored text takes a fraction of that.
const LIVE_PROGRESS_COLUMNS =
  "r.seq,r.attempt_id,r.session_id,r.at,r.recorded_at,r.source,r.sources_json,r.kind," +
  "r.event_ids_json,r.message_id,r.payload"
const LIVE_PROGRESS_JOIN = `
  JOIN runner_plans p ON p.id=r.plan_id
  JOIN tasks t ON t.id=r.task_id AND t.project_directory=p.project_directory`
const LIVE_TAIL_SQL = `
  SELECT ${LIVE_PROGRESS_COLUMNS}
  FROM runner_progress r NOT INDEXED ${LIVE_PROGRESS_JOIN}
  WHERE r.project_directory=? AND p.project_directory=? AND r.seq>?
    AND r.kind IN ('step','usage-snapshot')
  ORDER BY r.seq LIMIT ?`
const LIVE_ONE_SQL = `
  SELECT ${LIVE_PROGRESS_COLUMNS}
  FROM runner_progress r ${LIVE_PROGRESS_JOIN}
  WHERE r.seq=? AND r.project_directory=? AND p.project_directory=?
    AND r.kind IN ('step','usage-snapshot')`
const STORED_PROGRESS_SQL = `
  SELECT f.seq,f.flags,f.fact
  FROM ${DECISION_PROJECTION_TABLES.facts} f
  JOIN runner_plans p ON p.id=f.plan_id
  JOIN tasks t ON t.id=f.task_id AND t.project_directory=p.project_directory
  WHERE f.project_directory=? AND p.project_directory=? AND f.seq>? AND f.seq<=?
  ORDER BY f.seq LIMIT ?`

/** The stored projection of this project: its watermark and the rows queued for a re-read. */
function readProjectionState(db: Database, projectDirectory: string) {
  const present = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
       ('${DECISION_PROJECTION_TABLES.facts}','${DECISION_PROJECTION_TABLES.state}','${DECISION_PROJECTION_TABLES.dirty}')`,
    )
    .get()
  if (present?.n !== 3) return { foldedSeq: 0, dirty: new Set<number>() }
  const state = db
    .query<{ folded_seq: number }, [string]>(
      `SELECT folded_seq FROM ${DECISION_PROJECTION_TABLES.state} WHERE project_directory=?`,
    )
    .get(projectDirectory)
  if (!state) return { foldedSeq: 0, dirty: new Set<number>() }
  const dirty = new Set(
    db
      .query<{ seq: number }, [string]>(
        `SELECT seq FROM ${DECISION_PROJECTION_TABLES.dirty} WHERE project_directory=?`,
      )
      .all(projectDirectory)
      .map((row) => row.seq),
  )
  return { foldedSeq: state.folded_seq, dirty }
}

/**
 * The retained decision facts of a project, in sequence order, in one read transaction:
 *   - stored facts up to the projection watermark, except rows queued as changed,
 *   - the queued rows and every row above the watermark, projected from `runner_progress`.
 * With the projection folded the live part is empty; without a projection (an older database, a
 * read before the first fold) the whole table is the live part, as it was before the projection.
 */
function readDecisionProgress(
  db: Database,
  projectDirectory: string,
  signal?: AbortSignal,
): {
  facts: Record<string, unknown>[]
  fingerprint: string
  invalidCount: number
  notes: string[]
} {
  let invalidCount = 0
  const facts: Record<string, unknown>[] = []
  const notes: string[] = []
  const stats = privacyStats()
  let unreadableSourceLineage = 0
  let unreadableEventLineage = 0
  const { foldedSeq, dirty } = readProjectionState(db, projectDirectory)

  const take = (flags: number, fact: Record<string, unknown> | null) => {
    if (flags & FACT_MALFORMED_PAYLOAD) {
      invalidCount++
      return
    }
    if (flags & FACT_UNREADABLE_SOURCES) unreadableSourceLineage++
    if (flags & FACT_UNREADABLE_EVENTS) unreadableEventLineage++
    if (fact) facts.push(fact)
  }
  const takeLive = (row: DecisionProgressSource) => {
    decisionProjectionStats.readSourceRows++
    const projected = projectDecisionProgressRow(row, stats)
    take(projected.flags, projected.fact)
  }

  let after = 0
  while (foldedSeq > 0) {
    signal?.throwIfAborted()
    const page = db
      .query<
        { seq: number; flags: number; fact: string | null },
        [string, string, number, number, number]
      >(STORED_PROGRESS_SQL)
      .all(projectDirectory, projectDirectory, after, foldedSeq, DECISION_PROGRESS_BATCH_SIZE)
    for (const row of page) {
      after = row.seq
      decisionProjectionStats.readProjectionRows++
      if (dirty.has(row.seq)) continue
      take(row.flags, row.fact === null ? null : (JSON.parse(row.fact) as Record<string, unknown>))
    }
    if (page.length < DECISION_PROGRESS_BATCH_SIZE) break
  }
  if (dirty.size) {
    for (const seq of [...dirty].sort((left, right) => left - right)) {
      const row = db
        .query<DecisionProgressSource, [number, string, string]>(LIVE_ONE_SQL)
        .get(seq, projectDirectory, projectDirectory)
      if (row) takeLive(row)
    }
    facts.sort((left, right) => (left.sequence as number) - (right.sequence as number))
  }

  let afterSequence = foldedSeq
  while (true) {
    signal?.throwIfAborted()
    const batch = db
      .query<DecisionProgressSource, [string, string, number, number]>(LIVE_TAIL_SQL)
      .all(projectDirectory, projectDirectory, afterSequence, DECISION_PROGRESS_BATCH_SIZE)
    for (const row of batch) {
      afterSequence = row.seq
      takeLive(row)
    }
    if (batch.length < DECISION_PROGRESS_BATCH_SIZE) break
  }
  if (unreadableSourceLineage)
    notes.push(`${unreadableSourceLineage} retained decision facts have unreadable source lineage.`)
  if (unreadableEventLineage)
    notes.push(`${unreadableEventLineage} retained decision facts have unreadable event lineage.`)
  // The identity of the retained facts. The pinned observation revision already changes with any
  // write, so this need not hash every fact (that is the cost the projection removes).
  const last = facts.at(-1)
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        facts.length,
        last?.sequence ?? null,
        invalidCount,
        unreadableSourceLineage,
        unreadableEventLineage,
      ]),
    )
    .digest("hex")
  return { facts, fingerprint, invalidCount, notes }
}

/** Distinct notes in first-seen order; nothing is dropped. */
function uniqueNotes(values: string[]) {
  return [...new Set(values)]
}

/**
 * Every row of a table, streamed from the source. Nothing here caps or refuses: the
 * statement is stepped row by row inside the caller's read transaction.
 */
function queryAll<T>(db: Database, sql: string, params: string[]): T[] {
  return [...db.query<T, string[]>(sql).iterate(...params)]
}

function captureStatuses(db: Database) {
  const tableInfo: Record<string, TableInfo> = {
    tasks: inspectTable(db, "tasks", TASK_COLUMNS),
    task_references: inspectTable(db, "task_references", [
      "project_directory",
      "task_id",
      "reference",
    ]),
    task_classifications: inspectTable(db, "task_classifications", CLASSIFICATION_COLUMNS),
    task_dispositions: inspectTable(db, "task_dispositions", DISPOSITION_COLUMNS),
    runner_plans: inspectTable(db, "runner_plans", RUNNER_PLAN_COLUMNS),
    runner_nodes: inspectTable(db, "runner_nodes", NODE_COLUMNS),
    runner_attempts: inspectTable(db, "runner_attempts", ATTEMPT_COLUMNS),
    runner_transitions: inspectTable(db, "runner_transitions", TRANSITION_COLUMNS),
    runner_adoptions: inspectTable(db, "runner_adoptions", ADOPTION_COLUMNS),
    runner_progress: inspectTable(db, "runner_progress", PROGRESS_COLUMNS),
  }
  const statuses: SourceStatus[] = []
  for (const name of ["tasks", "task_references", "task_classifications", "task_dispositions"])
    statuses.push(source(tableInfo[name]!, name !== "tasks"))
  for (const name of [
    "runner_plans",
    "runner_nodes",
    "runner_attempts",
    "runner_transitions",
    "runner_adoptions",
    "runner_progress",
  ])
    statuses.push(source(tableInfo[name]!))
  return { tableInfo, statuses }
}

/** The task tables: membership, references, dispositions and classification history. */
function readTaskRows(
  db: Database,
  projectDirectory: string,
  tableInfo: Record<string, TableInfo>,
  notes: string[],
) {
  let references: RawReference[] = []
  const referenceInfo = tableInfo.task_references!
  if (referenceInfo.status === "available") {
    references = queryAll<RawReference>(
      db,
      "SELECT task_id,reference FROM task_references WHERE project_directory=? ORDER BY task_id",
      [projectDirectory],
    )
  } else if (referenceInfo.status === "legacy-absent" || referenceInfo.status === "missing-table") {
    notes.push("Task references are unavailable because the task_references table is absent.")
  }

  let dispositions: RawDisposition[] = []
  const dispositionInfo = tableInfo.task_dispositions!
  if (dispositionInfo.status === "available") {
    dispositions = queryAll<RawDisposition>(
      db,
      `SELECT id,task_id,request_id,disposition,reason,evidence,related_task_ids,
                session_id,agent,created_at
         FROM task_dispositions WHERE project_directory=? ORDER BY id`,
      [projectDirectory],
    )
  } else notes.push("Disposition history is unavailable in this database schema.")

  let classifications: Array<Record<string, unknown>> = []
  const classificationInfo = tableInfo.task_classifications!
  if (classificationInfo.status === "available") {
    classifications = queryAll<Record<string, unknown>>(
      db,
      `SELECT id,task_id,request_id,revision,classification,reason,session_id,agent,created_at
         FROM task_classifications WHERE project_directory=? ORDER BY task_id,revision`,
      [projectDirectory],
    )
  } else if (
    classificationInfo.status === "legacy-absent" ||
    classificationInfo.status === "missing-table"
  ) {
    notes.push(
      "Classification corrections are unavailable; only explicit embedded or legacy classification is used.",
    )
  }
  return { references, dispositions, classifications }
}

/** The runner tables, each only when the plans they hang from are readable. */
function readRunnerRows(
  db: Database,
  projectDirectory: string,
  statuses: SourceStatus[],
  options: { decision?: boolean; signal?: AbortSignal },
  notes: string[],
) {
  let plans: PlanRow[] = []
  let nodes: RawNode[] = []
  let attempts: AttemptRow[] = []
  let transitions: RawTransition[] = []
  let adoptions: AdoptionRow[] = []
  let progress: RawProgress[] = []
  let decisionProgressFacts: Record<string, unknown>[] = []
  let decisionProgressFingerprint: string | null = null

  const plansAvailable = sourceAvailable(statuses, "runner_plans")
  if (plansAvailable) {
    plans = queryAll<PlanRow>(
      db,
      `SELECT id,owner,revision,version,state,body,model,reason,artifact
         FROM runner_plans WHERE project_directory=? ORDER BY rowid`,
      [projectDirectory],
    )
  } else
    notes.push(
      "Execution plans are unavailable; task outcomes and routes cannot be inferred from current plan state.",
    )

  const taskNodesAvailable = plansAvailable && sourceAvailable(statuses, "runner_nodes")
  if (taskNodesAvailable) {
    nodes = queryAll<RawNode>(
      db,
      `SELECT n.plan_id,n.task_id,n.state,n.artifact
         FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id
         JOIN tasks t ON t.id=n.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? ORDER BY p.rowid,n.ordinal`,
      [projectDirectory],
    )
  } else notes.push("Task execution-node history is unavailable in this database schema.")

  if (plansAvailable && sourceAvailable(statuses, "runner_attempts")) {
    attempts = queryAll<AttemptRow>(
      db,
      `SELECT a.id,a.plan_id,a.task_id,a.number,a.session_id,a.message_id,a.workspace,a.base_commit,
                a.artifact,a.policy,a.state,a.started_at,a.token_count,a.tool_count,a.retry_count,a.cost
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? ORDER BY a.started_at,a.number,a.id`,
      [projectDirectory],
    )
  } else notes.push("Worker attempts are unavailable in this database schema.")

  if (plansAvailable && sourceAvailable(statuses, "runner_transitions")) {
    transitions = queryAll<RawTransition>(
      db,
      `SELECT r.id,r.plan_id,r.task_id,r.version,r.event,r.payload,r.created_at
         FROM runner_transitions r
         JOIN runner_plans p ON p.id=r.plan_id
         JOIN tasks t ON t.id=r.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? ORDER BY r.id`,
      [projectDirectory],
    )
  } else notes.push("Task transition history is unavailable in this database schema.")

  if (plansAvailable && sourceAvailable(statuses, "runner_adoptions")) {
    adoptions = queryAll<AdoptionRow>(
      db,
      `SELECT a.id,a.plan_id,a.task_id,a.attempt_id,a.attempt_state,a.old_artifact,a.descendant_commit,
                a.combined_artifact,a.reason,a.state,a.created_at,a.updated_at
         FROM runner_adoptions a
         JOIN runner_plans p ON p.id=a.plan_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? ORDER BY a.created_at,a.id`,
      [projectDirectory],
    )
  } else notes.push("Descendant-adoption history is unavailable in this database schema.")

  if (plansAvailable && sourceAvailable(statuses, "runner_progress")) {
    if (options.decision) {
      const retained = readDecisionProgress(db, projectDirectory, options.signal)
      decisionProgressFacts = retained.facts
      decisionProgressFingerprint = retained.fingerprint
      notes.push(...retained.notes)
      if (retained.invalidCount)
        notes.push(
          `${retained.invalidCount} retained decision progress facts have malformed JSON and were excluded.`,
        )
    } else {
      progress = queryAll<RawProgress>(
        db,
        `SELECT r.seq,r.project_directory,r.project_id,r.dedupe_key,r.plan_id,r.task_id,r.attempt_id,r.session_id,r.at,r.recorded_at,
                r.source,r.sources_json,r.kind,r.event_ids_json,r.call_id,r.message_id,r.payload
           FROM runner_progress r
           JOIN runner_plans p ON p.id=r.plan_id
           JOIN tasks t ON t.id=r.task_id AND t.project_directory=p.project_directory
           WHERE r.project_directory=? AND p.project_directory=?
           ORDER BY r.seq`,
        [projectDirectory, projectDirectory],
      )
    }
  } else notes.push("Retained progress observations are unavailable in this database schema.")

  return {
    plans,
    nodes,
    attempts,
    transitions,
    adoptions,
    progress,
    decisionProgressFacts,
    decisionProgressFingerprint,
  }
}

/**
 * The effective classification of every task whose immutable body is readable. The bodies and
 * the annotation rows are already in memory from the capture, so each body is parsed once and
 * no per-task query runs.
 */
function readClassificationSnapshots(
  projectDirectory: string,
  tasks: RawTask[],
  classifications: readonly Record<string, unknown>[],
  classificationTable: boolean,
  notes: string[],
) {
  const annotationsByTask = new Map<string, ClassificationAnnotationRow[]>()
  for (const row of classifications) {
    const annotation = row as unknown as ClassificationAnnotationRow
    const rows = annotationsByTask.get(annotation.task_id)
    if (rows) rows.push(annotation)
    else annotationsByTask.set(annotation.task_id, [annotation])
  }
  const snapshots = new Map<string, TaskClassificationSnapshot | null>()
  for (const row of tasks) {
    let parsed: TaskSpec | null = null
    try {
      const value: unknown = JSON.parse(row.body)
      const result = TaskSpecSchema.safeParse(value)
      if (
        result.success &&
        result.data.id === row.id &&
        result.data.provenance.projectDirectory === projectDirectory
      )
        parsed = result.data
      else notes.push(`Task ${row.id} has an unavailable or foreign immutable task body.`)
    } catch {
      notes.push(`Task ${row.id} has an unreadable immutable task body.`)
    }
    if (!parsed) {
      snapshots.set(row.id, null)
      continue
    }
    try {
      snapshots.set(
        row.id,
        classificationSnapshotFor(
          parsed,
          classificationTable ? (annotationsByTask.get(row.id) ?? []) : [],
        ),
      )
    } catch {
      snapshots.set(row.id, null)
      notes.push(`Task ${row.id} classification history is invalid or unavailable.`)
    }
  }
  return snapshots
}

function noteProgressProblems(progress: RawProgress[], decision: boolean, notes: string[]) {
  for (const row of progress) {
    const payload = parseObject(row.payload)
    if (!payload) notes.push(`Progress fact progress:${row.seq} has an unreadable payload.`)
    if (!decision) noteObservationProjection(row, payload, notes)
    if (!parseArray(row.sources_json))
      notes.push(`Progress fact progress:${row.seq} has unreadable source lineage.`)
    if (!parseArray(row.event_ids_json))
      notes.push(`Progress fact progress:${row.seq} has unreadable event lineage.`)
  }
}

/** What the retained projection of one progress fact leaves out. */
function noteObservationProjection(row: RawProgress, payload: JsonObject | null, notes: string[]) {
  const rawObservations = payload?.observations
  if (rawObservations !== undefined && !Array.isArray(rawObservations))
    notes.push(`Progress fact progress:${row.seq} has a non-array observation collection.`)
  if (Array.isArray(rawObservations)) {
    const candidates = rawObservations.filter((raw) => {
      const observation = object(raw)
      return (
        observation &&
        (observation.source === "native-event" || observation.source === "recovery") &&
        typeof observation.eventType === "string"
      )
    }).length
    const omitted = rawObservations.length - candidates
    if (omitted > 0)
      notes.push(
        `Progress fact progress:${row.seq} omits ${omitted} observations beyond the retained projection.`,
      )
  }
}

function noteDispositionProblems(dispositions: RawDisposition[], notes: string[]) {
  for (const row of dispositions) {
    for (const [field, raw] of [
      ["evidence", row.evidence],
      ["related task IDs", row.related_task_ids],
    ] as const)
      if (!parseArray(raw)) notes.push(`Disposition ${row.id} has unreadable ${field}.`)
  }
}

function readCapture(
  db: Database,
  projectDirectory: string,
  options: { decision?: boolean; signal?: AbortSignal } = {},
): CaptureResult {
  options.signal?.throwIfAborted()
  const notes: string[] = []
  const { tableInfo, statuses } = captureStatuses(db)
  return readCaptureRows(db, projectDirectory, options, tableInfo, statuses, notes)
}

function readCaptureRows(
  db: Database,
  projectDirectory: string,
  options: { decision?: boolean; signal?: AbortSignal },
  tableInfo: Record<string, TableInfo>,
  statuses: SourceStatus[],
  notes: string[],
): CaptureResult {
  if (tableInfo.tasks!.status !== "available")
    return { status: "unavailable", reason: "task-table-missing", sources: statuses }

  const tasks = queryAll<RawTask>(
    db,
    "SELECT id,created_at,body FROM tasks WHERE project_directory=? ORDER BY created_at,id",
    [projectDirectory],
  )
  options.signal?.throwIfAborted()
  const { references, dispositions, classifications } = readTaskRows(
    db,
    projectDirectory,
    tableInfo,
    notes,
  )
  const runner = readRunnerRows(db, projectDirectory, statuses, options, notes)
  const { decisionProgressFacts, decisionProgressFingerprint, ...runnerRows } = runner
  options.signal?.throwIfAborted()

  const sourceData = {
    projectDirectory,
    sources: statuses,
    tasks,
    references,
    dispositions,
    classifications,
    plans: runnerRows.plans,
    nodes: runnerRows.nodes,
    attempts: runnerRows.attempts,
    transitions: runnerRows.transitions,
    adoptions: runnerRows.adoptions,
    progress: runnerRows.progress,
    ...(options.decision
      ? {
          decisionProgressFingerprint,
          decisionProgressCount: decisionProgressFacts.length,
        }
      : {}),
  }

  const snapshots = readClassificationSnapshots(
    projectDirectory,
    tasks,
    classifications,
    tableInfo.task_classifications!.status === "available",
    notes,
  )

  options.signal?.throwIfAborted()
  const fingerprint = fingerprintOf({
    ...sourceData,
    effectiveClassifications: [...snapshots.entries()],
  })

  noteProgressProblems(runnerRows.progress, Boolean(options.decision), notes)
  noteDispositionProblems(dispositions, notes)

  return {
    status: "captured",
    capture: {
      ...sourceData,
      sourceStatuses: statuses,
      decisionProgressFacts,
      decisionProgressFingerprint,
      notes: uniqueNotes(notes),
      fingerprint,
      effectiveClassifications: snapshots,
    },
  }
}

/** A plan body is parsed once per read, however many of its attempts and nodes ask. */
const parsedPlanInputs = new WeakMap<PlanRow, ReturnType<typeof parsePlanInput>>()

function parsePlanInput(plan: PlanRow) {
  try {
    const value: unknown = JSON.parse(plan.body)
    // Parse only to reuse the existing exact plan contract. Its objective and
    // acceptance text never cross the retained ledger boundary.
    const parsed = PlanInput.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function planInput(plan: PlanRow) {
  if (parsedPlanInputs.has(plan)) return parsedPlanInputs.get(plan)!
  const parsed = parsePlanInput(plan)
  parsedPlanInputs.set(plan, parsed)
  return parsed
}

function routeSelection(
  route: Route | null,
  status: "explicit" | "inherited" | "recorded" | "unavailable",
  source: string | null,
): {
  route: Route | null
  status: "explicit" | "inherited" | "recorded" | "unavailable"
  source: string | null
} {
  return { route, status, source }
}

function routeValue(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const route = safeRoute(value, stats)
  return { route, accounting: accountingRoute(route) }
}

function routeOccurrencesForFacts(
  facts: ObservationLedgerOutput["tasks"][number]["progressFacts"] | ProjectedProgress[],
  stats: ReturnType<typeof privacyStats>,
): RouteOccurrence[] {
  const occurrences: RouteOccurrence[] = []
  for (const fact of facts) {
    const observations = fact.observations
    const routed = observations.filter((observation) => observation.routeStatus !== "not-observed")
    if (routed.length) {
      for (const observation of routed)
        occurrences.push({
          occurrenceID: observation.occurrenceID,
          attemptID: fact.attemptID,
          sessionID: fact.sessionID,
          messageID: observation.messageID,
          eventID: observation.eventID,
          source: observation.source,
          sourceType: observation.eventType,
          observedAt: observation.observedAt,
          route: observation.route,
          identityStatus: observation.routeStatus === "exact" ? "exact" : "unavailable",
        })
    } else if (fact.routeStatus !== "not-observed") {
      occurrences.push({
        occurrenceID: `${fact.id}:route`,
        attemptID: fact.attemptID,
        sessionID: fact.sessionID,
        messageID: fact.messageID,
        eventID: fact.eventIDs[0] ?? null,
        source: fact.source,
        sourceType: fact.sources.join("+"),
        observedAt: fact.at,
        route: fact.route,
        identityStatus: fact.routeStatus === "exact" ? "exact" : "unavailable",
      })
    }
  }
  return occurrences.map((occurrence) => {
    const route = occurrence.route ? safeRoute(occurrence.route, stats) : null
    return {
      ...occurrence,
      route,
      identityStatus: route ? "exact" : "unavailable",
    }
  })
}

type ProjectedProgress = ObservationLedgerOutput["tasks"][number]["progressFacts"][number]

function projectedProgress(
  row: RawProgress,
  stats: ReturnType<typeof privacyStats>,
): ProjectedProgress {
  const projected = projectProgressFact(row)
  const rawPayload = parseObject(row.payload)
  const rawObservations = list(rawPayload?.observations)
  const retainedIndexes = rawObservations.flatMap((raw, index) => {
    const observation = object(raw)
    return observation &&
      (observation.source === "native-event" || observation.source === "recovery") &&
      typeof observation.eventType === "string"
      ? [index]
      : []
  })
  const projectedObservations = list(projected.observations)
  const observations = projectedObservations.flatMap((raw, index) => {
    const observation = object(raw)
    if (!observation || typeof observation.eventType !== "string") return []
    const route = safeRoute(observation.route, stats)
    const observationRouteStatus: "not-observed" | "exact" | "unavailable" = route
      ? "exact"
      : observation.route === null || observation.route === undefined
        ? "not-observed"
        : "unavailable"
    return [
      {
        occurrenceID: `progress:${row.seq}:observation:${retainedIndexes[index] ?? index}`,
        source: typeof observation.source === "string" ? observation.source : "unknown",
        eventID: typeof observation.eventID === "string" ? observation.eventID : null,
        eventType: safeText(observation.eventType, stats, 160),
        observedAt: numberOrNull(observation.at),
        status:
          typeof observation.status === "string" ? safeText(observation.status, stats, 160) : null,
        messageID: typeof observation.messageID === "string" ? observation.messageID : null,
        callID: typeof observation.callID === "string" ? observation.callID : null,
        route,
        routeStatus: observationRouteStatus,
        identityStatus: "exact" as const,
      },
    ]
  })
  const omittedObservationCount = Math.max(0, rawObservations.length - observations.length)
  const rawRoute = routeValue(projected.route, stats).route
  const routeStatus = rawRoute
    ? "exact"
    : projected.route === null || projected.route === undefined
      ? "not-observed"
      : "unavailable"
  const rawUsage = object(projected.usage)
  const usage = rawUsage
    ? {
        input: nonnegativeOrNull(rawUsage.input),
        output: nonnegativeOrNull(rawUsage.output),
        reasoning: nonnegativeOrNull(rawUsage.reasoning),
        cacheRead: nonnegativeOrNull(rawUsage.cacheRead),
        cacheWrite: nonnegativeOrNull(rawUsage.cacheWrite),
        costUSD: nonnegativeOrNull(rawUsage.costUSD),
      }
    : null
  return {
    id: `progress:${row.seq}`,
    sequence: row.seq,
    attemptID: row.attempt_id,
    sessionID: row.session_id,
    messageID: typeof projected.messageID === "string" ? projected.messageID : null,
    callID: typeof projected.callID === "string" ? projected.callID : null,
    source:
      typeof projected.source === "string" ? projected.source : safeText(row.source, stats, 80),
    sources: stringList(projected.sources),
    eventIDs: stringList(projected.eventIDs),
    kind: typeof projected.kind === "string" ? projected.kind : `worker-${row.kind}`,
    at: row.at,
    recordedAt: numberOrNull(row.recorded_at),
    measurementBasis:
      typeof projected.measurementBasis === "string" ? projected.measurementBasis : null,
    usage,
    route: rawRoute,
    routeStatus,
    observations,
    observationCoverage: omittedObservationCount ? "truncated" : "complete",
    omittedObservationCount,
  }
}

function routeObservations(
  occurrences: RouteOccurrence[],
  omittedOccurrenceCount: number,
): ObservationLedgerOutput["tasks"][number]["attempts"][number]["observedRoutes"] {
  const exact = occurrences.flatMap((occurrence) =>
    occurrence.route && occurrence.identityStatus === "exact" ? [occurrence.route] : [],
  )
  const distinct = new Map(exact.map((route) => [JSON.stringify(route), route]))
  const distinctRoutes = [...distinct.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )
  const hasUnavailable = occurrences.some(
    (occurrence) => occurrence.identityStatus === "unavailable",
  )
  const status =
    distinctRoutes.length > 1
      ? "mixed-routes"
      : omittedOccurrenceCount > 0 || hasUnavailable
        ? "unavailable"
        : distinctRoutes.length === 1
          ? "single-route"
          : "none"
  const route = status === "single-route" ? distinctRoutes[0]! : null
  return {
    status,
    coverage: omittedOccurrenceCount ? "truncated" : "complete",
    route,
    distinctRoutes,
    occurrences,
    omittedOccurrenceCount,
    attribution: omittedOccurrenceCount
      ? "incomplete-truncated-route-observations"
      : status === "mixed-routes"
        ? "ambiguous-mixed-routes"
        : status === "single-route"
          ? "observed-route-does-not-prove-session-usage-attribution"
          : "unknown",
  }
}

function classificationView(
  classification: TaskClassificationSnapshot | null,
  stats: ReturnType<typeof privacyStats>,
): ObservationLedgerOutput["tasks"][number]["classification"] {
  if (!classification)
    return {
      catalog: OBSERVATION_LEDGER_CATALOG,
      kind: null,
      revision: null,
      provenance: null,
      history: [],
      status: "unavailable",
    }
  const history = classification.history.map((entry) => {
    const provenance = entry.provenance
    return TaskClassificationRevision.parse({
      revision: entry.revision,
      classification: entry.classification,
      provenance:
        provenance.kind === "legacy"
          ? provenance
          : provenance.kind === "embedded"
            ? {
                ...provenance,
                sessionID: safeText(provenance.sessionID, stats, 2048),
              }
            : {
                ...provenance,
                requestID: safeText(provenance.requestID, stats, 200),
                sessionID: safeText(provenance.sessionID, stats, 2048),
                agent: safeText(provenance.agent, stats, 200),
                reason: safeText(provenance.reason, stats, 2000),
              },
    })
  })
  const current = history.at(-1)!
  return {
    catalog: OBSERVATION_LEDGER_CATALOG,
    kind: current.classification?.primaryKind ?? null,
    revision: current.revision,
    provenance: current.provenance,
    history,
    status: "available",
  }
}

function decodeDisposition(row: RawDisposition, stats: ReturnType<typeof privacyStats>) {
  let evidence: unknown[] = []
  let relatedTaskIDs: unknown[] = []
  try {
    evidence = list(JSON.parse(row.evidence))
  } catch {
    // Keep the disposition identity and expose the malformed retained details as
    // an incomplete source rather than copying invalid source JSON.
  }
  try {
    relatedTaskIDs = list(JSON.parse(row.related_task_ids))
  } catch {
    // See above: no source payload is copied into the report.
  }
  return {
    id: row.id,
    requestID: safeText(row.request_id, stats, 200),
    disposition: ["superseded", "rejected", "duplicate", "fulfilled"].includes(row.disposition)
      ? row.disposition
      : "unknown",
    reason: safeText(row.reason, stats, 2000),
    evidence: evidence.flatMap((item) => {
      const value = object(item)
      if (!value || typeof value.kind !== "string" || typeof value.reference !== "string") return []
      const kind = ["verification", "artifact", "human"].includes(value.kind)
        ? (value.kind as "verification" | "artifact" | "human")
        : null
      return kind ? [{ kind, reference: safeText(value.reference, stats, 2000) }] : []
    }),
    relatedTaskIDs: relatedTaskIDs.flatMap((item) => (typeof item === "string" ? [item] : [])),
    sessionID: safeText(row.session_id, stats, 2048),
    agent: safeText(row.agent, stats, 200),
    createdAt: safeText(row.created_at, stats, 64),
  }
}

function routeSelectionFromPlan(
  input: ReturnType<typeof planInput>,
  stats: ReturnType<typeof privacyStats>,
) {
  if (!input) return routeSelection(null, "unavailable", null)
  if (!input.workerModel) return routeSelection(null, "inherited", "runner_plans.body.workerModel")
  const route = safeRoute(input.workerModel, stats)
  return routeSelection(route, route ? "explicit" : "unavailable", "runner_plans.body.workerModel")
}

function frozenRoute(
  attempt: AttemptRow,
  plan: PlanRow | undefined,
  stats: ReturnType<typeof privacyStats>,
) {
  const policy = parseObject(attempt.policy)
  if (policy && Object.hasOwn(policy, "model")) {
    const fromAttempt = safeRoute(policy.model, stats)
    return {
      selection: routeSelection(
        fromAttempt,
        fromAttempt ? "recorded" : "unavailable",
        "runner_attempts.policy.model",
      ),
      accounting: accountingRoute(fromAttempt),
      policy,
    }
  }
  const fromPlan = plan ? safeRoute(parseObject(plan.model), stats) : null
  return {
    selection: routeSelection(
      fromPlan,
      fromPlan ? "recorded" : "unavailable",
      fromPlan ? "runner_plans.model" : null,
    ),
    accounting: accountingRoute(fromPlan),
    policy,
  }
}

function persona(value: unknown): "ui" | "systems" | "small-refactoring" | null {
  return value === "ui" || value === "systems" || value === "small-refactoring" ? value : null
}

function taskAcceptance(
  taskID: string,
  taskAttempts: AttemptRow[],
  taskTransitions: RawTransition[],
  taskAdoptions: AdoptionRow[],
  stats: ReturnType<typeof privacyStats>,
) {
  const evidence: ObservationLedgerOutput["tasks"][number]["logicalOutcome"]["evidence"] = []
  const attemptsByPlan = new Map<string, AttemptRow[]>()
  for (const attempt of taskAttempts) {
    const values = attemptsByPlan.get(attempt.plan_id) ?? []
    values.push(attempt)
    attemptsByPlan.set(attempt.plan_id, values)
  }
  const transitionsByPlan = new Map<string, RawTransition[]>()
  for (const transition of taskTransitions) {
    const values = transitionsByPlan.get(transition.plan_id) ?? []
    values.push(transition)
    transitionsByPlan.set(transition.plan_id, values)
  }

  const artifactByAcceptTransition = new Map<number, RawTransition>()
  const adoptionByAcceptTransition = new Map<number, RawTransition>()
  for (const transitions of transitionsByPlan.values()) {
    let nextArtifact: RawTransition | undefined
    let nextAdoption: RawTransition | undefined
    for (let index = transitions.length - 1; index >= 0; index--) {
      const transition = transitions[index]!
      if (transition.event === "ACCEPT") {
        if (nextArtifact) artifactByAcceptTransition.set(transition.id, nextArtifact)
        nextArtifact = undefined
      } else if (transition.event === "ARTIFACT_ACCEPTED") nextArtifact = transition

      if (transition.event === "ADOPT_ACCEPT") {
        if (nextAdoption) adoptionByAcceptTransition.set(transition.id, nextAdoption)
        nextAdoption = undefined
      } else if (transition.event === "DESCENDANT_ADOPTED") nextAdoption = transition
    }
  }
  const adoptionsByID = new Map(taskAdoptions.map((adoption) => [adoption.id, adoption]))

  for (const transition of taskTransitions) {
    const payload = parseObject(transition.payload)
    if (transition.event === "ACCEPT" && payload?.to === "accepted") {
      const artifactEvent = artifactByAcceptTransition.get(transition.id)
      const artifactPayload = artifactEvent ? parseObject(artifactEvent.payload) : null
      const artifact = typeof artifactPayload?.commit === "string" ? artifactPayload.commit : null
      if (artifactEvent && artifact) {
        const candidates = (attemptsByPlan.get(transition.plan_id) ?? []).filter(
          (attempt) =>
            attempt.state === "accepted" &&
            attempt.artifact === artifact &&
            (typeof payload.attemptID !== "string" || payload.attemptID === attempt.id),
        )
        if (candidates.length)
          evidence.push({
            kind: "accept",
            planID: transition.plan_id,
            transitionID: transition.id,
            artifactEventID: artifactEvent.id,
            adoptionID: null,
            attemptID: candidates.length === 1 ? candidates[0]!.id : null,
            artifact: safeText(artifact, stats, 2048),
            acceptedAt: transition.created_at,
          })
      }
      continue
    }
    if (transition.event !== "ADOPT_ACCEPT" || payload?.to !== "accepted") continue
    const adoptedEvent = adoptionByAcceptTransition.get(transition.id)
    const adopted = adoptedEvent ? parseObject(adoptedEvent.payload) : null
    const adoption =
      typeof adopted?.adoptionID === "string" ? adoptionsByID.get(adopted.adoptionID) : undefined
    if (
      adoptedEvent &&
      adopted &&
      adoption &&
      adoption.plan_id === transition.plan_id &&
      adoption.task_id === taskID &&
      adoption.state === "accepted" &&
      adoption.attempt_id === adopted.attemptID &&
      adoption.descendant_commit === adopted.descendantCommit &&
      taskAttempts.some((attempt) => attempt.id === adoption.attempt_id)
    ) {
      evidence.push({
        kind: "adopt-accept",
        planID: transition.plan_id,
        transitionID: transition.id,
        artifactEventID: adoptedEvent.id,
        adoptionID: adoption.id,
        attemptID: adoption.attempt_id,
        artifact: safeText(adoption.descendant_commit, stats, 2048),
        acceptedAt: transition.created_at,
      })
    }
  }

  evidence.sort(
    (left, right) => left.acceptedAt - right.acceptedAt || left.transitionID - right.transitionID,
  )
  const acceptedAt = evidence.length ? Math.min(...evidence.map((item) => item.acceptedAt)) : null
  return {
    accepted: evidence.length > 0,
    acceptedAt,
    acceptedTaskCount: evidence.length ? (1 as const) : (0 as const),
    evidence,
  }
}

function categoryView(
  category:
    | ReturnType<
        typeof projectTaskEffortBasis
      >["usage"]["sessions"][number]["categories"][UsageCategory]
    | undefined,
  shared: boolean,
  sharedSessionIDs: string[],
): CategoryView {
  if (!category) {
    return {
      value: null,
      status: shared ? "ambiguous" : "missing",
      basis: "unavailable",
      valueScope: "unknown",
      source: null,
      observedAt: null,
      recordedAt: null,
      observationCount: 0,
      missingObservations: 0,
    }
  }
  return {
    value: shared ? null : category.value,
    status: shared ? "ambiguous" : category.status,
    basis: category.basis,
    valueScope: shared
      ? "unknown"
      : category.valueScope === "retained-additive-subtotal"
        ? "retained-additive-subtotal"
        : category.valueScope,
    source: category.source,
    observedAt: category.observedAt,
    recordedAt: category.observations.at(-1)?.recordedAt ?? null,
    observationCount: category.observationCount,
    missingObservations: category.missingObservations + (shared ? sharedSessionIDs.length : 0),
  }
}

function totalTokens(
  categories: Record<UsageCategory, CategoryView>,
  unallocatedSessionIDs: string[],
): TotalView {
  const measures = Object.values(categories)
  const values = measures.flatMap((measure) => (measure.value === null ? [] : [measure.value]))
  const observedSubtotal = values.length ? values.reduce((sum, value) => sum + value, 0) : null
  if (unallocatedSessionIDs.length)
    return {
      value: null,
      observedSubtotal,
      status: "ambiguous",
      valueScope: observedSubtotal === null ? "unknown" : "observed-subtotal",
      basis: "sum-of-categorized-session-usage; legacy attempt scalars are not added",
      unallocatedSessionIDs,
    }
  const missing = measures.some((measure) => ["missing", "unavailable"].includes(measure.status))
  const unavailable = measures.every((measure) => measure.status === "unavailable")
  const partial = measures.some((measure) => measure.status === "partial")
  const status =
    observedSubtotal === null
      ? unavailable
        ? "unavailable"
        : "missing"
      : missing || partial
        ? "partial"
        : "observed"
  return {
    value: observedSubtotal,
    observedSubtotal,
    status,
    valueScope:
      observedSubtotal === null
        ? "unknown"
        : status === "observed"
          ? "selected-session-categories"
          : "observed-subtotal",
    basis: "sum-of-categorized-session-usage; legacy attempt scalars are not added",
    unallocatedSessionIDs: [],
  }
}

function categoryMap(
  sessions: Array<ReturnType<typeof projectTaskEffortBasis>["usage"]["sessions"][number]>,
  sharedSessionIDs: string[],
): Record<UsageCategory, CategoryView> {
  const categories = {} as Record<UsageCategory, CategoryView>
  const categoryNames: UsageCategory[] = [
    "uncachedInput",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
  ]
  for (const name of categoryNames) {
    const measures = sessions.map((session) => session.categories[name])
    const values = measures.flatMap((measure) => (measure.value === null ? [] : [measure.value]))
    const observed = values.length > 0
    const missing = measures.some((measure) => measure.status !== "observed")
    const bases = [...new Set(measures.map((measure) => measure.basis))]
    const basis = bases.length > 1 ? "mixed" : (bases[0] ?? "unavailable")
    const source =
      [...new Set(measures.flatMap((measure) => (measure.source ? [measure.source] : [])))].join(
        "+",
      ) || null
    categories[name] = {
      value: observed ? values.reduce((sum, value) => sum + value, 0) : null,
      status: sharedSessionIDs.length
        ? "ambiguous"
        : !observed
          ? measures.some((measure) => measure.status === "unavailable")
            ? "unavailable"
            : "missing"
          : missing
            ? "partial"
            : "observed",
      basis,
      valueScope: !observed
        ? "unknown"
        : missing || sharedSessionIDs.length
          ? "observed-subtotal"
          : measures.every((measure) => measure.valueScope === "selected-cumulative-snapshot")
            ? "selected-cumulative-snapshot"
            : "retained-additive-subtotal",
      source,
      observedAt:
        measures
          .flatMap((measure) => (measure.observedAt === null ? [] : [measure.observedAt]))
          .sort((a, b) => b - a)[0] ?? null,
      recordedAt:
        measures
          .flatMap((measure) =>
            measure.observations.flatMap((item) =>
              item.recordedAt === null ? [] : [item.recordedAt],
            ),
          )
          .sort((a, b) => b - a)[0] ?? null,
      observationCount: measures.reduce((sum, measure) => sum + measure.observationCount, 0),
      missingObservations:
        measures.reduce((sum, measure) => sum + measure.missingObservations, 0) +
        sharedSessionIDs.length,
    }
  }
  return categories
}

function transitionView(row: RawTransition, stats: ReturnType<typeof privacyStats>) {
  const payload = parseObject(row.payload)
  return {
    id: row.id,
    planID: row.plan_id,
    event: safeText(row.event, stats, 160),
    at: row.created_at,
    attemptID: typeof payload?.attemptID === "string" ? payload.attemptID : null,
    from: typeof payload?.from === "string" ? safeText(payload.from, stats, 160) : null,
    to: typeof payload?.to === "string" ? safeText(payload.to, stats, 160) : null,
    reason: typeof payload?.reason === "string" ? safeText(payload.reason, stats, 2000) : null,
  }
}

function adoptionView(row: AdoptionRow, stats: ReturnType<typeof privacyStats>) {
  return {
    id: row.id,
    attemptID: row.attempt_id,
    state: safeText(row.state, stats, 160),
    attemptState: safeText(row.attempt_state, stats, 160),
    oldArtifact: safeText(row.old_artifact, stats, 2048),
    descendantCommit: safeText(row.descendant_commit, stats, 2048),
    combinedArtifact: safeText(row.combined_artifact, stats, 2048),
    reason: safeText(row.reason, stats, 2000),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function selectedUsage(
  accounting: ReturnType<typeof projectTaskEffortBasis>,
): Map<string, ReturnType<typeof projectTaskEffortBasis>["usage"]["sessions"][number]> {
  return new Map(accounting.usage.sessions.map((session) => [session.sessionID, session]))
}

function routeOccurrencesBySession(occurrences: RouteOccurrence[]) {
  const grouped = new Map<string, RouteOccurrence[]>()
  for (const occurrence of occurrences) {
    const values = grouped.get(occurrence.sessionID) ?? []
    values.push(occurrence)
    grouped.set(occurrence.sessionID, values)
  }
  return grouped
}

function readCursor(secret: Uint8Array, token: string) {
  const invalid = () => new Error("Observation ledger cursor is invalid or tampered")
  if (token.length > 8192) throw invalid()
  const [body, signature, extra] = token.split(".")
  if (!body || !signature || extra !== undefined) throw invalid()
  const expected = createHmac("sha256", secret).update(body).digest("base64url")
  const actualBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    throw invalid()
  try {
    const decoded = Buffer.from(body, "base64url")
    if (decoded.toString("base64url") !== body) throw invalid()
    const parsed: unknown = JSON.parse(decoded.toString("utf8"))
    const value = object(parsed)
    if (
      !value ||
      value.version !== 1 ||
      typeof value.scopeFingerprint !== "string" ||
      (typeof value.taskKind !== "string" && value.taskKind !== null) ||
      typeof value.limit !== "number" ||
      typeof value.offset !== "number" ||
      typeof value.snapshotID !== "string" ||
      typeof value.sourceFingerprint !== "string" ||
      typeof value.capturedAt !== "number"
    )
      throw invalid()
    const kind = value.taskKind === null ? null : TaskKindV1.safeParse(value.taskKind)
    if (value.taskKind !== null && !kind?.success) throw invalid()
    if (
      !Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 ||
      (value.limit as number) > 100 ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      !Number.isSafeInteger(value.capturedAt) ||
      !/^[a-f0-9]{64}$/.test(value.scopeFingerprint) ||
      !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
      typeof value.snapshotID !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.snapshotID)
    )
      throw invalid()
    return {
      scopeFingerprint: value.scopeFingerprint,
      taskKind: value.taskKind as string | null,
      limit: value.limit as number,
      offset: value.offset as number,
      snapshotID: value.snapshotID,
      sourceFingerprint: value.sourceFingerprint,
      capturedAt: value.capturedAt as number,
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Observation ledger cursor is invalid or tampered"
    )
      throw error
    throw invalid()
  }
}

function makeCursor(
  secret: Uint8Array,
  value: {
    scopeFingerprint: string
    taskKind: string | null
    limit: number
    offset: number
    snapshotID: string
    sourceFingerprint: string
    capturedAt: number
  },
) {
  const body = Buffer.from(JSON.stringify({ version: 1, ...value })).toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("base64url")
  const cursor = `${body}.${signature}`
  if (cursor.length > 8192) throw new Error("Observation ledger cursor exceeds its bound")
  return cursor
}

function emptyOutput(
  projectDirectory: string,
  taskKind: string | null,
  status: ObservationLedgerOutput["status"],
  reason: ObservationLedgerOutput["unavailableReason"],
  sources: SourceStatus[],
  notes: string[],
  limit = 50,
): ObservationLedgerOutput {
  const incomplete = status === "incomplete"
  const unavailable = status === "unavailable"
  return ObservationLedgerOutputSchema.parse({
    schemaVersion: 1,
    status,
    scope: { projectDirectory },
    filters: { taskKind },
    taskKindCatalog: { id: OBSERVATION_LEDGER_CATALOG, kinds: OBSERVATION_LEDGER_TASK_KINDS },
    pin: null,
    completeness: {
      status: incomplete ? "incomplete" : unavailable ? "unavailable" : "partial",
      reasons: uniqueNotes(notes),
      sources,
    },
    classificationCoverage: {
      classifiedTaskCount: null,
      unclassifiedTaskCount: null,
      unavailableTaskCount: null,
      excludedTaskCount: null,
      totalTaskCount: null,
    },
    page: {
      offset: 0,
      limit,
      returnedTaskCount: 0,
      totalTaskCount: null,
      totalSessionContributionCount: null,
    },
    tasks: [],
    sessionContributions: [],
    nextCursor: null,
    unavailableReason: reason,
  })
}

function publicTask(
  row: RawTask,
  referenceValue: string | undefined,
  classificationSnapshot: TaskClassificationSnapshot | null,
  taskPlans: PlanRow[],
  taskNodes: RawNode[],
  taskAttempts: AttemptRow[],
  taskTransitions: RawTransition[],
  taskDispositions: RawDisposition[],
  taskAdoptions: AdoptionRow[],
  taskFacts: ProjectedProgress[],
  sessionsByID: Map<string, ReturnType<typeof projectTaskEffortBasis>["usage"]["sessions"][number]>,
  sharedSessions: Set<string>,
  stats: ReturnType<typeof privacyStats>,
) {
  const taskID = row.id
  const classification = classificationView(classificationSnapshot, stats)
  const planByID = new Map(taskPlans.map((plan) => [plan.id, plan]))
  const attemptIDsByPlan = new Map<string, string[]>()
  for (const attempt of taskAttempts) {
    const group = attemptIDsByPlan.get(attempt.plan_id) ?? []
    group.push(attempt.id)
    attemptIDsByPlan.set(attempt.plan_id, group)
  }
  const taskOccurrences = routeOccurrencesForFacts(taskFacts, stats)
  const occurrencesByAttempt = new Map<string, RouteOccurrence[]>()
  for (const occurrence of taskOccurrences) {
    const group = occurrencesByAttempt.get(occurrence.attemptID) ?? []
    group.push(occurrence)
    occurrencesByAttempt.set(occurrence.attemptID, group)
  }
  const omittedRoutesByAttempt = new Map<string, number>()
  for (const fact of taskFacts)
    if (fact.omittedObservationCount > 0)
      omittedRoutesByAttempt.set(
        fact.attemptID,
        (omittedRoutesByAttempt.get(fact.attemptID) ?? 0) + fact.omittedObservationCount,
      )

  const attempts = taskAttempts.map((attempt) => {
    const plan = planByID.get(attempt.plan_id)
    const parsedPlan = plan ? planInput(plan) : null
    const requested = routeSelectionFromPlan(parsedPlan, stats)
    const frozen = frozenRoute(attempt, plan, stats)
    const requestedPersona = persona(
      parsedPlan?.nodes.find((node) => node.taskID === taskID)?.persona,
    )
    const frozenPersona = persona(frozen.policy?.persona)
    return {
      id: attempt.id,
      planID: attempt.plan_id,
      number: attempt.number,
      state: safeText(attempt.state, stats, 160),
      sessionID: attempt.session_id,
      messageID: attempt.message_id,
      startedAt: attempt.started_at,
      artifact: attempt.artifact,
      legacyTokenCount: nonnegativeOrNull(attempt.token_count),
      legacyTokenStatus: attempt.token_count === null ? "missing" : "retained-not-added",
      toolCount: Math.max(0, attempt.tool_count),
      retryCount: Math.max(0, attempt.retry_count),
      nativeReportedCostUSD: nonnegativeOrNull(attempt.cost),
      requestedRoute: requested,
      frozenRoute: frozen.selection,
      observedRoutes: routeObservations(
        occurrencesByAttempt.get(attempt.id) ?? [],
        omittedRoutesByAttempt.get(attempt.id) ?? 0,
      ),
      persona: {
        requested: requestedPersona,
        frozen: frozenPersona,
        status:
          requestedPersona === null
            ? "not-assigned"
            : frozenPersona === null
              ? "frozen-unavailable"
              : requestedPersona === frozenPersona
                ? "match"
                : "mismatch",
      },
    }
  })

  const sessionIDs = [...new Set(taskAttempts.map((attempt) => attempt.session_id))]
  const unallocatedSessionIDs = sessionIDs.filter((sessionID) => sharedSessions.has(sessionID))
  const usageSessions = sessionIDs.flatMap((sessionID) => {
    if (sharedSessions.has(sessionID)) return []
    const session = sessionsByID.get(sessionID)
    return session ? [session] : []
  })
  const categories = categoryMap(usageSessions, unallocatedSessionIDs)
  const total = totalTokens(categories, unallocatedSessionIDs)
  const executions = taskNodes.map((node) => {
    const plan = planByID.get(node.plan_id)
    return {
      planID: node.plan_id,
      planState: safeText(plan?.state ?? "unavailable", stats, 160),
      nodeState: safeText(node.state, stats, 160),
      artifact: node.artifact,
      attemptIDs: attemptIDsByPlan.get(node.plan_id) ?? [],
    }
  })
  const classificationsHistory = classification.history
  if (classificationsHistory.some((revision) => revision.revision < 0))
    throw new Error("Invalid classification revision in retained observation ledger")

  return {
    taskID,
    taskReference: referenceValue ?? null,
    submittedStatus: (() => {
      try {
        const body: unknown = JSON.parse(row.body)
        const parsed = TaskSpecSchema.safeParse(body)
        return parsed.success ? parsed.data.status : null
      } catch {
        return null
      }
    })(),
    createdAt: safeText(row.created_at, stats, 64),
    classification,
    logicalOutcome: taskAcceptance(taskID, taskAttempts, taskTransitions, taskAdoptions, stats),
    executions,
    attempts,
    sessionIDs,
    progressFacts: taskFacts,
    usage: { categories, totalTokens: total },
    dispositions: taskDispositions.map((item) => decodeDisposition(item, stats)),
    adoptions: taskAdoptions.map((item) => adoptionView(item, stats)),
    transitions: taskTransitions.map((item) => transitionView(item, stats)),
  }
}

function taskAccountingAttempt(
  attempt: AttemptRow,
  plan: PlanRow | undefined,
  taskID: string,
  stats: ReturnType<typeof privacyStats>,
): AccountingAttempt {
  const input = plan ? planInput(plan) : null
  const policy = parseObject(attempt.policy)
  const requestedRoute = routeSelectionFromPlan(input, stats)
  const frozen = frozenRoute(attempt, plan, stats)
  const requestedPersona = persona(input?.nodes.find((node) => node.taskID === taskID)?.persona)
  return {
    id: attempt.id,
    sessionID: attempt.session_id,
    state: attempt.state,
    legacyTokenCount: nonnegativeOrNull(attempt.token_count),
    recordedCostUSD: nonnegativeOrNull(attempt.cost),
    planRoute: accountingRoute(requestedRoute.route),
    planRouteStatus:
      requestedRoute.status === "explicit"
        ? "explicit"
        : requestedRoute.status === "inherited"
          ? "inherited"
          : "unavailable",
    frozenRoute: frozen.accounting,
    frozenRouteSource: frozen.selection.source,
    personaRequested: requestedPersona,
    personaFrozen: persona(policy?.persona),
    // The ledger deliberately performs no native session lookup. A missing or
    // not-read session is never used to manufacture route or usage observations.
    sessionStatus: "unavailable",
    contextStatus: "not-read",
    currentRoute: null,
    currentRouteObservedAt: null,
    sessionUsage: null,
    sessionUsageObservedAt: null,
    stepRoutes: [],
  }
}

function decisionProjection(
  capture: RawCapture,
  projectDirectory: string,
  sourceRevision: number,
): ObservationLedgerDecisionCapture {
  const stats = privacyStats()
  const references = new Map(capture.references.map((item) => [item.task_id, item.reference]))
  const plansByID = new Map(capture.plans.map((plan) => [plan.id, plan]))
  const attemptsByTask = new Map<string, AttemptRow[]>()
  const attemptsByPlan = new Map<string, Set<string>>()
  const nodesByTask = new Map<string, RawNode[]>()
  const transitionsByTask = new Map<string, RawTransition[]>()
  const adoptionsByTask = new Map<string, AdoptionRow[]>()
  for (const node of capture.nodes) {
    const values = nodesByTask.get(node.task_id) ?? []
    values.push(node)
    nodesByTask.set(node.task_id, values)
    const taskIDs = attemptsByPlan.get(node.plan_id) ?? new Set<string>()
    taskIDs.add(node.task_id)
    attemptsByPlan.set(node.plan_id, taskIDs)
  }
  for (const attempt of capture.attempts) {
    const values = attemptsByTask.get(attempt.task_id) ?? []
    values.push(attempt)
    attemptsByTask.set(attempt.task_id, values)
    const taskIDs = attemptsByPlan.get(attempt.plan_id) ?? new Set<string>()
    taskIDs.add(attempt.task_id)
    attemptsByPlan.set(attempt.plan_id, taskIDs)
  }
  for (const transition of capture.transitions) {
    const values = transitionsByTask.get(transition.task_id) ?? []
    values.push(transition)
    transitionsByTask.set(transition.task_id, values)
  }
  for (const adoption of capture.adoptions) {
    const values = adoptionsByTask.get(adoption.task_id) ?? []
    values.push(adoption)
    adoptionsByTask.set(adoption.task_id, values)
  }

  const accountingByID = new Map(
    capture.attempts.map((attempt) => [
      attempt.id,
      taskAccountingAttempt(attempt, plansByID.get(attempt.plan_id), attempt.task_id, stats),
    ]),
  )
  const tasks = capture.tasks.map((row): ObservationLedgerDecisionTask => {
    const classification = capture.effectiveClassifications.get(row.id) ?? null
    const taskAttempts = attemptsByTask.get(row.id) ?? []
    let submittedStatus: string | null = null
    try {
      const parsed = TaskSpecSchema.safeParse(JSON.parse(row.body))
      if (
        parsed.success &&
        parsed.data.id === row.id &&
        parsed.data.provenance.projectDirectory === projectDirectory
      )
        submittedStatus = parsed.data.status
    } catch {
      // Existing ledger notes already disclose invalid immutable task bodies.
    }
    const rawReference = references.get(row.id)
    const reference = rawReference ? TaskReferenceSchema.safeParse(rawReference) : null
    const effective = classification?.current
    const acceptance = taskAcceptance(
      row.id,
      taskAttempts,
      transitionsByTask.get(row.id) ?? [],
      adoptionsByTask.get(row.id) ?? [],
      stats,
    )
    const attempts = taskAttempts.map((attempt) => ({
      accounting: accountingByID.get(attempt.id)!,
      number: attempt.number,
      retryCount: attempt.retry_count,
      startedAt: attempt.started_at,
    }))
    const terminalStates = new Set(["accepted", "failed", "cancelled", "exhausted", "incorporated"])
    const terminal =
      acceptance.accepted ||
      (nodesByTask.get(row.id) ?? []).some((node) => terminalStates.has(node.state))
    return {
      taskID: row.id,
      taskReference: reference?.success ? reference.data : null,
      createdAt: row.created_at,
      submittedStatus,
      classification: {
        kind: effective?.classification?.primaryKind ?? null,
        revision: effective?.revision ?? null,
        provenance: effective?.provenance ?? null,
        history: classification?.history ?? [],
        status: classification ? "available" : "unavailable",
      },
      acceptance,
      attempts,
      terminal,
    }
  })
  const progressFacts = capture.decisionProgressFacts
  const classifiedTaskCount = tasks.filter(
    (task) => task.classification.status === "available" && task.classification.kind !== null,
  ).length
  const unclassifiedTaskCount = tasks.filter(
    (task) => task.classification.status === "available" && task.classification.kind === null,
  ).length
  const unavailableTaskCount = tasks.filter(
    (task) => task.classification.status === "unavailable",
  ).length
  return {
    status: "captured",
    projectDirectory,
    capturedAt: Date.now(),
    sourceFingerprint: hash({
      capture: capture.fingerprint,
      sourceRevision,
      projectedProgressCount: progressFacts.length,
    }),
    sourceRevision,
    sources: capture.sourceStatuses,
    notes: uniqueNotes(capture.notes),
    tasks,
    progressFacts,
    classificationCoverage: {
      classifiedTaskCount,
      unclassifiedTaskCount,
      unavailableTaskCount,
      totalTaskCount: tasks.length,
    },
  }
}

function outputFromCapture(
  capture: RawCapture,
  projectDirectory: string,
  parsedInput: ReturnType<typeof ObservationLedgerReadInputSchema.parse>,
  secret: Uint8Array,
  suppliedCursor?: string,
): ObservationLedgerOutput {
  const classes = capture.effectiveClassifications
  const stats = privacyStats()
  const references = new Map(capture.references.map((item) => [item.task_id, item.reference]))
  const planByID = new Map(capture.plans.map((plan) => [plan.id, plan]))
  const attemptsByTask = new Map<string, AttemptRow[]>()
  for (const attempt of capture.attempts) {
    const listForTask = attemptsByTask.get(attempt.task_id) ?? []
    listForTask.push(attempt)
    attemptsByTask.set(attempt.task_id, listForTask)
  }
  const taskByID = new Map(capture.tasks.map((task) => [task.id, task]))
  const taskIDsBySession = new Map<string, Set<string>>()
  const attemptsBySession = new Map<string, AttemptRow[]>()
  for (const attempt of capture.attempts) {
    if (!taskByID.has(attempt.task_id)) continue
    const taskIDs = taskIDsBySession.get(attempt.session_id) ?? new Set<string>()
    taskIDs.add(attempt.task_id)
    taskIDsBySession.set(attempt.session_id, taskIDs)
    const attempts = attemptsBySession.get(attempt.session_id) ?? []
    attempts.push(attempt)
    attemptsBySession.set(attempt.session_id, attempts)
  }

  const progressBySequence = new Map(capture.progress.map((row) => [row.seq, row]))
  const projectedFacts = capture.progress.map((row) => projectedProgress(row, stats))
  const accountingFacts = projectedFacts.map((fact) => {
    const source = progressBySequence.get(fact.sequence)
    return {
      ...fact,
      // Preserve exact source identities before accounting reduces observations.
      attemptID: source?.attempt_id ?? fact.attemptID,
      sessionID: source?.session_id ?? fact.sessionID,
    }
  })
  const accountingAttempts = capture.attempts.map((attempt) =>
    taskAccountingAttempt(attempt, planByID.get(attempt.plan_id), attempt.task_id, stats),
  )
  const effort = projectTaskEffortBasis({
    attempts: accountingAttempts,
    progressFacts: accountingFacts,
    progressTruncated: false,
    truncatedContextSessionIDs: [],
  })
  const sessionUsageByID = selectedUsage(effort)
  const allRouteOccurrences = routeOccurrencesForFacts(projectedFacts, stats)
  const routeOccurrencesBySessionID = routeOccurrencesBySession(allRouteOccurrences)
  const omittedRoutesBySession = new Map<string, number>()
  for (const fact of projectedFacts)
    if (fact.omittedObservationCount > 0)
      omittedRoutesBySession.set(
        fact.sessionID,
        (omittedRoutesBySession.get(fact.sessionID) ?? 0) + fact.omittedObservationCount,
      )
  const sharedSessions = new Set(
    [...taskIDsBySession.entries()].flatMap(([sessionID, taskIDs]) =>
      taskIDs.size > 1 ? [sessionID] : [],
    ),
  )
  const taskProgress = new Map<string, ProjectedProgress[]>()
  for (const fact of projectedFacts) {
    const source = progressBySequence.get(fact.sequence)
    const attemptID = source?.attempt_id ?? fact.attemptID
    const group = taskProgress.get(attemptID) ?? []
    group.push(fact)
    taskProgress.set(attemptID, group)
  }
  const dispositionsByTask = new Map<string, RawDisposition[]>()
  for (const disposition of capture.dispositions) {
    const group = dispositionsByTask.get(disposition.task_id) ?? []
    group.push(disposition)
    dispositionsByTask.set(disposition.task_id, group)
  }
  const nodesByTask = new Map<string, RawNode[]>()
  for (const node of capture.nodes) {
    const group = nodesByTask.get(node.task_id) ?? []
    group.push(node)
    nodesByTask.set(node.task_id, group)
  }
  const transitionsByTask = new Map<string, RawTransition[]>()
  for (const transition of capture.transitions) {
    const group = transitionsByTask.get(transition.task_id) ?? []
    group.push(transition)
    transitionsByTask.set(transition.task_id, group)
  }
  const adoptionsByTask = new Map<string, AdoptionRow[]>()
  for (const adoption of capture.adoptions) {
    const group = adoptionsByTask.get(adoption.task_id) ?? []
    group.push(adoption)
    adoptionsByTask.set(adoption.task_id, group)
  }
  const taskIDsByPlan = new Map<string, Set<string>>()
  for (const node of capture.nodes) {
    const group = taskIDsByPlan.get(node.plan_id) ?? new Set<string>()
    group.add(node.task_id)
    taskIDsByPlan.set(node.plan_id, group)
  }
  for (const attempt of capture.attempts) {
    const group = taskIDsByPlan.get(attempt.plan_id) ?? new Set<string>()
    group.add(attempt.task_id)
    taskIDsByPlan.set(attempt.plan_id, group)
  }
  const plansByTask = new Map<string, PlanRow[]>()
  for (const plan of capture.plans)
    for (const taskID of taskIDsByPlan.get(plan.id) ?? []) {
      const group = plansByTask.get(taskID) ?? []
      group.push(plan)
      plansByTask.set(taskID, group)
    }

  const allTaskRows = capture.tasks.map((row) => {
    const taskAttempts = attemptsByTask.get(row.id) ?? []
    const taskFacts = taskAttempts.flatMap((attempt) => taskProgress.get(attempt.id) ?? [])
    const plans = plansByTask.get(row.id) ?? []
    const reference = references.get(row.id)
    const parsedReference = reference ? TaskReferenceSchema.safeParse(reference) : null
    return publicTask(
      row,
      parsedReference?.success ? parsedReference.data : undefined,
      classes.get(row.id) ?? null,
      plans,
      nodesByTask.get(row.id) ?? [],
      taskAttempts,
      transitionsByTask.get(row.id) ?? [],
      dispositionsByTask.get(row.id) ?? [],
      adoptionsByTask.get(row.id) ?? [],
      taskFacts,
      sessionUsageByID,
      sharedSessions,
      stats,
    )
  })

  const classifiedTaskCount = allTaskRows.filter(
    (task) => task.classification.status === "available" && task.classification.kind !== null,
  ).length
  const unclassifiedTaskCount = allTaskRows.filter(
    (task) => task.classification.status === "available" && task.classification.kind === null,
  ).length
  const unavailableTaskCount = allTaskRows.filter(
    (task) => task.classification.status === "unavailable",
  ).length
  const filteredRows =
    parsedInput.taskKind === undefined || parsedInput.taskKind === null
      ? allTaskRows
      : allTaskRows.filter((task) => task.classification.kind === parsedInput.taskKind)

  let cursor: ReturnType<typeof readCursor> | null = null
  if (suppliedCursor) {
    cursor = readCursor(secret, suppliedCursor)
    if (cursor.scopeFingerprint !== hash(projectDirectory))
      throw new Error("Observation ledger cursor scope does not match this project")
    if (cursor.taskKind !== (parsedInput.taskKind ?? null))
      throw new Error("Observation ledger cursor task-kind filter does not match")
    if (cursor.limit !== parsedInput.limit)
      throw new Error("Observation ledger cursor page size does not match")
    if (cursor.sourceFingerprint !== capture.fingerprint)
      throw new Error("Observation ledger cursor is stale because retained facts changed")
    if (cursor.offset > filteredRows.length)
      throw new Error("Observation ledger cursor offset is unavailable")
  }

  const capturedAt = cursor?.capturedAt ?? Date.now()
  const snapshotID = cursor?.snapshotID ?? randomUUID()
  const offset = cursor?.offset ?? 0
  const pageRows = filteredRows.slice(offset, offset + parsedInput.limit)
  const pageIDs = new Set(pageRows.map((task) => task.taskID))
  const sessionAnchors = new Map<string, string>()
  for (const task of filteredRows)
    for (const sessionID of task.sessionIDs)
      if (!sessionAnchors.has(sessionID)) sessionAnchors.set(sessionID, task.taskID)

  const contributionIDs = [...sessionAnchors.keys()].sort()
  const sessionContributions = contributionIDs.flatMap((sessionID) => {
    const pageAnchorTaskID = sessionAnchors.get(sessionID)!
    if (!pageIDs.has(pageAnchorTaskID)) return []
    const attempts = attemptsBySession.get(sessionID) ?? []
    const usage = sessionUsageByID.get(sessionID)
    const shared = sharedSessions.has(sessionID)
    const categories = {} as Record<UsageCategory, CategoryView>
    const names: UsageCategory[] = [
      "uncachedInput",
      "output",
      "reasoning",
      "cacheRead",
      "cacheWrite",
    ]
    for (const name of names) categories[name] = categoryView(usage?.categories[name], false, [])
    const total = totalTokens(categories, [])
    const routeView = routeObservations(
      routeOccurrencesBySessionID.get(sessionID) ?? [],
      omittedRoutesBySession.get(sessionID) ?? 0,
    )
    return [
      {
        sessionID,
        pageAnchorTaskID,
        taskIDs: [...(taskIDsBySession.get(sessionID) ?? new Set())].sort(),
        attemptIDs: attempts.map((attempt) => attempt.id),
        allocation: shared ? "ambiguous-shared-logical-tasks" : "one-logical-task",
        categories,
        totalTokens: total,
        observedRoutes: routeView,
      },
    ]
  })

  const sourceStatuses = capture.sourceStatuses
  const completenessReasons = [...capture.notes]
  for (const status of sourceStatuses)
    if (status.status !== "available")
      completenessReasons.push(
        status.status === "legacy-absent"
          ? `${status.name} is absent from this legacy schema.`
          : `${status.name} is ${status.status}${status.missingColumns.length ? `; missing ${status.missingColumns.join(", ")}` : ""}.`,
      )
  const uniqueReasons = uniqueNotes(completenessReasons)
  const partial = uniqueReasons.length > 0
  const nextOffset = offset + pageRows.length
  const nextCursor =
    nextOffset < filteredRows.length
      ? makeCursor(secret, {
          scopeFingerprint: hash(projectDirectory),
          taskKind: parsedInput.taskKind ?? null,
          limit: parsedInput.limit,
          offset: nextOffset,
          snapshotID,
          sourceFingerprint: capture.fingerprint,
          capturedAt,
        })
      : null

  return ObservationLedgerOutputSchema.parse({
    schemaVersion: 1,
    status: partial ? "partial" : "available",
    scope: { projectDirectory },
    filters: { taskKind: parsedInput.taskKind ?? null },
    taskKindCatalog: { id: OBSERVATION_LEDGER_CATALOG, kinds: OBSERVATION_LEDGER_TASK_KINDS },
    pin: {
      snapshotID,
      sourceFingerprint: capture.fingerprint,
      capturedAt,
      completeness: partial ? "partial" : "complete",
    },
    completeness: {
      status: partial ? "partial" : "complete",
      reasons: uniqueReasons,
      sources: sourceStatuses,
    },
    classificationCoverage: {
      classifiedTaskCount,
      unclassifiedTaskCount,
      unavailableTaskCount,
      excludedTaskCount: allTaskRows.length - filteredRows.length,
      totalTaskCount: allTaskRows.length,
    },
    page: {
      offset,
      limit: parsedInput.limit,
      returnedTaskCount: pageRows.length,
      totalTaskCount: filteredRows.length,
      totalSessionContributionCount: contributionIDs.length,
    },
    tasks: pageRows,
    sessionContributions,
    nextCursor,
    unavailableReason: null,
  })
}

function buildUnavailable(
  projectDirectory: string,
  input: ReturnType<typeof ObservationLedgerReadInputSchema.parse>,
  reason: ObservationLedgerOutput["unavailableReason"],
  sources: SourceStatus[],
) {
  return ObservationLedgerOutputSchema.parse({
    ...emptyOutput(projectDirectory, input.taskKind ?? null, "unavailable", reason, sources, [
      reason === "database-missing"
        ? "The project database does not exist; it was not created."
        : reason === "task-table-missing"
          ? "The project database has no readable tasks table."
          : "The existing project database could not be opened read-only.",
    ]),
    filters: { taskKind: input.taskKind ?? null },
    page: {
      offset: 0,
      limit: input.limit,
      returnedTaskCount: 0,
      totalTaskCount: null,
      totalSessionContributionCount: null,
    },
  })
}

export type ReadOnlyObservationLedger = {
  read(input?: ObservationLedgerReadInput | unknown): ObservationLedgerOutput
  readDecision(signal?: AbortSignal): ObservationLedgerDecisionRead
  decisionRevision(): number | null
  close(): void
}

/** Open an existing project DB read-only. The reader never migrates or calls native session APIs. */
export function openReadOnlyObservationLedger(
  path: string,
  projectDirectory: string,
  options: { cursorSecret?: Uint8Array } = {},
): ReadOnlyObservationLedger {
  let db: Database | null = null
  let shared: SharedConnection | null = null
  let openError: "database-missing" | "database-unavailable" | null = null
  try {
    shared = acquireSharedConnection(path, "readonly")
    db = shared.db
  } catch {
    openError = existsSync(path) ? "database-unavailable" : "database-missing"
  }
  const secret = options.cursorSecret ? new Uint8Array(options.cursorSecret) : randomBytes(32)
  let closed = false

  const currentDecisionRevision = () => {
    if (!db || closed) throw new Error("Observation ledger reader is closed")
    const exists = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_revisions'",
      )
      .get()
    if (!exists) return null
    const row = db
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM observation_revisions WHERE project_directory=?",
      )
      .get(projectDirectory)
    const revision = row?.revision ?? 0
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Project observation revision is invalid")
    return revision
  }

  return {
    read(input: ObservationLedgerReadInput | unknown = {}) {
      if (closed) throw new Error("Observation ledger reader is closed")
      const parsed = ObservationLedgerReadInputSchema.parse(input)
      if (parsed.cursor && !db)
        throw new Error("Observation ledger cursor cannot continue an unavailable database read")
      if (!db)
        return buildUnavailable(projectDirectory, parsed, openError ?? "database-unavailable", [])

      const captureResult = db.transaction(() => readCapture(db!, projectDirectory)).deferred()
      if (captureResult.status === "unavailable")
        return buildUnavailable(
          projectDirectory,
          parsed,
          captureResult.reason,
          captureResult.sources,
        )
      const capture = captureResult.capture
      if (parsed.cursor) {
        const cursor = readCursor(secret, parsed.cursor)
        if (cursor.scopeFingerprint !== hash(projectDirectory))
          throw new Error("Observation ledger cursor scope does not match this project")
        if (cursor.taskKind !== (parsed.taskKind ?? null))
          throw new Error("Observation ledger cursor task-kind filter does not match")
        if (cursor.limit !== parsed.limit)
          throw new Error("Observation ledger cursor page size does not match")
        if (cursor.sourceFingerprint !== capture.fingerprint)
          throw new Error("Observation ledger cursor is stale because retained facts changed")
      }
      return outputFromCapture(capture, projectDirectory, parsed, secret, parsed.cursor)
    },
    readDecision(signal) {
      if (closed) throw new Error("Observation ledger reader is closed")
      signal?.throwIfAborted()
      if (!db)
        return {
          status: "unavailable",
          projectDirectory,
          sourceRevision: null,
          reason: openError ?? "database-unavailable",
          sources: [],
        }
      if (currentDecisionRevision() === null)
        return {
          status: "incomplete",
          projectDirectory,
          sourceRevision: null,
          reason: "Project-scoped observation revision tracking is unavailable.",
          sources: [],
          notes: [
            "A coherent decision snapshot cannot be pinned without project-scoped revisions.",
          ],
        }
      const result = db
        .transaction(() => {
          const sourceRevision = currentDecisionRevision()
          if (sourceRevision === null)
            throw new Error("Project-scoped observation revision tracking is unavailable")
          return {
            sourceRevision,
            capture: readCapture(db!, projectDirectory, { decision: true, signal }),
          }
        })
        .deferred()
      signal?.throwIfAborted()
      if (result.capture.status === "unavailable")
        return {
          status: "unavailable",
          projectDirectory,
          sourceRevision: result.sourceRevision,
          reason: result.capture.reason,
          sources: result.capture.sources,
        }
      const projection = decisionProjection(
        result.capture.capture,
        projectDirectory,
        result.sourceRevision,
      )
      signal?.throwIfAborted()
      return projection
    },
    decisionRevision: currentDecisionRevision,
    close() {
      if (closed) return
      closed = true
      shared?.release()
      shared = null
      db = null
    },
  }
}
