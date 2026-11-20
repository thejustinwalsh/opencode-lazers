import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import {
  registerLifecycleTransitions,
  type PlanningRunState,
  type PlanningState,
} from "../runner/lifecycle-machines.ts"
import type { TaskRepository } from "../storage.ts"

type Storage = Pick<TaskRepository, "read" | "atomic">

/** Additive tables for the planning flow. No existing table changes. */
export function installPlanningSchema(repository: TaskRepository): void {
  const module = schemaModules.planning
  repository.installSchema("planning", module.generation, module.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS planning_decisions (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, created_at INTEGER NOT NULL, ask_text TEXT NOT NULL,
        ask_chars INTEGER NOT NULL, strategy TEXT, decider TEXT, decider_model TEXT,
        status TEXT NOT NULL CHECK(status IN ('decided','none','unavailable')),
        reason TEXT, size TEXT, scores_json TEXT, selected_json TEXT, threshold REAL,
        constants_json TEXT, model_ms INTEGER, elapsed_ms INTEGER, calls INTEGER,
        open_planning_ids_json TEXT, delivered_text TEXT, late_json TEXT, architect_json TEXT,
        UNIQUE(session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS planning_decision_nodes (
        decision_id TEXT NOT NULL, node_id TEXT NOT NULL, parent_id TEXT, depth INTEGER NOT NULL,
        span_start INTEGER, span_end INTEGER, kind TEXT, calls_json TEXT, outcome TEXT,
        input_tokens INTEGER, elapsed_ms INTEGER, PRIMARY KEY(decision_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS planning_plannings (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL, project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL, decision_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        tasked_plan_id TEXT
      );
      CREATE INDEX IF NOT EXISTS planning_plannings_session ON planning_plannings(session_id);
      CREATE TABLE IF NOT EXISTS planning_revisions (
        planning_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        validation TEXT NOT NULL, field_hashes TEXT NOT NULL, author_session TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY(planning_id, revision)
      );
      CREATE TABLE IF NOT EXISTS planning_reviews (
        id TEXT PRIMARY KEY, planning_id TEXT NOT NULL, revision INTEGER NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('review','final')), selection_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, settled_at INTEGER, returned_at INTEGER, notified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS planning_reviews_planning ON planning_reviews(planning_id);
      CREATE TABLE IF NOT EXISTS planning_runs (
        id TEXT PRIMARY KEY, review_id TEXT NOT NULL, agent TEXT NOT NULL, attempt INTEGER NOT NULL,
        session_id TEXT, state TEXT NOT NULL, prompt_message_id TEXT, started_at INTEGER NOT NULL,
        last_activity_at INTEGER, max_gap_ms INTEGER, ended_at INTEGER, reason TEXT, raw_reply TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, model_json TEXT,
        map_hash TEXT, map_tokens INTEGER, duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS planning_runs_review ON planning_runs(review_id);
      CREATE TABLE IF NOT EXISTS planning_findings (
        id TEXT PRIMARY KEY, planning_id TEXT NOT NULL, review_id TEXT NOT NULL, run_id TEXT NOT NULL,
        source TEXT NOT NULL, agent_finding_id TEXT, revision INTEGER NOT NULL, draft_id TEXT,
        unit TEXT, field TEXT, severity TEXT, confidence TEXT, body TEXT NOT NULL,
        resolution TEXT NOT NULL DEFAULT 'open'
          CHECK(resolution IN ('open','revised','contested','to-owner','answered')),
        resolution_json TEXT, resolved_revision INTEGER
      );
      CREATE INDEX IF NOT EXISTS planning_findings_planning ON planning_findings(planning_id);
      CREATE TABLE IF NOT EXISTS planning_questions (
        id TEXT PRIMARY KEY, planning_id TEXT NOT NULL, review_id TEXT NOT NULL, source TEXT NOT NULL,
        agent_question_id TEXT, revision INTEGER NOT NULL, finding_id TEXT, weight TEXT,
        body TEXT NOT NULL,
        route TEXT NOT NULL DEFAULT 'open'
          CHECK(route IN ('open','conversation','owner','merged','owner-answered')),
        merged_into TEXT, answer TEXT, citation_json TEXT, answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS planning_questions_planning ON planning_questions(planning_id);
      CREATE TABLE IF NOT EXISTS planning_tasked (
        planning_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
        task_id TEXT, reference TEXT, plan_id TEXT, self_review_id TEXT, changed_fields_json TEXT,
        PRIMARY KEY(planning_id, draft_id)
      );
    `)
    // Generation 1 had no `architect_json`; the Architect's own classification is recorded beside D1's.
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(planning_decisions)")
      .all()
      .map((column) => column.name)
    if (!columns.includes("architect_json"))
      db.exec("ALTER TABLE planning_decisions ADD COLUMN architect_json TEXT")
  })
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** `null` and `undefined` are the same absent value; SQLite columns are nullable except keys. */
type Fields = Record<string, string | number | null | undefined>

function insert(db: Database, table: string, row: object, conflict = ""): number {
  const entries = Object.entries(row as Fields).filter(([, value]) => value !== undefined)
  const columns = entries.map(([key]) => snake(key))
  return db
    .query(
      `INSERT ${conflict} INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    )
    .run(...entries.map(([, value]) => value as string | number | null)).changes
}

function update(
  db: Database,
  table: string,
  set: Fields,
  where: string,
  args: (string | number)[],
) {
  const entries = Object.entries(set).filter(([, value]) => value !== undefined)
  if (!entries.length) return 0
  return db
    .query(
      `UPDATE ${table} SET ${entries.map(([key]) => `${snake(key)}=?`).join(",")} WHERE ${where}`,
    )
    .run(...entries.map(([, value]) => value as string | number | null), ...args).changes
}

function camelRow<T>(row: Record<string, unknown> | null | undefined): T | undefined {
  if (!row) return undefined
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value])) as T
}

const select = <T>(db: Database, sql: string, args: (string | number)[]): T[] =>
  db
    .query<Record<string, unknown>, (string | number)[]>(sql)
    .all(...args)
    .map((row) => camelRow<T>(row)!)

export type DecisionStatus = "decided" | "none" | "unavailable"
export interface DecisionRow {
  id: string
  projectKey: string
  sessionId: string
  messageId: string
  createdAt: number
  askText: string
  askChars: number
  strategy?: string | null
  decider?: string | null
  deciderModel?: string | null
  status: DecisionStatus
  reason?: string | null
  size?: string | null
  scoresJson?: string | null
  selectedJson?: string | null
  threshold?: number | null
  constantsJson?: string | null
  modelMs?: number | null
  elapsedMs?: number | null
  calls?: number | null
  openPlanningIdsJson?: string | null
  deliveredText?: string | null
  lateJson?: string | null
  /** The Architect's own pick, `{source:"architect", size, agents}`, for comparison with D1 on the same ask. */
  architectJson?: string | null
}
export interface DecisionNodeRow {
  decisionId: string
  nodeId: string
  parentId?: string | null
  depth: number
  spanStart?: number | null
  spanEnd?: number | null
  kind?: string | null
  /** `[{questions:string[], probabilities:Record<q,Record<choice,number>>, elapsedMs, inputTokens}]` */
  callsJson?: string | null
  outcome?: string | null
  inputTokens?: number | null
  elapsedMs?: number | null
}
export interface PlanningRow {
  id: string
  projectKey: string
  projectDirectory: string
  sessionId: string
  decisionId?: string | null
  title: string
  state: PlanningState
  revision: number
  createdAt: number
  updatedAt: number
  taskedPlanId?: string | null
}
export interface RevisionRow {
  planningId: string
  revision: number
  body: string
  validation: string
  fieldHashes: string
  authorSession?: string | null
  createdAt: number
}
export type ReviewStage = "review" | "final"
export interface ReviewRow {
  id: string
  planningId: string
  revision: number
  stage: ReviewStage
  selectionJson: string
  createdAt: number
  settledAt?: number | null
  returnedAt?: number | null
  notifiedAt?: number | null
}
export interface RunRow {
  id: string
  reviewId: string
  agent: string
  attempt: number
  sessionId?: string | null
  state: PlanningRunState
  promptMessageId?: string | null
  startedAt: number
  lastActivityAt?: number | null
  maxGapMs?: number | null
  endedAt?: number | null
  reason?: string | null
  rawReply?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  modelJson?: string | null
  mapHash?: string | null
  mapTokens?: number | null
  durationMs?: number | null
}
export type FindingResolution = "open" | "revised" | "contested" | "to-owner" | "answered"
export interface FindingRow {
  id: string
  planningId: string
  reviewId: string
  runId: string
  source: string
  agentFindingId?: string | null
  revision: number
  draftId?: string | null
  unit?: string | null
  field?: string | null
  severity?: string | null
  confidence?: string | null
  body: string
  resolution?: FindingResolution
  resolutionJson?: string | null
  resolvedRevision?: number | null
}
export type QuestionRoute = "open" | "conversation" | "owner" | "merged" | "owner-answered"
export interface QuestionRow {
  id: string
  planningId: string
  reviewId: string
  source: string
  agentQuestionId?: string | null
  revision: number
  findingId?: string | null
  weight?: string | null
  body: string
  route?: QuestionRoute
  mergedInto?: string | null
  answer?: string | null
  citationJson?: string | null
  answeredAt?: number | null
}
export interface TaskedRow {
  planningId: string
  draftId: string
  revision: number
  taskId?: string | null
  reference?: string | null
  planId?: string | null
  selfReviewId?: string | null
  changedFieldsJson?: string | null
}

/** Rows stay as stored (JSON columns are strings); typed readers belong to the callers' modules. */
export class PlanningStore {
  constructor(private readonly repository: Storage) {}

  /**
   * Idempotent on `(session_id, message_id)`: prompt hooks are retry-safe, not exactly-once, so
   * the first row wins and its nodes are kept. Returns whether this call wrote.
   */
  recordDecision(row: DecisionRow, nodes: readonly DecisionNodeRow[] = []): boolean {
    return this.repository.atomic((db) => {
      if (insert(db, "planning_decisions", row, "OR IGNORE") === 0) return false
      for (const node of nodes) insert(db, "planning_decision_nodes", node)
      return true
    })
  }

  /** Late results (a decider answering after the delivery wait) merge into `late_json`. */
  updateDecision(id: string, patch: Partial<Omit<DecisionRow, "id">>): void {
    this.repository.atomic((db) => update(db, "planning_decisions", patch as Fields, "id=?", [id]))
  }

  decision(sessionID: string, messageID: string): DecisionRow | undefined {
    return this.repository.read((db) =>
      camelRow<DecisionRow>(
        db
          .query<Record<string, unknown>, [string, string]>(
            "SELECT * FROM planning_decisions WHERE session_id=? AND message_id=?",
          )
          .get(sessionID, messageID),
      ),
    )
  }

  /** The Architect's own classification of the ask, recorded beside the decision model's. */
  setArchitectPick(decisionID: string, pick: { size?: string; agents?: readonly string[] }): void {
    this.repository.atomic((db) =>
      update(
        db,
        "planning_decisions",
        { architectJson: JSON.stringify({ source: "architect", ...pick }) },
        "id=?",
        [decisionID],
      ),
    )
  }

  /** Pieces of a decision recorded after its row (a late result). */
  addDecisionNodes(nodes: readonly DecisionNodeRow[]): void {
    this.repository.atomic((db) => {
      for (const node of nodes) insert(db, "planning_decision_nodes", node, "OR IGNORE")
    })
  }

  /** The session's decisions, oldest first. */
  sessionDecisions(sessionID: string): DecisionRow[] {
    return this.repository.read((db) =>
      select<DecisionRow>(
        db,
        "SELECT * FROM planning_decisions WHERE session_id=? ORDER BY created_at, id",
        [sessionID],
      ),
    )
  }

  decisionByID(id: string): DecisionRow | undefined {
    return this.repository.read((db) =>
      camelRow<DecisionRow>(
        db
          .query<Record<string, unknown>, [string]>("SELECT * FROM planning_decisions WHERE id=?")
          .get(id),
      ),
    )
  }

  decisionNodes(decisionID: string): DecisionNodeRow[] {
    return this.repository.read((db) =>
      select<DecisionNodeRow>(
        db,
        "SELECT * FROM planning_decision_nodes WHERE decision_id=? ORDER BY depth, node_id",
        [decisionID],
      ),
    )
  }

  /** A new plan starts at revision 0 in `drafted`; its first revision is `appendRevision`. */
  createPlanning(row: Omit<PlanningRow, "state" | "revision"> & Partial<PlanningRow>): void {
    this.repository.atomic((db) => {
      insert(db, "planning_plannings", { state: "drafted", revision: 0, ...row })
    })
  }

  planning(id: string): PlanningRow | undefined {
    return this.repository.read((db) =>
      camelRow<PlanningRow>(
        db
          .query<Record<string, unknown>, [string]>("SELECT * FROM planning_plannings WHERE id=?")
          .get(id),
      ),
    )
  }

  /** Plans of a session, newest first; `open` leaves out tasked and abandoned ones. */
  plannings(sessionID: string, open = false): PlanningRow[] {
    return this.repository.read((db) =>
      select<PlanningRow>(
        db,
        `SELECT * FROM planning_plannings WHERE session_id=?${
          open ? " AND state NOT IN ('tasked','abandoned')" : ""
        } ORDER BY created_at DESC, id`,
        [sessionID],
      ),
    )
  }

  /**
   * Append-only. `expectedRevision` is the revision the author edited from: when another revision
   * landed since, nothing is written and the current revision comes back as `conflict`.
   * `undefined` appends to whatever is current.
   */
  appendRevision(
    planningID: string,
    expectedRevision: number | undefined,
    body: unknown,
    validation: unknown,
    hashes: unknown,
    authorSession?: string,
    now = Date.now(),
  ): { revision: number } | { conflict: number } {
    return this.repository.atomic((db) => {
      const row = db
        .query<{ revision: number }, [string]>("SELECT revision FROM planning_plannings WHERE id=?")
        .get(planningID)
      if (!row) throw new Error(`Unknown planning ${planningID}`)
      if (expectedRevision !== undefined && expectedRevision !== row.revision)
        return { conflict: row.revision }
      const revision = row.revision + 1
      insert(db, "planning_revisions", {
        planningId: planningID,
        revision,
        body: JSON.stringify(body),
        validation: JSON.stringify(validation),
        fieldHashes: JSON.stringify(hashes),
        authorSession,
        createdAt: now,
      })
      update(db, "planning_plannings", { revision, updatedAt: now }, "id=?", [planningID])
      return { revision }
    })
  }

  revision(planningID: string, revision: number): RevisionRow | undefined {
    return this.repository.read((db) =>
      camelRow<RevisionRow>(
        db
          .query<Record<string, unknown>, [string, number]>(
            "SELECT * FROM planning_revisions WHERE planning_id=? AND revision=?",
          )
          .get(planningID, revision),
      ),
    )
  }

  revisions(planningID: string): RevisionRow[] {
    return this.repository.read((db) =>
      select<RevisionRow>(
        db,
        "SELECT * FROM planning_revisions WHERE planning_id=? ORDER BY revision",
        [planningID],
      ),
    )
  }

  /** The XState function inside SQL refuses an invalid transition; the row stays unchanged. */
  move(planningID: string, to: PlanningState, now = Date.now()): PlanningState {
    return this.repository.atomic((db) => {
      registerLifecycleTransitions(db)
      const row = db
        .query<{ state: string }, [string, number, string]>(
          "UPDATE planning_plannings SET state=lz_runner_transition('planning',state,?),updated_at=? WHERE id=? RETURNING state",
        )
        .get(to, now, planningID)
      if (!row) throw new Error(`Unknown planning ${planningID}`)
      return row.state as PlanningState
    })
  }

  setTaskedPlan(planningID: string, planID: string): void {
    this.repository.atomic((db) =>
      update(db, "planning_plannings", { taskedPlanId: planID }, "id=?", [planningID]),
    )
  }

  createReview(row: ReviewRow): void {
    this.repository.atomic((db) => insert(db, "planning_reviews", row))
  }

  review(id: string): ReviewRow | undefined {
    return this.repository.read((db) =>
      camelRow<ReviewRow>(
        db
          .query<Record<string, unknown>, [string]>("SELECT * FROM planning_reviews WHERE id=?")
          .get(id),
      ),
    )
  }

  reviews(planningID: string): ReviewRow[] {
    return this.repository.read((db) =>
      select<ReviewRow>(
        db,
        "SELECT * FROM planning_reviews WHERE planning_id=? ORDER BY created_at, id",
        [planningID],
      ),
    )
  }

  /** Reviews whose runs may still be open, for the scheduler participant. */
  unsettledReviews(): ReviewRow[] {
    return this.repository.read((db) =>
      select<ReviewRow>(
        db,
        "SELECT * FROM planning_reviews WHERE settled_at IS NULL ORDER BY created_at, id",
        [],
      ),
    )
  }

  updateReview(
    id: string,
    patch: Partial<Pick<ReviewRow, "settledAt" | "returnedAt" | "notifiedAt">>,
  ) {
    return this.repository.atomic((db) =>
      update(db, "planning_reviews", patch as Fields, "id=?", [id]),
    )
  }

  createRun(row: RunRow): void {
    this.repository.atomic((db) => {
      registerLifecycleTransitions(db)
      insert(db, "planning_runs", row)
    })
  }

  run(id: string): RunRow | undefined {
    return this.repository.read((db) =>
      camelRow<RunRow>(
        db
          .query<Record<string, unknown>, [string]>("SELECT * FROM planning_runs WHERE id=?")
          .get(id),
      ),
    )
  }

  runs(reviewID: string): RunRow[] {
    return this.repository.read((db) =>
      select<RunRow>(
        db,
        "SELECT * FROM planning_runs WHERE review_id=? ORDER BY started_at, attempt, id",
        [reviewID],
      ),
    )
  }

  /** Progress facts that do not change state (activity time, session id, token counts). */
  patchRun(id: string, patch: Partial<Omit<RunRow, "id" | "state">>): number {
    return this.repository.atomic((db) =>
      update(db, "planning_runs", patch as Fields, "id=?", [id]),
    )
  }

  /** Compare-and-set on `from`: a stale caller changes 0 rows. */
  moveRun(
    runID: string,
    from: PlanningRunState,
    to: PlanningRunState,
    patch: Partial<Omit<RunRow, "id" | "state">> = {},
  ): number {
    return this.repository.atomic((db) => {
      registerLifecycleTransitions(db)
      const entries = Object.entries(patch as Fields).filter(([, value]) => value !== undefined)
      return db
        .query(
          `UPDATE planning_runs SET state=lz_runner_transition('planningRun',state,?)${entries
            .map(([key]) => `,${snake(key)}=?`)
            .join("")} WHERE id=? AND state=?`,
        )
        .run(to, ...entries.map(([, value]) => value as string | number | null), runID, from)
        .changes
    })
  }

  addFinding(row: FindingRow): void {
    this.repository.atomic((db) => insert(db, "planning_findings", row))
  }

  findings(planningID: string): FindingRow[] {
    return this.repository.read((db) =>
      select<FindingRow>(db, "SELECT * FROM planning_findings WHERE planning_id=? ORDER BY rowid", [
        planningID,
      ]),
    )
  }

  updateFinding(
    id: string,
    patch: Partial<Pick<FindingRow, "resolution" | "resolutionJson" | "resolvedRevision">>,
  ) {
    return this.repository.atomic((db) =>
      update(db, "planning_findings", patch as Fields, "id=?", [id]),
    )
  }

  addQuestion(row: QuestionRow): void {
    this.repository.atomic((db) => insert(db, "planning_questions", row))
  }

  questions(planningID: string): QuestionRow[] {
    return this.repository.read((db) =>
      select<QuestionRow>(
        db,
        "SELECT * FROM planning_questions WHERE planning_id=? ORDER BY rowid",
        [planningID],
      ),
    )
  }

  updateQuestion(
    id: string,
    patch: Partial<
      Pick<QuestionRow, "route" | "mergedInto" | "answer" | "citationJson" | "answeredAt">
    >,
  ) {
    return this.repository.atomic((db) =>
      update(db, "planning_questions", patch as Fields, "id=?", [id]),
    )
  }

  recordTasked(row: TaskedRow): void {
    this.repository.atomic((db) => insert(db, "planning_tasked", row, "OR REPLACE"))
  }

  tasked(planningID: string): TaskedRow[] {
    return this.repository.read((db) =>
      select<TaskedRow>(db, "SELECT * FROM planning_tasked WHERE planning_id=? ORDER BY rowid", [
        planningID,
      ]),
    )
  }
}
