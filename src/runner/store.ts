import { ensureTransitionIndexes } from "./transition-indexes.ts"
import {
  type PlanLifecycleState,
  type AttemptLifecycleState,
  type EffectLifecycleState,
  registerLifecycleTransitions,
} from "./lifecycle-machines.ts"
import { dispatchControlTransition } from "./dispatch-control-machine.ts"
import {
  architectContactTransition,
  type ArchitectContactState,
} from "./architect-contact-machine.ts"
import { progressRecencySQL } from "../progress/recency.ts"
import { ensureObservationRevision } from "../observability/source-revision.ts"
import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import {
  retireHumanEvidenceGate,
  retireOutboxLifecycle,
  retireSourceQuarantines,
  retireRetainedVerificationGates,
  retireStaleHolds,
} from "./retire-gates.ts"
import { installPrioritySchema, planPrioritySortSQL, prioritySortSQL } from "./priority.ts"
import { installChangeIdentity, knownTree, sameArtifact } from "./identity-store.ts"
import { architectSourceTransition, type ArchitectSourceState } from "./architect-source-machine.ts"
import { canonical, fingerprint } from "../identity.ts"
import { sessionAssociations } from "../observability/associations.ts"
import type { TaskRepository } from "../storage.ts"
import { outerPause, outerPauseIn, outerPauseReason } from "../projects/pause.ts"
import { TaskProposalSchema } from "../task.ts"
import { RecoveryJournal } from "../recovery/journal.ts"
import { git, scopePatternsConflict } from "./artifacts.ts"
import { reservationPatterns, type ScopeModel } from "./scope.ts"
import { initialSnapshot, machineVersion, transition } from "./machine.ts"
import { MAX_EXECUTION_PLAN_WAIT_REFERENCES, PlanInput, PlanSubmissionInput } from "./schema.ts"
import type { DispatchPause, Execution, Finding, TaskState } from "./schema.ts"
import type { ArchitectSourceResult, ArchitectSourceObservation } from "./host.ts"
import { readSourceJournalPage } from "./source-journal.ts"
import type { SourceJournalPage } from "./source-journal.ts"
import {
  invalidVerificationTimings,
  verificationTimeoutDefaults,
  VerificationTimeoutAmendmentSchema,
} from "./verification-timeout.ts"
import type {
  VerificationTimeoutAmendment,
  VerificationTimeoutDefaults,
} from "./verification-timeout.ts"
import type {
  PrerequisiteIntegrationRow,
  TaskPrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"

/** Why a renewal deferred: a session under its successor ID is not the one it created. */
export const RENEWAL_SUCCESSOR_FOREIGN =
  "Native Architect renewal ID belongs to another session or route"

export type PlanRow = {
  id: string
  owner: string
  revision: number
  version: number
  state: PlanLifecycleState
  body: string
  model: string | null
  reason: string | null
  artifact: string | null
}
export type NodeRow = {
  plan_id: string
  task_id: string
  ordinal: number
  state: TaskState
  version: number
  reason: string | null
  artifact: string | null
  snapshot: string
  machine_version: string
}
export type AttemptRow = {
  id: string
  plan_id: string
  task_id: string
  number: number
  session_id: string
  message_id: string
  workspace: string
  base_commit: string
  artifact: string | null
  policy: string
  state: AttemptLifecycleState
  started_at: number
  token_count: number | null
  tool_count: number
  retry_count: number
  cost: number | null
}
export type EffectRow = {
  id: string
  plan_id: string
  task_id: string | null
  attempt_id: string | null
  kind: string
  state: EffectLifecycleState
  payload: string
  receipt: string | null
  fence: number
}
export type AdoptionRow = {
  id: string
  plan_id: string
  task_id: string
  request_id: string
  owner: string
  plan_version: number
  task_revision: number
  attempt_id: string
  node_state: string
  attempt_state: string
  old_artifact: string
  descendant_commit: string
  target_branch: string
  landing_head: string
  reviewed_baseline: string
  candidate_tree: string
  input_fingerprint: string
  environment_identity: string
  reason: string
  combined_artifact: string
  task_workspace: string | null
  combined_workspace: string | null
  state: string
  hold_reason: string | null
  created_at: number
  updated_at: number
}
export type AdoptionCheckRow = {
  adoption_id: string
  phase: "task" | "combined"
  check_id: string
  check_json: string
  workspace: string
  artifact: string
  input_fingerprint: string
  environment_identity: string
  receipt_path: string
  state: string
  receipt: string | null
  created_at: number
}
export type ContinuationRow = {
  plan_id: string
  session_id: string
  parent_id: string | null
  directory: string
  model: string | null
  generation: number
}
export type ArchitectRenewalRow = {
  id: string
  anchor_plan_id: string
  previous_session_id: string
  successor_session_id: string
  directory: string
  model: string
  idle_at: number
  generation: number
  state: string
  handoff_message_id: string
  handoff_outbox_id: string | null
  input_message_id: string | null
  error: string | null
  continuity_json: string | null
  started_at: number
}
type ArchitectContinuityRow = {
  project_directory: string
  session_id: string
  revision: number
  decisions: string
  unresolved_questions: string
  updated_at: number
}
type ArchitectRenewalPlanRow = {
  renewal_id: string
  plan_id: string
  prior_continuation: string | null
}
type ArchitectSourceResultRow = {
  session_id: string
  renewal_id: string
  message_id: string
  state: ArchitectSourceResult["state"]
  finish: ArchitectSourceResult["finish"]
  tool_running: number
  tool_completed: number
  tool_failed: number
  tool_other: number
  result_fingerprint: string
  result_revision: number
  referenced_revision: number
  updated_at: number
}
type ArchitectSourceRow = {
  session_id: string
  renewal_id: string
  anchor_plan_id: string
  scan_cursor: string | null
  scan_sweep: number
  revision: number
  state: ArchitectSourceState
  updated_at: number
  scan_complete_at: number | null
  observation_json: string | null
}
export type ArchitectObservedInput = {
  id: string
  type: string
  delivery?: string
  metadata?: Record<string, unknown>
}
export type ArchitectObservedMessage = {
  id: string
  type: string
  metadata?: Record<string, unknown>
  result?: ArchitectSourceResult
}
export type OutboxRow = {
  id: string
  plan_id: string
  session_id: string
  message_id: string
  payload: string
  state: string
  resume: number
  metadata: string | null
  receipt: string | null
  receipt_count: number
  receipt_last_kind: string | null
  version: number
  sequence: number
}

/**
 * Top-level path buckets for a write scope. Two scopes can only conflict when they
 * share a bucket; a pattern whose literal prefix has no complete first segment
 * (root or leading wildcard) makes the scope "wild" and it is compared with all.
 */
function scopeBuckets(scope: readonly string[]): Set<string> | "wild" {
  const buckets = new Set<string>()
  for (const pattern of scope) {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
    const wildcard = normalized.search(/[*?{}[\]!]/)
    const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard)
    const slash = prefix.indexOf("/")
    if (slash <= 0) return "wild"
    buckets.add(prefix.slice(0, slash))
  }
  return buckets
}

function architectSourceJournalExists(db: Database, sessionID: string) {
  return Boolean(
    db
      .query<{ present: number }, [string, string]>(
        `SELECT 1 AS present
         WHERE EXISTS(SELECT 1 FROM runner_architect_inputs WHERE session_id=?)
            OR EXISTS(SELECT 1 FROM runner_architect_source_results WHERE session_id=?)`,
      )
      .get(sessionID, sessionID),
  )
}

export type ProgressRow = {
  seq: number
  project_directory: string
  project_id: string
  plan_id: string
  task_id: string
  attempt_id: string
  session_id: string
  at: number
  recorded_at?: number | null
  source: string
  sources_json: string
  kind: string
  event_ids_json: string
  call_id: string | null
  message_id: string | null
  dedupe_key: string
  payload: string
}

export type SchedulingPlanFact = PlanRow & {
  sequence: number
  priority: number
  node_count: number
  last_attempt_policy: string | null
  pause_reason: string | null
  pause_until_plans: string | null
}

export type SchedulingNodeFact = NodeRow & {
  sequence: number
  priority: number
  task_body: string
  reference: string | null
  scope_payload: string | null
}

export type SchedulingReservationFact = AttemptRow & {
  task_body: string
  scope_payload: string | null
}

export type SchedulingFactSnapshot = {
  projectDirectory: string
  repositoryVersion: number
  sessionAssociations?: SchedulingSessionAssociations
  plans: SchedulingPlanFact[]
  totalPlanCount: number
  plansComplete: boolean
  totalNodeCount: number
  nodes: SchedulingNodeFact[]
  nodesComplete: boolean
  coveredPlanNodeCount: number
  dependencies: Array<{ plan_id: string; prerequisite: string; successor: string }>
  reservations: SchedulingReservationFact[]
  totalReservationCount: number
  reservationsComplete: boolean
  adoptions: AdoptionRow[]
  totalAdoptionCount: number
  adoptionsComplete: boolean
  taskIntegrations: TaskPrerequisiteIntegrationRow[]
  planIntegrations: PrerequisiteIntegrationRow[]
  planIntegrationsComplete: boolean
}

export type SchedulingSessionAssociations = {
  taskIDs: string[]
  planIDs: string[]
  planCount: number
  nodeCount: number
  activeReservationCount: number
}

function schedulingSessionAssociations(
  db: Database,
  projectDirectory: string,
  sessionID: string,
): SchedulingSessionAssociations {
  const associations = sessionAssociations(db, projectDirectory, sessionID)
  const planBodies = new Map<string, string>()
  const pending = [...associations.planIDs]
  if (associations.planIDs.size > 1_000)
    throw new Error("Observation scope is too large; narrow it")

  const planBody = db.query<{ body: string }, [string, string]>(
    "SELECT body FROM runner_plans WHERE project_directory=? AND id=?",
  )
  while (pending.length) {
    const planID = pending.pop()!
    const body = planBodies.get(planID) ?? planBody.get(projectDirectory, planID)?.body
    if (body === undefined) continue
    planBodies.set(planID, body)
    let afterPlans: string[] = []
    try {
      const parsed = PlanInput.safeParse(JSON.parse(body))
      if (parsed.success) afterPlans = parsed.data.afterPlans ?? []
    } catch {
      // Malformed plan input has no readable afterPlans relationships.
    }
    for (const dependency of afterPlans) {
      if (associations.planIDs.has(dependency)) continue
      const related = planBody.get(projectDirectory, dependency)
      if (!related) continue
      associations.planIDs.add(dependency)
      planBodies.set(dependency, related.body)
      pending.push(dependency)
      if (associations.planIDs.size > 1_000)
        throw new Error("Observation scope is too large; narrow it")
    }
  }

  const planIDs = [...associations.planIDs].toSorted()
  for (let offset = 0; offset < planIDs.length; offset += 100) {
    const batch = planIDs.slice(offset, offset + 100)
    for (const row of db
      .query<{ task_id: string }, string[]>(
        `SELECT task_id FROM runner_nodes WHERE plan_id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(...batch))
      associations.taskIDs.add(row.task_id)
  }

  const countForPlans = (
    table: "runner_nodes" | "runner_attempts" | "runner_adoptions",
    filter = "",
  ) => {
    let count = 0
    for (let offset = 0; offset < planIDs.length; offset += 100) {
      const batch = planIDs.slice(offset, offset + 100)
      count += db
        .query<{ count: number }, string[]>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE plan_id IN (${batch.map(() => "?").join(",")}) ${filter}`,
        )
        .get(...batch)!.count
    }
    return count
  }

  const activeReservationCount =
    countForPlans("runner_attempts", "AND state IN ('preparing','running','verifying')") +
    countForPlans("runner_adoptions", "AND state IN ('pending','task-checks','combined-checks')")
  return {
    taskIDs: [...associations.taskIDs].toSorted(),
    planIDs,
    planCount: planIDs.length,
    nodeCount: countForPlans("runner_nodes"),
    activeReservationCount,
  }
}

/** The kind tag of a receipt entry, kept beside the body so SQL can filter on it. */
function receiptKind(entry: unknown): string | null {
  return typeof entry === "object" &&
    entry !== null &&
    "kind" in entry &&
    typeof entry.kind === "string"
    ? entry.kind
    : null
}

/**
 * Append one receipt entry to an outbox row: one child row plus the parent's count and last kind.
 * Never reads or rewrites earlier entries, so cost does not grow with history.
 */
export function addOutboxReceipt(db: Database, outboxID: string, entry: unknown) {
  const kind = receiptKind(entry)
  db.query(
    `INSERT INTO runner_outbox_receipts(outbox_id,seq,kind,body)
     SELECT id,receipt_count,?,? FROM runner_outbox WHERE id=?`,
  ).run(kind, JSON.stringify(entry), outboxID)
  db.query(
    "UPDATE runner_outbox SET receipt_count=receipt_count+1,receipt_last_kind=? WHERE id=?",
  ).run(kind, outboxID)
}

/**
 * Receipts used to be one growing `{history:[...]}` document on the row. Move each entry to a child
 * row, keeping its meaning (order, content, a non-history document as the single first entry).
 */
function migrateOutboxReceipts(db: Database) {
  const legacy = db
    .query<{ id: string; receipt: string }, []>(
      "SELECT id,receipt FROM runner_outbox WHERE receipt IS NOT NULL AND receipt_count=0",
    )
    .all()
  for (const row of legacy) {
    let entries: unknown[]
    try {
      const parsed: unknown = JSON.parse(row.receipt)
      entries =
        typeof parsed === "object" &&
        parsed !== null &&
        "history" in parsed &&
        Array.isArray(parsed.history)
          ? parsed.history
          : [parsed]
    } catch {
      entries = [{ legacyReceipt: row.receipt }]
    }
    entries.forEach((entry, seq) =>
      db
        .query("INSERT INTO runner_outbox_receipts(outbox_id,seq,kind,body) VALUES(?,?,?,?)")
        .run(row.id, seq, receiptKind(entry), JSON.stringify(entry)),
    )
    db.query(
      "UPDATE runner_outbox SET receipt=NULL,receipt_count=?,receipt_last_kind=? WHERE id=?",
    ).run(entries.length, receiptKind(entries.at(-1)), row.id)
  }
}

/** Preserve the first effect receipt while adding durable, append-only recovery evidence. */
export function appendRunnerEffectReceipt(previous: string | null, next: unknown) {
  let prior: Record<string, unknown> | undefined
  if (previous) {
    try {
      const parsed: unknown = JSON.parse(previous)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        prior = parsed as Record<string, unknown>
    } catch {
      // Preserve legacy, non-JSON receipts as an opaque history entry.
    }
  }
  const history = Array.isArray(prior?.history)
    ? [...prior.history]
    : prior
      ? [prior]
      : previous
        ? [{ legacyReceipt: previous }]
        : []
  return JSON.stringify({
    ...(prior ?? {}),
    history: [...history, next],
  })
}

function isGeneratedOutcome(
  db: Database,
  sessionID: string,
  messageID: string,
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata || metadata.lazersKind !== "runner-outcome") return false
  const row = db
    .query<{ metadata: string | null }, [string, string]>(
      "SELECT metadata FROM runner_outbox WHERE session_id=? AND message_id=?",
    )
    .get(sessionID, messageID)
  if (!row?.metadata) return false
  try {
    return fingerprint(JSON.parse(row.metadata) as unknown) === fingerprint(metadata)
  } catch {
    return false
  }
}

function ensureArchitectSourceJournalRevisions(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS runner_architect_journal_revisions (
    project_directory TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY(project_directory,plan_id)
  )`)

  const mappedRenewalPlans = (renewalID: string, anchorPlanID: string) =>
    `SELECT mapped.project_directory,mapped.id AS plan_id
     FROM runner_architect_renewals renewal
     JOIN runner_architect_renewal_plans mapping ON mapping.renewal_id=renewal.id
     JOIN runner_plans mapped ON mapped.id=mapping.plan_id
     JOIN runner_plans anchor ON anchor.id=${anchorPlanID}
     WHERE renewal.id=${renewalID} AND mapped.project_directory=anchor.project_directory`

  const mappedSourceSession = (sessionID: string) =>
    `SELECT mapped.project_directory,mapped.id AS plan_id
     FROM runner_architect_sources source
     JOIN runner_architect_renewals renewal ON renewal.id=source.renewal_id
     JOIN runner_architect_renewal_plans mapping ON mapping.renewal_id=renewal.id
     JOIN runner_plans mapped ON mapped.id=mapping.plan_id
     JOIN runner_plans anchor ON anchor.id=source.anchor_plan_id
     WHERE source.session_id=${sessionID} AND renewal.anchor_plan_id=source.anchor_plan_id
       AND renewal.previous_session_id=source.session_id
       AND mapped.project_directory=anchor.project_directory`

  const planLookup = (table: string, row: string) => {
    switch (table) {
      case "runner_architect_renewals":
        return mappedRenewalPlans(`${row}.id`, `${row}.anchor_plan_id`)
      case "runner_architect_renewal_plans":
        return `SELECT mapped.project_directory,mapped.id AS plan_id
          FROM runner_plans mapped
          JOIN runner_architect_renewals renewal ON renewal.id=${row}.renewal_id
          JOIN runner_plans anchor ON anchor.id=renewal.anchor_plan_id
          WHERE mapped.id=${row}.plan_id AND mapped.project_directory=anchor.project_directory`
      case "runner_architect_sources":
        return mappedRenewalPlans(`${row}.renewal_id`, `${row}.anchor_plan_id`)
      case "runner_architect_source_results":
        return mappedRenewalPlans(
          `${row}.renewal_id`,
          `(SELECT anchor_plan_id FROM runner_architect_renewals WHERE id=${row}.renewal_id)`,
        )
      case "runner_architect_inputs":
        return `${mappedRenewalPlans(
          `${row}.renewal_id`,
          `(SELECT anchor_plan_id FROM runner_architect_renewals WHERE id=${row}.renewal_id)`,
        )}
        UNION
        ${mappedSourceSession(`${row}.session_id`)}`
      default:
        throw new Error(`Unsupported Architect journal table: ${table}`)
    }
  }

  const tables = [
    "runner_architect_renewals",
    "runner_architect_renewal_plans",
    "runner_architect_sources",
    "runner_architect_inputs",
    "runner_architect_source_results",
  ] as const
  const meaningfulUpdates: Record<(typeof tables)[number], readonly string[]> = {
    runner_architect_renewals: [
      "id",
      "anchor_plan_id",
      "previous_session_id",
      "successor_session_id",
      "state",
      "started_at",
    ],
    runner_architect_renewal_plans: ["renewal_id", "plan_id"],
    runner_architect_sources: ["session_id", "renewal_id", "anchor_plan_id", "revision", "state"],
    runner_architect_inputs: [
      "session_id",
      "message_id",
      "renewal_id",
      "native_type",
      "delivery",
      "disposition",
      "referenced_revision",
    ],
    runner_architect_source_results: [
      "session_id",
      "renewal_id",
      "message_id",
      "state",
      "finish",
      "tool_running",
      "tool_completed",
      "tool_failed",
      "tool_other",
      "result_fingerprint",
      "result_revision",
      "referenced_revision",
    ],
  }
  for (const table of tables) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const changed =
        event === "UPDATE"
          ? `WHEN ${meaningfulUpdates[table]
              .map((column) => `OLD."${column}" IS NOT NEW."${column}"`)
              .join(" OR ")}`
          : ""
      const rows = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"]
      const plans = rows.map((row) => planLookup(table, row)).join(" UNION ")
      const name = `architect_journal_revision_${table}_${event}`
      const definition = `CREATE TRIGGER ${name}
        AFTER ${event} ON ${table} ${changed} BEGIN
          INSERT INTO runner_architect_journal_revisions(project_directory,plan_id,revision)
          SELECT project_directory,plan_id,1 FROM (${plans})
          WHERE project_directory IS NOT NULL AND plan_id IS NOT NULL
          GROUP BY project_directory,plan_id
          ON CONFLICT(project_directory,plan_id) DO UPDATE SET revision=revision+1;
        END`
      db.exec(`DROP TRIGGER IF EXISTS observation_revision_${table}_${event}`)
      const current = db
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
        )
        .get(name)?.sql
      const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
      if (current && normalize(current) === normalize(definition)) continue
      if (current) db.exec(`DROP TRIGGER ${name}`)
      db.exec(definition)
    }
  }
  // Journal cursors now observe only the selected plan's retained-source mappings.
}

function migrateConflictScanHistory(db: Database) {
  // F-S4-1: preserve historical conflict scans under their actual domain name.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_audits'").get()) {
    if (
      db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_conflict_scans'")
        .get()
    )
      db.exec(`INSERT OR IGNORE INTO runner_conflict_scans SELECT * FROM runner_audits;
                   DROP TABLE runner_audits`)
    else db.exec("ALTER TABLE runner_audits RENAME TO runner_conflict_scans")
  }
}

const DETAIL_PAGE_LIMIT = 200
export type DetailPage = {
  limit?: number
  activityBefore?: number
  evidenceBefore?: number
  deliveryBefore?: number
}

export class RunnerStore {
  /** Settles once the plan-scoped transition indexes exist (or the background build gave up). */
  readonly transitionIndexes: Promise<void>

  /**
   * A store for reads only. Its constructor would register lifecycle transitions and build indexes
   * in a write transaction; this skips that, so it needs a repository whose `atomic` is a read
   * (`ReadOnlyTaskRepository`) and a database another store has already prepared.
   */
  static readOnly(repository: TaskRepository): RunnerStore {
    const store = Object.create(RunnerStore.prototype) as RunnerStore
    Object.defineProperty(store, "repository", { value: repository, enumerable: true })
    Object.defineProperty(store, "transitionIndexes", {
      value: Promise.resolve(),
      enumerable: true,
    })
    return store
  }

  constructor(readonly repository: TaskRepository) {
    repository.atomic(registerLifecycleTransitions)
    repository.installSchema(
      "runner",
      schemaModules.runner.generation,
      schemaModules.runner.tables,
      (db) => {
        migrateConflictScanHistory(db)
        db.exec(`
      CREATE TABLE IF NOT EXISTS runner_plans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_dispatch_controls (
        plan_id TEXT PRIMARY KEY REFERENCES runner_plans(id), state TEXT NOT NULL,
        reason TEXT NOT NULL, until_plans TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_architect_contact (
        project_directory TEXT PRIMARY KEY, state TEXT NOT NULL,
        reason TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_plans_project ON runner_plans(project_directory, state);
      CREATE TABLE IF NOT EXISTS runner_plan_revisions (
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), revision INTEGER NOT NULL,
        body TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(plan_id,revision)
      );
      CREATE TABLE IF NOT EXISTS runner_nodes (
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        spec_revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL,
        version INTEGER NOT NULL, reason TEXT, artifact TEXT, snapshot TEXT NOT NULL, machine_version TEXT NOT NULL,
        PRIMARY KEY(plan_id,task_id), UNIQUE(task_id,spec_revision)
      );
      CREATE TABLE IF NOT EXISTS runner_dependencies (
        plan_id TEXT NOT NULL, prerequisite TEXT NOT NULL, successor TEXT NOT NULL,
        PRIMARY KEY(plan_id, prerequisite, successor),
        FOREIGN KEY(plan_id,prerequisite) REFERENCES runner_nodes(plan_id,task_id),
        FOREIGN KEY(plan_id,successor) REFERENCES runner_nodes(plan_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_relations (
        project_directory TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), other_task_id TEXT NOT NULL REFERENCES tasks(id),
        relation TEXT NOT NULL, rationale TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,task_id,other_task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_commands (
        project_directory TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL, PRIMARY KEY(project_directory,request_id)
      );
      CREATE TABLE IF NOT EXISTS runner_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT,
        version INTEGER NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_transitions_lookup
        ON runner_transitions(plan_id,task_id,event,id);
      CREATE TABLE IF NOT EXISTS runner_leases (
        project_directory TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_attempts (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, project_directory TEXT, task_id TEXT NOT NULL, number INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, base_commit TEXT NOT NULL,
        artifact TEXT, policy TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL,
        token_count INTEGER, tool_count INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, cost REAL,
        UNIQUE(task_id,number), FOREIGN KEY(plan_id,task_id) REFERENCES runner_nodes(plan_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_effects (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT, attempt_id TEXT REFERENCES runner_attempts(id),
        kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, fence INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_effects_plan ON runner_effects(plan_id);
      CREATE INDEX IF NOT EXISTS runner_attempts_plan ON runner_attempts(plan_id);
      CREATE TABLE IF NOT EXISTS runner_adoptions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id),
        task_id TEXT NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
        plan_version INTEGER NOT NULL, task_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
        node_state TEXT NOT NULL, attempt_state TEXT NOT NULL,
        old_artifact TEXT NOT NULL, descendant_commit TEXT NOT NULL, target_branch TEXT NOT NULL,
        landing_head TEXT NOT NULL, reviewed_baseline TEXT NOT NULL DEFAULT '',
        candidate_tree TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
        environment_identity TEXT NOT NULL,
        reason TEXT NOT NULL, combined_artifact TEXT NOT NULL, task_workspace TEXT,
        combined_workspace TEXT, state TEXT NOT NULL, hold_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_adoptions_active
        ON runner_adoptions(plan_id,state,created_at);
      CREATE TABLE IF NOT EXISTS runner_takeovers (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES runner_plans(id),
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES runner_attempts(id),
        architect_session_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_takeovers_open ON runner_takeovers(plan_id,state);
      CREATE TABLE IF NOT EXISTS runner_adoption_checks (
        adoption_id TEXT NOT NULL REFERENCES runner_adoptions(id), phase TEXT NOT NULL,
        check_id TEXT NOT NULL, check_json TEXT NOT NULL, workspace TEXT NOT NULL,
        artifact TEXT NOT NULL, input_fingerprint TEXT NOT NULL, environment_identity TEXT NOT NULL,
        receipt_path TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(adoption_id,phase,check_id)
      );
      CREATE TABLE IF NOT EXISTS runner_adoption_evidence (
        id TEXT PRIMARY KEY, adoption_id TEXT NOT NULL REFERENCES runner_adoptions(id), task_id TEXT,
        phase TEXT NOT NULL DEFAULT 'legacy', assertion_id TEXT NOT NULL,
        artifact TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_adoption_evidence_lookup
        ON runner_adoption_evidence(adoption_id,assertion_id,artifact);
      CREATE TABLE IF NOT EXISTS runner_evidence (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT, attempt_id TEXT REFERENCES runner_attempts(id),
        assertion_id TEXT, kind TEXT NOT NULL, artifact TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_outbox (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), session_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL, resume INTEGER NOT NULL,
        metadata TEXT, receipt TEXT,
        receipt_count INTEGER NOT NULL DEFAULT 0, receipt_last_kind TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_outbox_receipts (
        outbox_id TEXT NOT NULL REFERENCES runner_outbox(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, kind TEXT, body TEXT NOT NULL,
        PRIMARY KEY(outbox_id,seq)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS runner_outbox_receipts_kind ON runner_outbox_receipts(kind,outbox_id);
      CREATE TABLE IF NOT EXISTS runner_continuations (
        plan_id TEXT PRIMARY KEY REFERENCES runner_plans(id), session_id TEXT NOT NULL,
        parent_id TEXT, directory TEXT NOT NULL, model TEXT, generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_architect_renewals (
        id TEXT PRIMARY KEY, anchor_plan_id TEXT NOT NULL REFERENCES runner_plans(id),
        previous_session_id TEXT NOT NULL, successor_session_id TEXT NOT NULL,
        directory TEXT NOT NULL, model TEXT NOT NULL, idle_at INTEGER NOT NULL,
        generation INTEGER NOT NULL, state TEXT NOT NULL, handoff_message_id TEXT NOT NULL,
        handoff_outbox_id TEXT, input_message_id TEXT, error TEXT, continuity_json TEXT,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_architect_renewals_source
        ON runner_architect_renewals(previous_session_id,started_at);
      CREATE TABLE IF NOT EXISTS runner_architect_renewal_plans (
        renewal_id TEXT NOT NULL REFERENCES runner_architect_renewals(id),
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), prior_continuation TEXT,
        transferred INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(renewal_id,plan_id)
      );
      CREATE INDEX IF NOT EXISTS runner_architect_renewal_plans_plan
        ON runner_architect_renewal_plans(plan_id,renewal_id);
      CREATE TABLE IF NOT EXISTS runner_architect_inputs (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
        renewal_id TEXT REFERENCES runner_architect_renewals(id), PRIMARY KEY(session_id,message_id)
      );
      CREATE INDEX IF NOT EXISTS runner_architect_inputs_recent
        ON runner_architect_inputs(session_id,observed_at);
      CREATE TABLE IF NOT EXISTS runner_architect_sources (
        session_id TEXT PRIMARY KEY, renewal_id TEXT NOT NULL REFERENCES runner_architect_renewals(id),
        anchor_plan_id TEXT NOT NULL REFERENCES runner_plans(id), scan_cursor TEXT,
        scan_sweep INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, updated_at INTEGER NOT NULL,
        scan_complete_at INTEGER, observation_json TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_architect_continuity (
        project_directory TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
        decisions TEXT NOT NULL, unresolved_questions TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,session_id)
      );
      CREATE TABLE IF NOT EXISTS runner_architect_continuity_inputs (
        project_directory TEXT NOT NULL, session_id TEXT NOT NULL, continuity_revision INTEGER NOT NULL,
        message_id TEXT NOT NULL, PRIMARY KEY(project_directory,session_id,continuity_revision,message_id)
      );
      CREATE TABLE IF NOT EXISTS runner_architect_continuity_coverage (
        project_directory TEXT NOT NULL, session_id TEXT NOT NULL, continuity_revision INTEGER NOT NULL,
        input_count INTEGER NOT NULL, input_fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,session_id,continuity_revision)
      );
      CREATE TABLE IF NOT EXISTS runner_architect_renewal_coverage (
        renewal_id TEXT NOT NULL REFERENCES runner_architect_renewals(id),
        session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(renewal_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS runner_architect_source_results (
        session_id TEXT NOT NULL, renewal_id TEXT NOT NULL REFERENCES runner_architect_renewals(id),
        message_id TEXT NOT NULL, state TEXT NOT NULL, finish TEXT,
        tool_running INTEGER NOT NULL, tool_completed INTEGER NOT NULL,
        tool_failed INTEGER NOT NULL, tool_other INTEGER NOT NULL,
        result_fingerprint TEXT NOT NULL, result_revision INTEGER NOT NULL,
        referenced_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id,message_id)
      );
      CREATE INDEX IF NOT EXISTS runner_architect_source_results_pending
        ON runner_architect_source_results(session_id,referenced_revision,updated_at);
      CREATE TABLE IF NOT EXISTS runner_conflict_scans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, watermark INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_progress (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_directory TEXT NOT NULL, project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        session_id TEXT NOT NULL, at INTEGER NOT NULL, recorded_at INTEGER,
        source TEXT NOT NULL,
        sources_json TEXT NOT NULL, kind TEXT NOT NULL, event_ids_json TEXT NOT NULL,
        call_id TEXT, message_id TEXT, dedupe_key TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(project_directory,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS runner_progress_plan_seq ON runner_progress(plan_id,seq);
      CREATE INDEX IF NOT EXISTS runner_progress_attempt_seq
        ON runner_progress(project_directory,attempt_id,seq);
      CREATE TABLE IF NOT EXISTS native_tool_calls (
        project_directory TEXT NOT NULL, project_id TEXT NOT NULL,
        session_id TEXT NOT NULL, identity_kind TEXT NOT NULL
          CHECK(identity_kind IN ('native-call','local-invocation')),
        invocation_id TEXT NOT NULL, native_call_id TEXT, parent_call_id TEXT,
        context_call_id TEXT NOT NULL, local_invocation_id TEXT,
        message_id TEXT, agent TEXT, tool TEXT,
        plan_id TEXT, task_id TEXT, attempt_id TEXT,
        first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
        sources_json TEXT NOT NULL, event_ids_json TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(project_directory,session_id,identity_kind,invocation_id)
      );
      CREATE INDEX IF NOT EXISTS native_tool_calls_session
        ON native_tool_calls(project_directory,session_id,first_observed_at);
      CREATE INDEX IF NOT EXISTS native_tool_calls_parent
        ON native_tool_calls(project_directory,session_id,parent_call_id);
      CREATE TABLE IF NOT EXISTS runner_progress_reconciled (
        project_directory TEXT NOT NULL, attempt_id TEXT NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, light TEXT NOT NULL, full TEXT,
        PRIMARY KEY(project_directory,attempt_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS runner_progress_reminders (
        attempt_id TEXT PRIMARY KEY REFERENCES runner_attempts(id),
        session_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, ownership_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL
      );
    `)
        const toolCallColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(native_tool_calls)")
            .all()
            .map((column) => column.name),
        )
        // The initially observed ledger did not retain these identities. Keep
        // historical values unknown; migration is not a new native observation.
        if (!toolCallColumns.has("context_call_id"))
          db.exec("ALTER TABLE native_tool_calls ADD COLUMN context_call_id TEXT")
        if (!toolCallColumns.has("local_invocation_id"))
          db.exec("ALTER TABLE native_tool_calls ADD COLUMN local_invocation_id TEXT")
        db.exec(`CREATE INDEX IF NOT EXISTS native_tool_calls_local
        ON native_tool_calls(project_directory,session_id,local_invocation_id)`)
        const progressColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_progress)")
            .all()
            .map((column) => column.name),
        )
        // Legacy recording times remain unknown; never backfill them from native
        // event time or the time this additive migration happens to run.
        if (!progressColumns.has("recorded_at"))
          db.exec("ALTER TABLE runner_progress ADD COLUMN recorded_at INTEGER")
        if (!progressColumns.has("latest_observed_at")) {
          db.exec("ALTER TABLE runner_progress ADD COLUMN latest_observed_at REAL")
          db.exec(
            `UPDATE runner_progress SET latest_observed_at=${progressRecencySQL("runner_progress")}`,
          )
        }
        db.exec(`
          CREATE INDEX IF NOT EXISTS runner_progress_plan_recency
            ON runner_progress(plan_id,latest_observed_at DESC,seq DESC);
          CREATE TRIGGER IF NOT EXISTS runner_progress_recency_inserted
          AFTER INSERT ON runner_progress BEGIN
            UPDATE runner_progress SET latest_observed_at=${progressRecencySQL("NEW")} WHERE seq=NEW.seq;
          END;
          CREATE TRIGGER IF NOT EXISTS runner_progress_recency_updated
          AFTER UPDATE OF at,payload ON runner_progress BEGIN
            UPDATE runner_progress SET latest_observed_at=${progressRecencySQL("NEW")} WHERE seq=NEW.seq;
          END;
        `)
        const attemptColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_attempts)")
            .all()
            .map((column) => column.name),
        )
        if (!attemptColumns.has("project_directory")) {
          db.exec("ALTER TABLE runner_attempts ADD COLUMN project_directory TEXT")
          // Only the legacy schema needs a full retained-attempt backfill. Keep
          // this scan inside the one-time additive migration, not normal reopen.
          db.exec(`
          UPDATE runner_attempts
             SET project_directory=(SELECT project_directory FROM runner_plans WHERE id=runner_attempts.plan_id)
           WHERE project_directory IS NOT
                 (SELECT project_directory FROM runner_plans WHERE id=runner_attempts.plan_id)
        `)
        }
        db.exec(`
        CREATE INDEX IF NOT EXISTS runner_attempts_active_project
          ON runner_attempts(project_directory,started_at DESC,id DESC)
          WHERE state IN ('preparing','running','verifying');
        CREATE TRIGGER IF NOT EXISTS runner_attempts_project_directory_insert
          AFTER INSERT ON runner_attempts
          WHEN NEW.project_directory IS NOT
               (SELECT project_directory FROM runner_plans WHERE id=NEW.plan_id)
          BEGIN
            UPDATE runner_attempts
               SET project_directory=(SELECT project_directory FROM runner_plans WHERE id=NEW.plan_id)
             WHERE id=NEW.id;
          END;
        CREATE TRIGGER IF NOT EXISTS runner_attempts_project_directory_plan_update
          AFTER UPDATE OF plan_id ON runner_attempts
          WHEN NEW.project_directory IS NOT
               (SELECT project_directory FROM runner_plans WHERE id=NEW.plan_id)
          BEGIN
            UPDATE runner_attempts
               SET project_directory=(SELECT project_directory FROM runner_plans WHERE id=NEW.plan_id)
             WHERE id=NEW.id;
          END;
        CREATE TRIGGER IF NOT EXISTS runner_plans_project_directory_update
          AFTER UPDATE OF project_directory ON runner_plans
          WHEN OLD.project_directory IS NOT NEW.project_directory
          BEGIN
            UPDATE runner_attempts SET project_directory=NEW.project_directory WHERE plan_id=NEW.id;
          END;
      `)
        const reminderColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_progress_reminders)")
            .all()
            .map((column) => column.name),
        )
        if (!reminderColumns.has("message_id"))
          db.exec("ALTER TABLE runner_progress_reminders ADD COLUMN message_id TEXT")
        if (!reminderColumns.has("ownership_json"))
          db.exec("ALTER TABLE runner_progress_reminders ADD COLUMN ownership_json TEXT")
        if (!reminderColumns.has("updated_at"))
          db.exec(
            "ALTER TABLE runner_progress_reminders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
          )
        if (!reminderColumns.has("attempts"))
          db.exec(
            "ALTER TABLE runner_progress_reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1",
          )
        const adoptionColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_adoptions)")
            .all()
            .map((column) => column.name),
        )
        if (!adoptionColumns.has("reviewed_baseline"))
          db.exec(
            "ALTER TABLE runner_adoptions ADD COLUMN reviewed_baseline TEXT NOT NULL DEFAULT ''",
          )
        const adoptionEvidenceColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_adoption_evidence)")
            .all()
            .map((column) => column.name),
        )
        if (!adoptionEvidenceColumns.has("task_id"))
          db.exec("ALTER TABLE runner_adoption_evidence ADD COLUMN task_id TEXT")
        if (!adoptionEvidenceColumns.has("phase"))
          db.exec(
            "ALTER TABLE runner_adoption_evidence ADD COLUMN phase TEXT NOT NULL DEFAULT 'legacy'",
          )
        db.exec(
          `CREATE INDEX IF NOT EXISTS runner_adoption_evidence_phase_lookup
         ON runner_adoption_evidence(adoption_id,phase,task_id,assertion_id,artifact)`,
        )
        // One native Architect successor may own multiple plans. Older databases
        // made the session ID unique, accidentally forcing one successor per plan.
        const continuationIndexes = db
          .query<{ name: string; unique: number }, []>("PRAGMA index_list(runner_continuations)")
          .all()
        const uniqueSessionIndex = continuationIndexes.find((index) => {
          if (!index.unique) return false
          const columns = db
            .query<{ name: string }, []>(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`)
            .all()
          return columns.some((column) => column.name === "session_id")
        })
        if (uniqueSessionIndex) {
          db.exec(`
          ALTER TABLE runner_continuations RENAME TO runner_continuations_legacy;
          CREATE TABLE runner_continuations (
            plan_id TEXT PRIMARY KEY REFERENCES runner_plans(id), session_id TEXT NOT NULL,
            parent_id TEXT, directory TEXT NOT NULL, model TEXT, generation INTEGER NOT NULL
          );
          INSERT INTO runner_continuations SELECT * FROM runner_continuations_legacy;
          DROP TABLE runner_continuations_legacy;
        `)
        }
        db.query(
          `UPDATE runner_progress_reminders SET status='unknown'
         WHERE message_id IS NULL OR ownership_json IS NULL`,
        ).run()
        const columns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_outbox)")
            .all()
            .map((column) => column.name),
        )
        if (!columns.has("metadata")) db.exec("ALTER TABLE runner_outbox ADD COLUMN metadata TEXT")
        if (!columns.has("receipt")) db.exec("ALTER TABLE runner_outbox ADD COLUMN receipt TEXT")
        if (!columns.has("receipt_count"))
          db.exec("ALTER TABLE runner_outbox ADD COLUMN receipt_count INTEGER NOT NULL DEFAULT 0")
        if (!columns.has("receipt_last_kind"))
          db.exec("ALTER TABLE runner_outbox ADD COLUMN receipt_last_kind TEXT")
        migrateOutboxReceipts(db)
        const renewalColumns = db
          .query<{ name: string }, []>("PRAGMA table_info(runner_architect_renewals)")
          .all()
          .map((column) => column.name)
        if (!renewalColumns.includes("continuity_json"))
          db.exec("ALTER TABLE runner_architect_renewals ADD COLUMN continuity_json TEXT")
        const sourceColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_architect_sources)")
            .all()
            .map((row) => row.name),
        )
        if (!sourceColumns.has("scan_complete_at"))
          db.exec("ALTER TABLE runner_architect_sources ADD COLUMN scan_complete_at INTEGER")
        if (!sourceColumns.has("observation_json"))
          db.exec("ALTER TABLE runner_architect_sources ADD COLUMN observation_json TEXT")
        const architectInputColumns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(runner_architect_inputs)")
            .all()
            .map((column) => column.name),
        )
        if (!architectInputColumns.has("native_type"))
          db.exec("ALTER TABLE runner_architect_inputs ADD COLUMN native_type TEXT")
        if (!architectInputColumns.has("delivery"))
          db.exec("ALTER TABLE runner_architect_inputs ADD COLUMN delivery TEXT")
        if (!architectInputColumns.has("disposition"))
          db.exec(
            "ALTER TABLE runner_architect_inputs ADD COLUMN disposition TEXT NOT NULL DEFAULT 'unknown'",
          )
        if (!architectInputColumns.has("metadata_json"))
          db.exec("ALTER TABLE runner_architect_inputs ADD COLUMN metadata_json TEXT")
        if (!architectInputColumns.has("last_seen_sweep"))
          db.exec(
            "ALTER TABLE runner_architect_inputs ADD COLUMN last_seen_sweep INTEGER NOT NULL DEFAULT 0",
          )
        if (!architectInputColumns.has("referenced_revision"))
          db.exec(
            "ALTER TABLE runner_architect_inputs ADD COLUMN referenced_revision INTEGER NOT NULL DEFAULT 0",
          )
        if (!architectInputColumns.has("updated_at"))
          db.exec(
            "ALTER TABLE runner_architect_inputs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
          )
        retireOutboxLifecycle(db)
        installChangeIdentity(db)
        ensureObservationRevision(db)
        ensureArchitectSourceJournalRevisions(db)
        // Generation 6: the human-evidence gate is retired; move its blocked plans on.
        retireHumanEvidenceGate(db)
        retireSourceQuarantines(db)
        retireStaleHolds(db)
        // Generation 12: retained verification is one call; its generations and bindings are gone.
        retireRetainedVerificationGates(db)
      },
    )
    installPrioritySchema(repository)
    // Not generation-gated: existing databases lack these and large tables build off-thread.
    this.transitionIndexes = repository.atomic((db) => ensureTransitionIndexes(db, repository.path))
    // An older still-loaded plugin can recreate its table after the generation was installed.
    if (
      repository.read((db) =>
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_audits'").get(),
      )
    )
      repository.atomic(migrateConflictScanHistory)
    new RecoveryJournal(repository)
  }
  atomic<T>(run: (db: Database) => T): T {
    return this.repository.atomic((db) => {
      registerLifecycleTransitions(db)
      return run(db)
    })
  }
  /** Pure reads: deferred snapshot, never waits on writers. */
  read<T>(run: (db: Database) => T): T {
    return this.repository.read((db) => {
      registerLifecycleTransitions(db)
      return run(db)
    })
  }
  plan(id: string) {
    return this.read((db) =>
      db
        .query<PlanRow, [string, string]>(
          "SELECT * FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(id, this.repository.projectDirectory),
    )
  }
  nodes(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<NodeRow, [string]>("SELECT * FROM runner_nodes WHERE plan_id=? ORDER BY ordinal")
        .all(planID),
    )
  }
  /** Project-wide Architect contact; enabled unless a user paused it. */
  architectContact(): { state: ArchitectContactState; reason: string; updatedAt: number | null } {
    return this.read((db) => {
      const row = db
        .query<{ state: string; reason: string; updated_at: number }, [string]>(
          "SELECT state,reason,updated_at FROM runner_architect_contact WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      return row
        ? {
            state: row.state === "paused" ? "paused" : "enabled",
            reason: row.reason,
            updatedAt: row.updated_at,
          }
        : { state: "enabled", reason: "", updatedAt: null }
    })
  }
  architectContactPaused(): boolean {
    return this.architectContact().state === "paused"
  }
  /** Moves the contact setting through its XState machine; an invalid change throws. */
  setArchitectContact(state: ArchitectContactState, reason: string) {
    return this.atomic((db) => {
      const current = this.architectContact()
      const next = architectContactTransition(
        current.state,
        state === "paused" ? "PAUSE" : "UNPAUSE",
      )
      db.query(
        `INSERT INTO runner_architect_contact VALUES(?,?,?,?)
         ON CONFLICT(project_directory) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at`,
      ).run(this.repository.projectDirectory, next, reason, Date.now())
      this.repository.changed()
      return this.architectContact()
    })
  }
  dispatchPause(planID: string) {
    return this.read((db) => {
      const row = db
        .query<{ reason: string; until_plans: string }, [string]>(
          "SELECT reason,until_plans FROM runner_dispatch_controls WHERE plan_id=? AND state='paused'",
        )
        .get(planID)
      return row
        ? { reason: row.reason, untilPlans: JSON.parse(row.until_plans) as string[] }
        : undefined
    })
  }
  /**
   * The pause that holds a plan from new dispatch: a project or global pause when one applies
   * (strictest first), else the plan's own. A project or global pause has no resume condition;
   * it is lifted by hand. Running work is never affected; only callers that start work ask this.
   */
  effectiveDispatchPause(planID: string): DispatchPause | undefined {
    const outer = outerPause(this.repository, this.repository.projectDirectory)
    if (outer) return { reason: outerPauseReason(outer), untilPlans: [], level: outer.level }
    return this.dispatchPause(planID)
  }
  setDispatchPause(
    planID: string,
    pause: { reason: string; untilPlans: string[] } | null,
    details: object,
  ) {
    return this.atomic((db) => {
      const current = this.dispatchPause(planID)
      if (!pause && !current) return
      const state = dispatchControlTransition(
        current ? "paused" : "enabled",
        pause ? "PAUSE" : "UNPAUSE",
      )
      db.query(
        `INSERT INTO runner_dispatch_controls VALUES(?,?,?,?,?)
        ON CONFLICT(plan_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,
          until_plans=excluded.until_plans,updated_at=excluded.updated_at`,
      ).run(planID, state, pause?.reason ?? "", JSON.stringify(pause?.untilPlans ?? []), Date.now())
      db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(planID)
      this.record(planID, null, pause ? "DISPATCH_PAUSED" : "DISPATCH_UNPAUSED", {
        ...details,
        pause,
      })
    })
  }
  plans() {
    return this.read((db) =>
      db
        .query<PlanRow, [string]>(
          `SELECT * FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid LIMIT 1000`,
        )
        .all(this.repository.projectDirectory),
    )
  }
  /**
   * Ids and states of the project's plans in the given states, in display order. A tick that only
   * filters by state reads this instead of materializing every plan body; load one body with plan().
   */
  planHeads(states: readonly string[]): { id: string; state: PlanLifecycleState }[] {
    if (!states.length) return []
    return this.read((db) =>
      db
        .query<{ id: string; state: PlanLifecycleState }, string[]>(
          `SELECT id,state FROM runner_plans WHERE project_directory=? AND state IN (${states.map(() => "?").join(",")})
           ORDER BY ${planPrioritySortSQL("body")},rowid LIMIT 1000`,
        )
        .all(this.repository.projectDirectory, ...states),
    )
  }
  /** The first plan id in display order, without its body. */
  anchorPlanID(): string | null {
    return (
      this.read((db) =>
        db
          .query<{ id: string }, [string]>(
            `SELECT id FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid LIMIT 1`,
          )
          .get(this.repository.projectDirectory),
      )?.id ?? null
    )
  }
  /** Page execution candidates after filtering history; never use the display window for scheduling. */
  *runnablePlans(terminalStates: ReadonlySet<string>): Generator<PlanRow & { queue_rank: number }> {
    type Candidate = PlanRow & { queue_rank: number; priority: number; sequence: number }
    const states = [...terminalStates]
    const queueRank = `CASE
      WHEN state IN ('cancelling','cleaning') THEN 2
      WHEN state='blocked' OR EXISTS (
        SELECT 1 FROM runner_nodes n WHERE n.plan_id=runner_plans.id AND n.state='verifying'
      ) OR (state='running' AND EXISTS (
        SELECT 1 FROM runner_nodes n WHERE n.plan_id=runner_plans.id AND n.state='accepted'
      ) AND NOT EXISTS (
        SELECT 1 FROM runner_nodes n WHERE n.plan_id=runner_plans.id AND n.state<>'accepted'
      )) THEN 1 ELSE 0 END`
    let cursor: Candidate | undefined
    for (;;) {
      const page: Candidate[] = this.read((db) =>
        db
          .query<Candidate, (string | number)[]>(
            `SELECT *,${queueRank} AS queue_rank,
           ${planPrioritySortSQL("body")} AS priority,rowid AS sequence
           FROM runner_plans WHERE project_directory=?
           ${states.length ? `AND state NOT IN (${states.map(() => "?").join(",")})` : ""}
           ${cursor ? `AND (${queueRank}<? OR (${queueRank}=? AND (${planPrioritySortSQL("body")}>? OR (${planPrioritySortSQL("body")}=? AND rowid>?))))` : ""}
           ORDER BY queue_rank DESC,priority ASC,rowid LIMIT 1000`,
          )
          .all(
            this.repository.projectDirectory,
            ...states,
            ...(cursor
              ? [
                  cursor.queue_rank,
                  cursor.queue_rank,
                  cursor.priority,
                  cursor.priority,
                  cursor.sequence,
                ]
              : []),
          ),
      )
      yield* page
      if (page.length < 1000) return
      cursor = page.at(-1)!
    }
  }
  /** A transitive dependent with execution history prevents rewriting its prerequisite. */
  startedDependentPlan(planID: string): PlanRow | null {
    return this.read((db) =>
      db
        .query<PlanRow, [string, string, string, string]>(
          `WITH RECURSIVE dependents(id) AS (
         SELECT id FROM runner_plans WHERE id=? AND project_directory=?
         UNION
         SELECT p.id FROM runner_plans p,json_each(p.body,'$.afterPlans') edge
         JOIN dependents d ON d.id=edge.value WHERE p.project_directory=?
       )
       SELECT p.* FROM runner_plans p JOIN dependents d ON d.id=p.id
       WHERE p.id<>? AND EXISTS (SELECT 1 FROM runner_attempts a WHERE a.plan_id=p.id)
       LIMIT 1`,
        )
        .get(planID, this.repository.projectDirectory, this.repository.projectDirectory, planID),
    )
  }
  closeoutReviewPlanIDs(): string[] {
    return this.read((db) =>
      db
        .query<{ id: string }, [string]>(
          `SELECT p.id FROM runner_plans p
           WHERE p.project_directory=? AND p.artifact IS NOT NULL
           AND (p.state='accepted' OR (p.state='cleanup-blocked' AND EXISTS (
             SELECT 1 FROM runner_outbox prior WHERE prior.plan_id=p.id
             AND json_extract(prior.payload,'$.status')='cleanup-blocked'
           )))
           AND NOT EXISTS (
             SELECT 1 FROM runner_outbox o WHERE o.plan_id=p.id
             AND json_extract(o.payload,'$.status')=p.state
             AND json_extract(o.payload,'$.version')=p.version
             AND (o.state IN ('pending','delivered')
               OR json_extract(o.payload,'$.closeoutReminder')=1)
           )
           ORDER BY p.state='cleanup-blocked' DESC,${planPrioritySortSQL("p.body")},p.rowid`,
        )
        .all(this.repository.projectDirectory)
        .map(({ id }) => id),
    )
  }
  terminalCleanupPlanIDs(): string[] {
    return this.read((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_plans WHERE project_directory=? AND state IN ('cleanup-blocked','cancelled') ORDER BY rowid",
        )
        .all(this.repository.projectDirectory)
        .map(({ id }) => id),
    )
  }
  continuation(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
        .get(planID),
    )
  }
  architectRenewal(id: string) {
    return this.read((db) =>
      db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE r.id=? AND anchor.project_directory=?`,
        )
        .get(id, this.repository.projectDirectory),
    )
  }
  architectContinuity(sessionID: string) {
    return this.read((db) =>
      db
        .query<ArchitectContinuityRow, [string, string]>(
          "SELECT * FROM runner_architect_continuity WHERE project_directory=? AND session_id=?",
        )
        .get(this.repository.projectDirectory, sessionID),
    )
  }
  architectContinuityCoverage(sessionID: string, revision?: number) {
    const checkpoint = this.architectContinuity(sessionID)
    if (!checkpoint || (revision !== undefined && checkpoint.revision !== revision)) return []
    return this.read((db) =>
      db
        .query<{ message_id: string }, [string, string, number]>(
          `SELECT message_id FROM runner_architect_continuity_inputs
           WHERE project_directory=? AND session_id=? AND continuity_revision=?
           ORDER BY message_id`,
        )
        .all(this.repository.projectDirectory, sessionID, checkpoint.revision)
        .map((row) => row.message_id),
    )
  }
  architectRenewalCoverageEvidence(id: string) {
    const renewal = this.architectRenewal(id)
    if (!renewal?.continuity_json) return null
    const parsed = JSON.parse(renewal.continuity_json) as { revision?: unknown }
    if (typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision)) return null
    return this.read((db) => {
      const inputIDs = db
        .query<{ message_id: string }, [string, string]>(
          `SELECT message_id FROM runner_architect_renewal_coverage
           WHERE renewal_id=? AND session_id=? ORDER BY message_id`,
        )
        .all(id, renewal.previous_session_id)
        .map((row) => row.message_id)
      return {
        revision: parsed.revision as number,
        inputCount: inputIDs.length,
        inputFingerprint: fingerprint(inputIDs),
      }
    })
  }
  saveArchitectContinuity(input: {
    sessionID: string
    decisions: string[]
    unresolvedQuestions: string[]
    coverageInputs: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>
    now: number
  }) {
    return this.atomic((db) => {
      const plan = db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM runner_plans WHERE project_directory=? AND owner=?
           ORDER BY rowid LIMIT 1`,
        )
        .get(this.repository.projectDirectory, input.sessionID)
      if (!plan) throw new Error("Architect continuity requires a currently owned LAZERS plan")
      const previous = db
        .query<{ revision: number }, [string, string]>(
          "SELECT revision FROM runner_architect_continuity WHERE project_directory=? AND session_id=?",
        )
        .get(this.repository.projectDirectory, input.sessionID)
      const revision = (previous?.revision ?? 0) + 1
      const coverageIDs = new Set(
        input.coverageInputs
          .filter((item) => item.type === "user")
          .filter((item) => !isGeneratedOutcome(db, input.sessionID, item.id, item.metadata))
          .map((item) => item.id),
      )
      for (const row of db
        .query<{ message_id: string }, [string]>(
          `SELECT message_id FROM runner_architect_inputs
           WHERE session_id=? AND disposition='prompt'`,
        )
        .all(input.sessionID))
        coverageIDs.add(row.message_id)
      db.query(
        `INSERT INTO runner_architect_continuity(
          project_directory,session_id,revision,decisions,unresolved_questions,updated_at
        ) VALUES(?,?,?,?,?,?) ON CONFLICT(project_directory,session_id) DO UPDATE SET
          revision=excluded.revision,decisions=excluded.decisions,
          unresolved_questions=excluded.unresolved_questions,updated_at=excluded.updated_at`,
      ).run(
        this.repository.projectDirectory,
        input.sessionID,
        revision,
        JSON.stringify(input.decisions),
        JSON.stringify(input.unresolvedQuestions),
        input.now,
      )
      db.query(
        "DELETE FROM runner_architect_continuity_inputs WHERE project_directory=? AND session_id=?",
      ).run(this.repository.projectDirectory, input.sessionID)
      db.query(
        "DELETE FROM runner_architect_continuity_coverage WHERE project_directory=? AND session_id=?",
      ).run(this.repository.projectDirectory, input.sessionID)
      for (const messageID of coverageIDs)
        db.query(
          `INSERT INTO runner_architect_continuity_inputs(
            project_directory,session_id,continuity_revision,message_id
          ) VALUES(?,?,?,?)`,
        ).run(this.repository.projectDirectory, input.sessionID, revision, messageID)
      db.query(
        `INSERT INTO runner_architect_continuity_coverage(
          project_directory,session_id,continuity_revision,input_count,input_fingerprint,updated_at
        ) VALUES(?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        input.sessionID,
        revision,
        coverageIDs.size,
        fingerprint([...coverageIDs].toSorted()),
        input.now,
      )
      this.record(plan.id, null, "ARCHITECT_CONTINUITY_RECORDED", {
        sessionID: input.sessionID,
        revision,
        decisionCount: input.decisions.length,
        unresolvedQuestionCount: input.unresolvedQuestions.length,
        inputCoverageCount: coverageIDs.size,
        inputCoverageFingerprint: fingerprint([...coverageIDs].toSorted()),
      })
      this.repository.changed()
      return this.architectContinuity(input.sessionID)!
    })
  }
  architectRenewalForPlan(planID: string) {
    return this.read((db) =>
      db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_architect_renewal_plans p ON p.renewal_id=r.id
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE p.plan_id=? AND anchor.project_directory=?
           ORDER BY r.started_at DESC,r.generation DESC LIMIT 1`,
        )
        .get(planID, this.repository.projectDirectory),
    )
  }
  architectRenewalForSource(sessionID: string) {
    return this.read((db) =>
      db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE r.previous_session_id=? AND anchor.project_directory=?
           ORDER BY r.started_at DESC,r.generation DESC LIMIT 1`,
        )
        .get(sessionID, this.repository.projectDirectory),
    )
  }
  architectRenewalsNeedingRecovery() {
    return this.read((db) =>
      db
        .query<ArchitectRenewalRow, [string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE anchor.project_directory=?
             AND r.state IN ('creating','archiving','recovering-input','rolling-back')
           ORDER BY r.started_at,r.generation,r.id`,
        )
        .all(this.repository.projectDirectory),
    )
  }
  architectRenewalPlans(id: string) {
    return this.read((db) =>
      db
        .query<ArchitectRenewalPlanRow, [string, string]>(
          `SELECT rp.* FROM runner_architect_renewal_plans rp
           JOIN runner_architect_renewals r ON r.id=rp.renewal_id
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE rp.renewal_id=? AND anchor.project_directory=? ORDER BY rp.plan_id`,
        )
        .all(id, this.repository.projectDirectory),
    )
  }
  architectSources() {
    return this.read((db) =>
      db
        .query<ArchitectSourceRow, [string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_architect_renewals r ON r.id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE anchor.project_directory=? AND s.state='active'
             AND r.state IN ('archiving','committed')
           ORDER BY s.updated_at,s.session_id`,
        )
        .all(this.repository.projectDirectory),
    )
  }
  architectSourceSessionIDs(): string[] {
    return this.repository.read((db) =>
      db
        .query<{ session_id: string }, [string]>(
          `SELECT s.session_id FROM runner_architect_sources s JOIN runner_plans p ON p.id=s.anchor_plan_id
       WHERE p.project_directory=?`,
        )
        .all(this.repository.projectDirectory)
        .map((row) => row.session_id),
    )
  }
  invalidateArchitectSource(sessionID: string, now: number) {
    const needsInvalidation = (source: ArchitectSourceRow | null) =>
      source &&
      source.state !== "preparing" &&
      (source.state !== "active" ||
        source.scan_complete_at !== null ||
        source.observation_json !== null)
    if (!needsInvalidation(this.architectSource(sessionID))) return
    return this.atomic((db) => {
      const source = this.architectSource(sessionID)
      if (!source || !needsInvalidation(source)) return
      const state = architectSourceTransition(source.state, "ACTIVATE")
      db.query(
        `UPDATE runner_architect_sources SET state=?,scan_complete_at=NULL,observation_json=NULL,updated_at=?
        WHERE session_id=?`,
      ).run(state, now, sessionID)
    })
  }
  retireArchitectSource(sessionID: string, schedulerOwner: string, fence: number, now: number) {
    return this.fenced(schedulerOwner, fence, (db) => {
      const source = this.architectSource(sessionID)
      if (
        !source ||
        source.state !== "active" ||
        source.scan_cursor !== null ||
        source.scan_complete_at === null ||
        this.architectRenewal(source.renewal_id)?.state !== "committed"
      )
        return false
      db.query("UPDATE runner_architect_sources SET state=?,updated_at=? WHERE session_id=?").run(
        architectSourceTransition(source.state, "RETIRE"),
        now,
        sessionID,
      )
      return true
    })
  }
  architectSource(sessionID: string) {
    return this.repository.read((db) =>
      db
        .query<ArchitectSourceRow, [string, string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND anchor.project_directory=?`,
        )
        .get(sessionID, this.repository.projectDirectory),
    )
  }
  architectSourceInputs(sessionID: string) {
    return this.read((db) =>
      db
        .query<
          {
            message_id: string
            native_type: string | null
            delivery: string | null
            disposition: string
          },
          [string, string]
        >(
          `SELECT message_id,native_type,delivery,disposition FROM runner_architect_inputs
           WHERE session_id=? AND EXISTS(
             SELECT 1 FROM runner_architect_sources s JOIN runner_plans p ON p.id=s.anchor_plan_id
             WHERE s.session_id=runner_architect_inputs.session_id AND p.project_directory=?
           ) ORDER BY observed_at,message_id`,
        )
        .all(sessionID, this.repository.projectDirectory),
    )
  }
  architectSourceMessageReferences(planID: string, sourceSessionID: string, messageIDs: string[]) {
    return this.read((db) => {
      const source = db
        .query<{ renewal_id: string }, [string, string, string]>(
          `SELECT s.renewal_id FROM runner_architect_sources s
           JOIN runner_architect_renewal_plans rp ON rp.renewal_id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND rp.plan_id=? AND rp.transferred=1
             AND s.state IN ('active','retired') AND anchor.project_directory=?`,
        )
        .get(sourceSessionID, planID, this.repository.projectDirectory)
      if (!source) throw new Error("Source session is not an active journal for this plan")
      if (!messageIDs.length) return []
      const placeholders = messageIDs.map(() => "?").join(",")
      const params = [sourceSessionID, ...messageIDs]
      const inputs = db
        .query<{ message_id: string; native_type: string | null }, string[]>(
          `SELECT message_id,native_type FROM runner_architect_inputs
           WHERE session_id=? AND message_id IN (${placeholders})`,
        )
        .all(...params)
      const results = db
        .query<{ message_id: string }, string[]>(
          `SELECT message_id FROM runner_architect_source_results
           WHERE session_id=? AND renewal_id=? AND message_id IN (${placeholders})`,
        )
        .all(sourceSessionID, source.renewal_id, ...messageIDs)
      const references = new Map<
        string,
        { messageID: string; kind: "input" | "result"; type: string }
      >()
      for (const input of inputs)
        if (input.native_type === "user" || input.native_type === "synthetic")
          references.set(input.message_id, {
            messageID: input.message_id,
            kind: "input",
            type: input.native_type,
          })
      for (const result of results)
        references.set(result.message_id, {
          messageID: result.message_id,
          kind: "result",
          type: "assistant",
        })
      return messageIDs.flatMap((messageID) => {
        const reference = references.get(messageID)
        return reference ? [reference] : []
      })
    })
  }
  architectSourceJournalPage(planID: string, limit: number, cursor?: string): SourceJournalPage {
    return this.read((db) =>
      readSourceJournalPage(db, this.repository.projectDirectory, planID, limit, cursor),
    )
  }
  recordArchitectSourcePage(input: {
    schedulerOwner: string
    fence: number
    sessionID: string
    cursor: string | null
    nextCursor: string | null
    inbox: ArchitectObservedInput[]
    messages: ArchitectObservedMessage[]
    now: number
    projectID: string
    observation?: ArchitectSourceObservation
    unchanged?: boolean
    cacheCurrent?: boolean
  }) {
    return this.fenced(input.schedulerOwner, input.fence, (db) => {
      const source = db
        .query<ArchitectSourceRow, [string, string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND anchor.project_directory=? AND s.state IN ('active','preparing')`,
        )
        .get(input.sessionID, this.repository.projectDirectory)
      if (!source) return null
      const renewal = db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE r.id=? AND anchor.project_directory=?`,
        )
        .get(source.renewal_id, this.repository.projectDirectory)
      if (
        !renewal ||
        (!(source.state === "preparing" && renewal.state === "creating") &&
          !["archiving", "committed"].includes(renewal.state))
      )
        return null
      if (input.unchanged) {
        if (input.cacheCurrent === false)
          db.query(
            "UPDATE runner_architect_sources SET scan_complete_at=NULL,observation_json=NULL WHERE session_id=?",
          ).run(input.sessionID)
        return {
          revision: source.revision,
          hasJournal: architectSourceJournalExists(db, input.sessionID),
          changedInputs: [],
          changedResults: [],
          sourceNotices: [],
          nextCursor: null,
          sweep: source.scan_sweep,
          staleCheckpoint: false,
        }
      }
      const sweep = input.cursor === null ? source.scan_sweep + 1 : source.scan_sweep
      const inboxByID = new Map(input.inbox.map((entry) => [entry.id, entry]))
      const changes = new Map<string, { id: string; type: string; disposition: string }>()
      const changedResults = new Map<
        string,
        { id: string; revision: number; state: ArchitectSourceResult["state"] }
      >()

      // LAZERS notices are not Architect input. They never enter the source journal.
      const generatedNotification = (id: string, metadata?: Record<string, unknown>) =>
        isGeneratedOutcome(db, input.sessionID, id, metadata)
      const upsert = (
        observed: ArchitectObservedInput | ArchitectObservedMessage,
        disposition: string,
        delivery: string | null,
      ) => {
        if (generatedNotification(observed.id, observed.metadata)) return
        const old = db
          .query<
            {
              native_type: string | null
              delivery: string | null
              disposition: string
              referenced_revision: number
              metadata_json: string | null
              last_seen_sweep: number
              renewal_id: string | null
            },
            [string, string]
          >(
            `SELECT native_type,delivery,disposition,referenced_revision,metadata_json,last_seen_sweep,renewal_id FROM runner_architect_inputs
             WHERE session_id=? AND message_id=?`,
          )
          .get(input.sessionID, observed.id)
        const metadata = observed.metadata ? JSON.stringify(observed.metadata) : null
        const changed =
          !old ||
          old.native_type !== observed.type ||
          old.delivery !== delivery ||
          old.disposition !== disposition ||
          old.metadata_json !== metadata
        if (!changed) {
          if (old.last_seen_sweep !== sweep || old.renewal_id !== source.renewal_id)
            db.query(
              "UPDATE runner_architect_inputs SET last_seen_sweep=?,renewal_id=? WHERE session_id=? AND message_id=?",
            ).run(sweep, source.renewal_id, input.sessionID, observed.id)
          return
        }
        db.query(
          `INSERT INTO runner_architect_inputs(
            session_id,message_id,observed_at,renewal_id,native_type,delivery,disposition,
            metadata_json,last_seen_sweep,referenced_revision,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET
            renewal_id=excluded.renewal_id,native_type=excluded.native_type,delivery=excluded.delivery,
            disposition=excluded.disposition,metadata_json=excluded.metadata_json,
            last_seen_sweep=excluded.last_seen_sweep,
            referenced_revision=CASE WHEN ?=1 THEN 0 ELSE runner_architect_inputs.referenced_revision END,
            updated_at=excluded.updated_at`,
        ).run(
          input.sessionID,
          observed.id,
          input.now,
          source.renewal_id,
          observed.type,
          delivery,
          disposition,
          metadata,
          sweep,
          changed ? 0 : (old?.referenced_revision ?? 0),
          input.now,
          Number(changed),
        )
        if (changed) changes.set(observed.id, { id: observed.id, type: observed.type, disposition })
      }

      for (const entry of input.inbox) {
        if (entry.type !== "user" && entry.type !== "synthetic") continue
        upsert(entry, entry.delivery === "steer" ? "steering" : "pending", entry.delivery ?? null)
      }
      for (const message of input.messages) {
        if (message.type !== "user" && message.type !== "synthetic") continue
        const pending = inboxByID.get(message.id)
        upsert(
          message,
          pending ? (pending.delivery === "steer" ? "steering" : "pending") : "delivered",
          pending?.delivery ?? null,
        )
      }
      for (const message of input.messages) {
        if (message.type !== "assistant" || !message.result) continue
        const result = message.result
        const resultFingerprint = fingerprint(result)
        const old = db
          .query<
            Pick<
              ArchitectSourceResultRow,
              "result_fingerprint" | "result_revision" | "referenced_revision" | "renewal_id"
            >,
            [string, string]
          >(
            `SELECT result_fingerprint,result_revision,referenced_revision,renewal_id
             FROM runner_architect_source_results
             WHERE session_id=? AND message_id=?`,
          )
          .get(input.sessionID, message.id)
        const changed = old?.result_fingerprint !== resultFingerprint
        if (!changed) {
          if (old.renewal_id !== source.renewal_id)
            db.query(
              "UPDATE runner_architect_source_results SET renewal_id=? WHERE session_id=? AND message_id=?",
            ).run(source.renewal_id, input.sessionID, message.id)
          continue
        }
        const resultRevision = old ? old.result_revision + Number(changed) : 1
        db.query(
          `INSERT INTO runner_architect_source_results(
            session_id,renewal_id,message_id,state,finish,tool_running,tool_completed,tool_failed,
            tool_other,result_fingerprint,result_revision,referenced_revision,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET
            renewal_id=excluded.renewal_id,state=excluded.state,finish=excluded.finish,
            tool_running=excluded.tool_running,tool_completed=excluded.tool_completed,
            tool_failed=excluded.tool_failed,tool_other=excluded.tool_other,
            result_fingerprint=excluded.result_fingerprint,result_revision=excluded.result_revision,
            referenced_revision=CASE WHEN ?=1 THEN 0 ELSE runner_architect_source_results.referenced_revision END,
            updated_at=excluded.updated_at`,
        ).run(
          input.sessionID,
          source.renewal_id,
          message.id,
          result.state,
          result.finish,
          result.toolCounts.running,
          result.toolCounts.completed,
          result.toolCounts.failed,
          result.toolCounts.other,
          resultFingerprint,
          resultRevision,
          changed ? 0 : (old?.referenced_revision ?? 0),
          input.now,
          Number(changed),
        )
        if (changed) {
          changedResults.set(message.id, {
            id: message.id,
            revision: resultRevision,
            state: result.state,
          })
        }
      }

      let staleCheckpoint = false
      if (input.nextCursor === null) {
        const disappeared = db
          .query<{ message_id: string; native_type: string | null }, [string, number]>(
            `SELECT message_id,native_type FROM runner_architect_inputs
             WHERE session_id=? AND last_seen_sweep<? AND disposition IN ('pending','steering')`,
          )
          .all(input.sessionID, sweep)
        for (const row of disappeared) {
          db.query(
            `UPDATE runner_architect_inputs SET disposition='unknown',delivery=NULL,
               referenced_revision=0,updated_at=?
             WHERE session_id=? AND message_id=? AND disposition IN ('pending','steering')`,
          ).run(input.now, input.sessionID, row.message_id)
          changes.set(row.message_id, {
            id: row.message_id,
            type: row.native_type ?? "unknown",
            disposition: "unknown",
          })
        }
        if (source.state === "preparing" && renewal.state === "creating") {
          const uncovered = db
            .query<{ message_id: string }, [string, number, string]>(
              `SELECT i.message_id FROM runner_architect_inputs i
               WHERE i.session_id=? AND i.last_seen_sweep=?
                 AND i.native_type='user'
                 AND NOT EXISTS(
                   SELECT 1 FROM runner_architect_renewal_coverage c
                   WHERE c.renewal_id=? AND c.message_id=i.message_id
                 )
               ORDER BY i.message_id LIMIT 1`,
            )
            .get(input.sessionID, sweep, renewal.id)
          if (uncovered) {
            const error =
              "Architect continuity checkpoint does not cover native input observed during renewal preparation"
            db.query(
              `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),input_message_id=?,error=?
               WHERE id=? AND state='creating'`,
            ).run(uncovered.message_id, error, renewal.id)
            this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_DEFERRED", {
              renewalID: renewal.id,
              inputMessageID: uncovered.message_id,
              reason: error,
              sourceSweep: sweep,
            })
            staleCheckpoint = true
          }
        }
      }

      let revision = source.revision
      if (changes.size || changedResults.size) revision++
      db.query(
        `UPDATE runner_architect_sources SET scan_cursor=?,scan_sweep=?,revision=?,updated_at=?,scan_complete_at=?,observation_json=?
         WHERE session_id=? AND renewal_id=?`,
      ).run(
        input.nextCursor,
        sweep,
        revision,
        input.now,
        input.nextCursor === null && input.cacheCurrent !== false ? input.now : null,
        input.nextCursor === null && input.cacheCurrent !== false && input.observation
          ? JSON.stringify(input.observation)
          : null,
        input.sessionID,
        source.renewal_id,
      )

      if (changes.size || changedResults.size) this.repository.changed()
      return {
        revision,
        hasJournal: architectSourceJournalExists(db, input.sessionID),
        changedInputs: [...changes.values()],
        changedResults: [...changedResults.values()],
        sourceNotices: [],
        nextCursor: input.nextCursor,
        sweep,
        staleCheckpoint,
      }
    })
  }
  architectRenewalHasInput(id: string) {
    return this.read((db) =>
      Boolean(
        db
          .query<{ present: number }, [string, string]>(
            `SELECT 1 AS present FROM runner_architect_inputs i
             JOIN runner_architect_renewals r ON r.id=i.renewal_id
             JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
             WHERE r.id=? AND anchor.project_directory=?
               AND i.session_id=r.previous_session_id
               AND i.observed_at>=r.idle_at LIMIT 1`,
          )
          .get(id, this.repository.projectDirectory),
      ),
    )
  }
  architectRenewalBlocksDelivery(planID: string) {
    const renewal = this.architectRenewalForPlan(planID)
    return Boolean(
      renewal &&
      ["creating", "archiving", "recovering-input", "rolling-back"].includes(renewal.state),
    )
  }
  /**
   * One source row per session, kept across renewals: a later renewal of a session that already
   * has a row (an earlier renewal committed, or a retry) re-prepares it and restarts its scan.
   */
  private prepareArchitectSource(
    db: Database,
    sessionID: string,
    renewalID: string,
    anchorPlanID: string,
    now: number,
  ) {
    db.query(
      `INSERT INTO runner_architect_sources(
        session_id,renewal_id,anchor_plan_id,scan_cursor,scan_sweep,revision,state,updated_at
      ) VALUES(?,?,?,NULL,0,0,?,?) ON CONFLICT(session_id) DO UPDATE SET
        renewal_id=excluded.renewal_id,anchor_plan_id=excluded.anchor_plan_id,
        scan_cursor=NULL,scan_sweep=0,state=excluded.state,
        scan_complete_at=NULL,observation_json=NULL,updated_at=excluded.updated_at`,
    ).run(
      sessionID,
      renewalID,
      anchorPlanID,
      architectSourceTransition(this.architectSource(sessionID)?.state ?? "preparing", "PREPARE"),
      now,
    )
  }
  beginArchitectRenewal(input: {
    schedulerOwner: string
    fence: number
    anchorPlanID: string
    previousSessionID: string
    directory: string
    model: string
    idleAt: number
    now: number
    handoffMessageID: string
  }) {
    return this.fenced(input.schedulerOwner, input.fence, (db) => {
      const plans = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM runner_plans WHERE project_directory=? AND owner=? ORDER BY rowid",
        )
        .all(this.repository.projectDirectory, input.previousSessionID)
      if (!plans.length || !plans.some((plan) => plan.id === input.anchorPlanID)) return null

      const continuity = db
        .query<ArchitectContinuityRow, [string, string]>(
          "SELECT * FROM runner_architect_continuity WHERE project_directory=? AND session_id=?",
        )
        .get(this.repository.projectDirectory, input.previousSessionID)
      if (!continuity) return null
      const continuityJSON = JSON.stringify({
        revision: continuity.revision,
        decisions: JSON.parse(continuity.decisions) as string[],
        unresolvedQuestions: JSON.parse(continuity.unresolved_questions) as string[],
      })
      const coverage = db
        .query<{ input_count: number; input_fingerprint: string }, [string, string, number]>(
          `SELECT input_count,input_fingerprint FROM runner_architect_continuity_coverage
           WHERE project_directory=? AND session_id=? AND continuity_revision=?`,
        )
        .get(this.repository.projectDirectory, input.previousSessionID, continuity.revision)
      if (!coverage) return null
      const coveredInputs = db
        .query<{ message_id: string }, [string, string, number]>(
          `SELECT message_id FROM runner_architect_continuity_inputs
           WHERE project_directory=? AND session_id=? AND continuity_revision=?
           ORDER BY message_id`,
        )
        .all(this.repository.projectDirectory, input.previousSessionID, continuity.revision)
        .map((row) => row.message_id)
      if (
        coverage.input_count !== coveredInputs.length ||
        coverage.input_fingerprint !== fingerprint(coveredInputs)
      )
        return null
      const coveredInputSet = new Set(coveredInputs)
      const uncoveredInput = db
        .query<{ message_id: string }, [string]>(
          `SELECT message_id FROM runner_architect_inputs
           WHERE session_id=? AND native_type='user'
           ORDER BY observed_at,message_id`,
        )
        .all(input.previousSessionID)
        .find((row) => !coveredInputSet.has(row.message_id))
      if (uncoveredInput) {
        this.recordOnce(input.anchorPlanID, null, "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT", {
          sessionID: input.previousSessionID,
          continuityRevision: continuity.revision,
          uncoveredInputID: uncoveredInput.message_id,
        })
        return null
      }

      const recentInput = db
        .query<{ message_id: string }, [string, number]>(
          `SELECT message_id FROM runner_architect_inputs
           WHERE session_id=? AND observed_at>=? AND disposition='prompt' LIMIT 1`,
        )
        .get(input.previousSessionID, input.idleAt)
      if (recentInput) return null

      const latest = db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE r.previous_session_id=? AND anchor.project_directory=?
           ORDER BY r.started_at DESC,r.generation DESC LIMIT 1`,
        )
        .get(input.previousSessionID, this.repository.projectDirectory)
      if (
        latest &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(latest.state)
      )
        return latest

      if (latest && ["deferred", "archive-failed"].includes(latest.state)) {
        const blocked =
          latest.error === RENEWAL_SUCCESSOR_FOREIGN
            ? RENEWAL_SUCCESSOR_FOREIGN
            : latest.model !== input.model || latest.directory !== input.directory
              ? "Selected route or directory changed after the prior successor was created"
              : undefined
        if (blocked) {
          // Judged on every plan step: an unchanged refusal is one observation, not one per tick.
          this.recordOnce(latest.anchor_plan_id, null, "ARCHITECT_RENEWAL_RETRY_BLOCKED", {
            renewalID: latest.id,
            reason: blocked,
          })
          return null
        }
        db.query(
          `UPDATE runner_architect_renewals SET idle_at=?,state=lz_runner_transition('renewal',state,'creating'),handoff_message_id=?,
             handoff_outbox_id=NULL,input_message_id=NULL,error=NULL,continuity_json=?,started_at=?
           WHERE id=? AND state IN ('deferred','archive-failed')`,
        ).run(input.idleAt, input.handoffMessageID, continuityJSON, input.now, latest.id)
        db.query("DELETE FROM runner_architect_renewal_coverage WHERE renewal_id=?").run(latest.id)
        for (const messageID of coveredInputs)
          db.query(
            "INSERT INTO runner_architect_renewal_coverage(renewal_id,session_id,message_id) VALUES(?,?,?)",
          ).run(latest.id, input.previousSessionID, messageID)
        this.prepareArchitectSource(
          db,
          input.previousSessionID,
          latest.id,
          input.anchorPlanID,
          input.now,
        )
        db.query(
          "UPDATE runner_architect_inputs SET renewal_id=COALESCE(renewal_id,?) WHERE session_id=?",
        ).run(latest.id, input.previousSessionID)
        for (const plan of plans) {
          const continuation = db
            .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
            .get(plan.id)
          db.query(
            `INSERT INTO runner_architect_renewal_plans(renewal_id,plan_id,prior_continuation,transferred)
             VALUES(?,?,?,0) ON CONFLICT(renewal_id,plan_id) DO UPDATE SET
             prior_continuation=excluded.prior_continuation,transferred=0`,
          ).run(latest.id, plan.id, continuation ? JSON.stringify(continuation) : null)
        }
        return db
          .query<ArchitectRenewalRow, [string]>(
            "SELECT * FROM runner_architect_renewals WHERE id=?",
          )
          .get(latest.id)!
      }

      const continuations = plans.flatMap((plan) => {
        const row = db
          .query<{ generation: number }, [string]>(
            "SELECT generation FROM runner_continuations WHERE plan_id=?",
          )
          .get(plan.id)
        return row ? [row.generation] : []
      })
      const generation = Math.max(0, ...continuations) + 1
      const id = crypto.randomUUID()
      const successorSessionID = `ses_${crypto.randomUUID().replaceAll("-", "")}`
      db.query(
        `INSERT INTO runner_architect_renewals(
          id,anchor_plan_id,previous_session_id,successor_session_id,directory,model,idle_at,
          generation,state,handoff_message_id,handoff_outbox_id,input_message_id,error,continuity_json,started_at
        ) VALUES(?,?,?,?,?,?,?,?,'creating',?,NULL,NULL,NULL,?,?)`,
      ).run(
        id,
        input.anchorPlanID,
        input.previousSessionID,
        successorSessionID,
        input.directory,
        input.model,
        input.idleAt,
        generation,
        input.handoffMessageID,
        continuityJSON,
        input.now,
      )
      this.prepareArchitectSource(db, input.previousSessionID, id, input.anchorPlanID, input.now)
      db.query(
        "UPDATE runner_architect_inputs SET renewal_id=COALESCE(renewal_id,?) WHERE session_id=?",
      ).run(id, input.previousSessionID)
      for (const messageID of coveredInputs)
        db.query(
          "INSERT INTO runner_architect_renewal_coverage(renewal_id,session_id,message_id) VALUES(?,?,?)",
        ).run(id, input.previousSessionID, messageID)
      for (const plan of plans) {
        const continuation = db
          .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
          .get(plan.id)
        db.query(
          "INSERT INTO runner_architect_renewal_plans(renewal_id,plan_id,prior_continuation,transferred) VALUES(?,?,?,0)",
        ).run(id, plan.id, continuation ? JSON.stringify(continuation) : null)
      }
      this.record(input.anchorPlanID, null, "ARCHITECT_RENEWAL_PREPARED", {
        renewalID: id,
        previousSessionID: input.previousSessionID,
        successorSessionID,
        generation,
        planIDs: plans.map((plan) => plan.id),
        idleAt: input.idleAt,
        continuityRevision: continuity.revision,
        continuityCoverageCount: coveredInputs.length,
        continuityCoverageFingerprint: coverage.input_fingerprint,
      })
      return db
        .query<ArchitectRenewalRow, [string]>("SELECT * FROM runner_architect_renewals WHERE id=?")
        .get(id)!
    })
  }
  observeArchitectInput(
    sessionID: string,
    messageID: string,
    now: number,
    detail: {
      type?: string
      delivery?: string
      disposition?: string
      metadata?: Record<string, unknown>
      userPrompt?: boolean
    } = {},
  ) {
    return this.atomic((db) => {
      const renewal = db
        .query<ArchitectRenewalRow, [string, string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE (r.previous_session_id=? OR r.successor_session_id=?)
             AND anchor.project_directory=?
           ORDER BY r.started_at DESC,r.generation DESC LIMIT 1`,
        )
        .get(sessionID, sessionID, this.repository.projectDirectory)
      const ownedPlan = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM runner_plans WHERE project_directory=? AND owner=? ORDER BY rowid LIMIT 1",
        )
        .get(this.repository.projectDirectory, sessionID)
      if (!ownedPlan && !renewal) return { renewal: null, state: null, role: null }
      const existing = db
        .query<{ disposition: string }, [string, string]>(
          "SELECT disposition FROM runner_architect_inputs WHERE session_id=? AND message_id=?",
        )
        .get(sessionID, messageID)
      const disposition = detail.disposition ?? "unknown"
      db.query(
        `INSERT INTO runner_architect_inputs(
          session_id,message_id,observed_at,renewal_id,native_type,delivery,disposition,metadata_json,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET
          observed_at=MIN(runner_architect_inputs.observed_at,excluded.observed_at),
          renewal_id=COALESCE(runner_architect_inputs.renewal_id,excluded.renewal_id),
          native_type=COALESCE(excluded.native_type,runner_architect_inputs.native_type),
          delivery=COALESCE(excluded.delivery,runner_architect_inputs.delivery),
          disposition=CASE WHEN excluded.disposition='unknown' THEN runner_architect_inputs.disposition ELSE excluded.disposition END,
          metadata_json=COALESCE(excluded.metadata_json,runner_architect_inputs.metadata_json),
          updated_at=MAX(runner_architect_inputs.updated_at,excluded.updated_at)`,
      ).run(
        sessionID,
        messageID,
        now,
        renewal?.id ?? null,
        detail.type ?? null,
        detail.delivery ?? null,
        disposition,
        detail.metadata ? JSON.stringify(detail.metadata) : null,
        now,
      )
      if (!renewal) return { renewal: null, state: null, role: "owner" }

      const role = renewal.previous_session_id === sessionID ? "predecessor" : "successor"
      let state = renewal.state
      if (role === "successor") {
        // A user can discover the reserved child before its handoff arrives. Its
        // input belongs to that same session and must not roll ownership back.
      } else if (state === "archiving") {
        db.query(
          "UPDATE runner_architect_renewals SET input_message_id=COALESCE(input_message_id,?) WHERE id=? AND state='archiving'",
        ).run(messageID, renewal.id)
      } else if (state === "creating" && detail.userPrompt) {
        db.query(
          `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),input_message_id=?,error=NULL
           WHERE id=? AND state='creating'`,
        ).run(messageID, renewal.id)
        state = "deferred"
      }
      return {
        renewal: renewal.id,
        state,
        role,
        planID: ownedPlan?.id ?? renewal.anchor_plan_id,
        changed: !existing || existing.disposition !== disposition,
      }
    })
  }
  setArchitectRenewalState(
    schedulerOwner: string,
    fence: number,
    id: string,
    expected: string[],
    state: string,
    error: string | null = null,
  ) {
    return this.fenced(schedulerOwner, fence, (db) => {
      const placeholders = expected.map(() => "?").join(",")
      return (
        db
          .query(
            `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,?),error=? WHERE id=? AND state IN (${placeholders})`,
          )
          .run(state, error, id, ...expected).changes === 1
      )
    })
  }
  transferArchitectRenewal(input: {
    schedulerOwner: string
    fence: number
    renewalID: string
    outboxID: string
    payload: string
    metadata: string
  }) {
    return this.fenced(input.schedulerOwner, input.fence, (db) => {
      const renewal = db
        .query<ArchitectRenewalRow, [string, string]>(
          `SELECT r.* FROM runner_architect_renewals r
           JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
           WHERE r.id=? AND anchor.project_directory=?`,
        )
        .get(input.renewalID, this.repository.projectDirectory)
      if (!renewal || renewal.state !== "creating") return false
      if (!renewal.continuity_json)
        throw new Error("Architect renewal requires an explicit durable continuity checkpoint")
      const continuity = db
        .query<ArchitectContinuityRow, [string, string]>(
          "SELECT * FROM runner_architect_continuity WHERE project_directory=? AND session_id=?",
        )
        .get(this.repository.projectDirectory, renewal.previous_session_id)
      const currentContinuity = continuity
        ? JSON.stringify({
            revision: continuity.revision,
            decisions: JSON.parse(continuity.decisions) as string[],
            unresolvedQuestions: JSON.parse(continuity.unresolved_questions) as string[],
          })
        : null
      if (currentContinuity !== renewal.continuity_json) {
        db.query(
          `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),error=?
           WHERE id=? AND state='creating'`,
        ).run("Architect continuity changed during renewal preparation", renewal.id)
        this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_DEFERRED", {
          renewalID: renewal.id,
          reason: "Architect continuity changed during renewal preparation",
        })
        return false
      }
      const checkpoint = db
        .query<{ input_count: number; input_fingerprint: string }, [string, string, number]>(
          `SELECT input_count,input_fingerprint FROM runner_architect_continuity_coverage
           WHERE project_directory=? AND session_id=? AND continuity_revision=?`,
        )
        .get(this.repository.projectDirectory, renewal.previous_session_id, continuity!.revision)
      const coveredInputIDs = db
        .query<{ message_id: string }, [string, string]>(
          `SELECT message_id FROM runner_architect_renewal_coverage
           WHERE renewal_id=? AND session_id=? ORDER BY message_id`,
        )
        .all(renewal.id, renewal.previous_session_id)
        .map((row) => row.message_id)
      if (
        !checkpoint ||
        checkpoint.input_count !== coveredInputIDs.length ||
        checkpoint.input_fingerprint !== fingerprint(coveredInputIDs)
      ) {
        db.query(
          `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),error=?
           WHERE id=? AND state='creating'`,
        ).run("Architect continuity input coverage changed during renewal preparation", renewal.id)
        this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_DEFERRED", {
          renewalID: renewal.id,
          reason: "Architect continuity input coverage changed during renewal preparation",
        })
        return false
      }
      const coveredInputSet = new Set(coveredInputIDs)
      const currentInput = db
        .query<{ message_id: string }, [string]>(
          `SELECT message_id FROM runner_architect_inputs
           WHERE session_id=? AND native_type='user'
           ORDER BY observed_at,message_id`,
        )
        .all(renewal.previous_session_id)
        .find((row) => !coveredInputSet.has(row.message_id))
      if (currentInput) {
        db.query(
          `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),input_message_id=?,error=?
           WHERE id=? AND state='creating'`,
        ).run(
          currentInput.message_id,
          "Architect continuity checkpoint does not cover observed native input",
          renewal.id,
        )
        this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_DEFERRED", {
          renewalID: renewal.id,
          inputMessageID: currentInput.message_id,
          reason: "Architect continuity checkpoint does not cover observed native input",
        })
        return false
      }
      const recentInput = db
        .query<{ message_id: string }, [string, number]>(
          `SELECT message_id FROM runner_architect_inputs
           WHERE session_id=? AND observed_at>=? AND disposition='prompt' LIMIT 1`,
        )
        .get(renewal.previous_session_id, renewal.idle_at)
      if (recentInput) {
        db.query(
          "UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'deferred'),input_message_id=?,error=NULL WHERE id=? AND state='creating'",
        ).run(recentInput.message_id, renewal.id)
        this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_DEFERRED", {
          renewalID: renewal.id,
          inputMessageID: recentInput.message_id,
          reason: "input arrived before ownership transfer",
        })
        return false
      }

      const currentPlans = db
        .query<{ id: string; version: number }, [string, string]>(
          "SELECT id,version FROM runner_plans WHERE project_directory=? AND owner=? ORDER BY rowid",
        )
        .all(this.repository.projectDirectory, renewal.previous_session_id)
      for (const plan of currentPlans) {
        const continuation = db
          .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
          .get(plan.id)
        db.query(
          "INSERT OR IGNORE INTO runner_architect_renewal_plans(renewal_id,plan_id,prior_continuation,transferred) VALUES(?,?,?,0)",
        ).run(renewal.id, plan.id, continuation ? JSON.stringify(continuation) : null)
      }
      const mappings = db
        .query<ArchitectRenewalPlanRow, [string]>(
          "SELECT * FROM runner_architect_renewal_plans WHERE renewal_id=? ORDER BY plan_id",
        )
        .all(renewal.id)
      if (
        mappings.some((mapping) => !currentPlans.some((plan) => plan.id === mapping.plan_id)) ||
        mappings.length !== currentPlans.length
      )
        throw new Error("Architect ownership changed while renewal was being prepared")
      let transferred = 0
      for (const mapping of mappings) {
        const plan = db
          .query<{ owner: string }, [string, string]>(
            "SELECT owner FROM runner_plans WHERE id=? AND project_directory=?",
          )
          .get(mapping.plan_id, this.repository.projectDirectory)
        if (plan?.owner !== renewal.previous_session_id) continue
        const existing = db
          .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
          .get(mapping.plan_id)
        // The durable plan owner authorizes renewal; continuation rows retain
        // launch history and may predate an explicit ownership transfer.
        if (existing) {
          db.query(
            `UPDATE runner_continuations SET session_id=?,parent_id=?,directory=?,model=?,generation=generation+1
             WHERE plan_id=? AND session_id=?`,
          ).run(
            renewal.successor_session_id,
            renewal.previous_session_id,
            renewal.directory,
            renewal.model,
            mapping.plan_id,
            existing.session_id,
          )
        } else {
          db.query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,?)").run(
            mapping.plan_id,
            renewal.successor_session_id,
            renewal.previous_session_id,
            renewal.directory,
            renewal.model,
            1,
          )
        }
        const changed = db
          .query(
            "UPDATE runner_plans SET owner=?,version=version+1 WHERE id=? AND project_directory=? AND owner=?",
          )
          .run(
            renewal.successor_session_id,
            mapping.plan_id,
            this.repository.projectDirectory,
            renewal.previous_session_id,
          ).changes
        if (changed !== 1) throw new Error("Architect plan ownership changed during renewal")
        db.query(
          "UPDATE runner_architect_renewal_plans SET transferred=1 WHERE renewal_id=? AND plan_id=?",
        ).run(renewal.id, mapping.plan_id)
        this.record(mapping.plan_id, null, "OWNER_CONTINUED", {
          from: renewal.previous_session_id,
          to: renewal.successor_session_id,
          renewalID: renewal.id,
        })
        transferred++
      }
      if (!transferred) return false

      db.query(
        `INSERT INTO runner_architect_continuity(
          project_directory,session_id,revision,decisions,unresolved_questions,updated_at
        ) VALUES(?,?,?,?,?,?) ON CONFLICT(project_directory,session_id) DO UPDATE SET
          revision=excluded.revision,decisions=excluded.decisions,
          unresolved_questions=excluded.unresolved_questions,updated_at=excluded.updated_at`,
      ).run(
        this.repository.projectDirectory,
        renewal.successor_session_id,
        continuity!.revision,
        continuity!.decisions,
        continuity!.unresolved_questions,
        continuity!.updated_at,
      )
      db.query(
        `DELETE FROM runner_architect_continuity_inputs
         WHERE project_directory=? AND session_id=?`,
      ).run(this.repository.projectDirectory, renewal.successor_session_id)
      db.query(
        `INSERT INTO runner_architect_continuity_inputs(
          project_directory,session_id,continuity_revision,message_id
        ) SELECT project_directory,?,continuity_revision,message_id
          FROM runner_architect_continuity_inputs
         WHERE project_directory=? AND session_id=? AND continuity_revision=?`,
      ).run(
        renewal.successor_session_id,
        this.repository.projectDirectory,
        renewal.previous_session_id,
        continuity!.revision,
      )
      db.query(
        `INSERT OR REPLACE INTO runner_architect_continuity_coverage(
          project_directory,session_id,continuity_revision,input_count,input_fingerprint,updated_at
        ) SELECT project_directory,?,continuity_revision,input_count,input_fingerprint,updated_at
          FROM runner_architect_continuity_coverage
         WHERE project_directory=? AND session_id=? AND continuity_revision=?`,
      ).run(
        renewal.successor_session_id,
        this.repository.projectDirectory,
        renewal.previous_session_id,
        continuity!.revision,
      )
      this.record(renewal.anchor_plan_id, null, "ARCHITECT_CONTINUITY_TRANSFERRED", {
        from: renewal.previous_session_id,
        to: renewal.successor_session_id,
        revision: continuity!.revision,
      })

      const ownership = JSON.parse(input.metadata) as {
        lazersSessionID?: string
        lazersMessageID?: string
      }
      if (
        ownership.lazersSessionID !== renewal.successor_session_id ||
        ownership.lazersMessageID !== renewal.handoff_message_id
      )
        throw new Error("Architect handoff ownership does not match its durable renewal")
      const payload = JSON.parse(input.payload) as Record<string, unknown>
      payload.planIDs = mappings.map((mapping) => mapping.plan_id)
      payload.planVersions = currentPlans.map((plan) => ({
        planID: plan.id,
        version: plan.version + 1,
      }))
      db.query(
        `INSERT OR IGNORE INTO runner_outbox(
          id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
        ) VALUES(?,?,?,?,?,'pending',1,?,NULL)`,
      ).run(
        input.outboxID,
        renewal.anchor_plan_id,
        renewal.successor_session_id,
        renewal.handoff_message_id,
        JSON.stringify(payload),
        input.metadata,
      )
      db.query(
        `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'archiving'),handoff_outbox_id=?,error=NULL
         WHERE id=? AND state='creating'`,
      ).run(input.outboxID, renewal.id)
      db.query(
        "UPDATE runner_architect_sources SET state=?,updated_at=? WHERE session_id=? AND renewal_id=?",
      ).run(
        architectSourceTransition(
          this.architectSource(renewal.previous_session_id)!.state,
          "ACTIVATE",
        ),
        Date.now(),
        renewal.previous_session_id,
        renewal.id,
      )
      db.query(
        "UPDATE runner_architect_inputs SET renewal_id=COALESCE(renewal_id,?) WHERE session_id=?",
      ).run(renewal.id, renewal.previous_session_id)
      this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_TRANSFERRED", {
        renewalID: renewal.id,
        previousSessionID: renewal.previous_session_id,
        successorSessionID: renewal.successor_session_id,
        planCount: transferred,
        handoffOutboxID: input.outboxID,
      })
      return true
    })
  }
  finishArchitectRenewal(schedulerOwner: string, fence: number, id: string, wakeContext: unknown) {
    return this.fenced(schedulerOwner, fence, (db) => {
      const renewal = db
        .query<ArchitectRenewalRow, [string]>("SELECT * FROM runner_architect_renewals WHERE id=?")
        .get(id)
      if (!renewal || renewal.state !== "archiving" || !renewal.continuity_json) return false
      const changed = db
        .query(
          "UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,'committed'),error=NULL WHERE id=? AND state='archiving'",
        )
        .run(id).changes
      if (!changed) return false
      this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_COMMITTED", {
        renewalID: renewal.id,
        previousSessionID: renewal.previous_session_id,
        successorSessionID: renewal.successor_session_id,
        wakeContext,
      })
      return true
    })
  }
  rollbackArchitectRenewal(
    schedulerOwner: string,
    fence: number,
    id: string,
    state: "deferred" | "archive-failed",
    error: string | null,
  ) {
    return this.fenced(schedulerOwner, fence, (db) => {
      const renewal = db
        .query<ArchitectRenewalRow, [string]>("SELECT * FROM runner_architect_renewals WHERE id=?")
        .get(id)
      if (!renewal || !["archiving", "recovering-input", "rolling-back"].includes(renewal.state))
        return false
      const mappings = db
        .query<ArchitectRenewalPlanRow, [string]>(
          "SELECT * FROM runner_architect_renewal_plans WHERE renewal_id=? AND transferred=1 ORDER BY plan_id",
        )
        .all(renewal.id)
      for (const mapping of mappings) {
        const changed = db
          .query(
            "UPDATE runner_plans SET owner=?,version=version+1 WHERE id=? AND project_directory=? AND owner=?",
          )
          .run(
            renewal.previous_session_id,
            mapping.plan_id,
            this.repository.projectDirectory,
            renewal.successor_session_id,
          ).changes
        if (!changed) continue
        const prior = mapping.prior_continuation
          ? (JSON.parse(mapping.prior_continuation) as ContinuationRow)
          : null
        if (prior) {
          db.query(
            `INSERT INTO runner_continuations(plan_id,session_id,parent_id,directory,model,generation)
             VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET
             session_id=excluded.session_id,parent_id=excluded.parent_id,directory=excluded.directory,
             model=excluded.model,generation=excluded.generation`,
          ).run(
            mapping.plan_id,
            renewal.previous_session_id,
            prior.parent_id,
            prior.directory,
            prior.model,
            prior.generation + 2,
          )
        } else {
          db.query("DELETE FROM runner_continuations WHERE plan_id=? AND session_id=?").run(
            mapping.plan_id,
            renewal.successor_session_id,
          )
        }
        this.record(mapping.plan_id, null, "OWNER_CONTINUATION_ROLLED_BACK", {
          from: renewal.successor_session_id,
          to: renewal.previous_session_id,
          renewalID: renewal.id,
          reason: state,
        })
      }
      if (renewal.handoff_outbox_id) {
        const changedOutbox = db
          .query(
            "UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,'superseded') WHERE id=? AND state='pending'",
          )
          .run(renewal.handoff_outbox_id).changes
        if (changedOutbox)
          addOutboxReceipt(db, renewal.handoff_outbox_id, {
            kind: "architect-renewal-rolled-back",
            renewalID: renewal.id,
            reason: state,
          })
      }
      const changed = db
        .query(
          `UPDATE runner_architect_renewals SET state=lz_runner_transition('renewal',state,?),error=? WHERE id=?
           AND state IN ('archiving','recovering-input','rolling-back')`,
        )
        .run(state, error, renewal.id).changes
      if (!changed) return false
      this.record(renewal.anchor_plan_id, null, "ARCHITECT_RENEWAL_ROLLED_BACK", {
        renewalID: renewal.id,
        previousSessionID: renewal.previous_session_id,
        successorSessionID: renewal.successor_session_id,
        state,
        error,
        inputMessageID: renewal.input_message_id,
      })
      return true
    })
  }
  ensureContinuation(planID: string, input: Omit<ContinuationRow, "plan_id" | "generation">) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) => {
      db.query("INSERT OR IGNORE INTO runner_continuations VALUES(?,?,?,?,?,1)").run(
        planID,
        input.session_id,
        input.parent_id,
        input.directory,
        input.model,
      )
      return db
        .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
        .get(planID)!
    })
  }
  replaceContinuation(
    planID: string,
    expectedSessionID: string,
    input: Omit<ContinuationRow, "plan_id" | "generation">,
  ) {
    return this.atomic((db) => {
      const existing = db
        .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
        .get(planID)
      if (!existing) throw new Error("Continuation not found")
      if (existing.session_id !== expectedSessionID) return existing
      db.query(
        "UPDATE runner_continuations SET session_id=?,parent_id=?,directory=?,model=?,generation=generation+1 WHERE plan_id=? AND session_id=?",
      ).run(
        input.session_id,
        input.parent_id,
        input.directory,
        input.model,
        planID,
        expectedSessionID,
      )
      return db
        .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
        .get(planID)!
    })
  }
  updatePlanOwner(planID: string, expectedOwner: string, nextOwner: string) {
    const changed = this.atomic(
      (db) =>
        db
          .query(
            "UPDATE runner_plans SET owner=?,version=version+1 WHERE id=? AND project_directory=? AND owner=?",
          )
          .run(nextOwner, planID, this.repository.projectDirectory, expectedOwner).changes === 1,
    )
    if (changed)
      this.record(planID, null, "OWNER_CONTINUED", { from: expectedOwner, to: nextOwner })
    return changed
  }
  /** Advisory ownership: a live Architect that commands the plan becomes its owner. The plan version is unchanged. */
  adoptPlanOwner(planID: string, expectedOwner: string, nextOwner: string) {
    const changed = this.atomic(
      (db) =>
        db
          .query("UPDATE runner_plans SET owner=? WHERE id=? AND project_directory=? AND owner=?")
          .run(nextOwner, planID, this.repository.projectDirectory, expectedOwner).changes === 1,
    )
    if (changed)
      this.record(planID, null, "OWNER_ADOPTED", {
        from: expectedOwner,
        to: nextOwner,
        reason: "command-from-live-architect",
      })
    return changed
  }
  retargetOutbox(input: {
    id: string
    expectedState: string
    sessionID: string
    messageID: string
    metadata: string
    receipt: unknown
  }) {
    return this.atomic((db) => {
      const current = db
        .query<{ state: string }, [string]>("SELECT state FROM runner_outbox WHERE id=?")
        .get(input.id)
      if (current?.state !== input.expectedState) return false
      const changed =
        db
          .query(
            "UPDATE runner_outbox SET session_id=?,message_id=?,metadata=?,state=lz_runner_transition('outbox',state,'pending') WHERE id=? AND state=?",
          )
          .run(input.sessionID, input.messageID, input.metadata, input.id, input.expectedState)
          .changes === 1
      if (changed) {
        addOutboxReceipt(db, input.id, input.receipt)
        this.repository.changed()
      }
      return changed
    })
  }
  /**
   * Notices not yet in an Architect inbox, a page at a time in arrival order; delivered and
   * superseded rows are history. Rows carry no receipt entries: those are child rows read by id.
   */
  *pendingOutbox(
    projectDirectory = this.repository.projectDirectory,
    pageSize = 200,
  ): Generator<OutboxRow> {
    let after = 0
    for (;;) {
      const page = this.read((db) =>
        db
          .query<OutboxRow, [string, number, number]>(
            `SELECT o.id,o.plan_id,o.session_id,o.message_id,o.payload,o.state,o.resume,o.metadata,
                    NULL AS receipt,o.receipt_count,o.receipt_last_kind,
                    CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,o.rowid AS sequence
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE p.project_directory=? AND o.state='pending' AND o.rowid>?
             ORDER BY o.rowid LIMIT ?`,
          )
          .all(projectDirectory, after, pageSize),
      )
      yield* page
      if (page.length < pageSize) return
      after = page.at(-1)!.sequence
    }
  }
  outboxForDelivery(projectDirectory = this.repository.projectDirectory): OutboxRow[] {
    return [...this.pendingOutbox(projectDirectory)]
  }
  outboxRowByMessage(sessionID: string, messageID: string): OutboxRow | undefined {
    return this.read(
      (db) =>
        db
          .query<OutboxRow, [string, string, string]>(
            `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,o.rowid AS sequence
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE p.project_directory=? AND o.session_id=? AND o.message_id=?`,
          )
          .get(this.repository.projectDirectory, sessionID, messageID) ?? undefined,
    )
  }
  /** Delivered notices for these plans that sit in a session other than `sessionID` and are not yet cleaned up. */
  deliveredOutsideSession(planIDs: string[], sessionID: string): OutboxRow[] {
    if (!planIDs.length) return []
    return this.read((db) =>
      db
        .query<OutboxRow, string[]>(
          `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,o.rowid AS sequence
           FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
           WHERE p.project_directory=? AND o.state='delivered' AND o.session_id<>?
             AND o.plan_id IN (${planIDs.map(() => "?").join(",")})
             AND NOT EXISTS (
               SELECT 1 FROM runner_outbox_receipts r
               WHERE r.outbox_id=o.id AND r.kind='retired-session-cleaned'
             )
           ORDER BY o.rowid`,
        )
        .all(this.repository.projectDirectory, sessionID, ...planIDs),
    )
  }
  /** Append a receipt entry without changing the row's state. */
  noteOutboxReceipt(id: string, receipt: unknown) {
    this.atomic((db) => {
      if (!db.query("SELECT 1 FROM runner_outbox WHERE id=?").get(id)) return
      addOutboxReceipt(db, id, receipt)
      this.repository.changed()
    })
  }
  /** Every receipt entry of one outbox row, oldest first. */
  outboxReceipts(id: string): unknown[] {
    return this.read((db) =>
      db
        .query<{ body: string }, [string]>(
          "SELECT body FROM runner_outbox_receipts WHERE outbox_id=? ORDER BY seq",
        )
        .all(id)
        .map((row) => JSON.parse(row.body) as unknown),
    )
  }
  /** Outbox ids a row's receipts record as coalesced into it. */
  coalescedOutboxIDs(id: string): string[] {
    return this.read((db) =>
      db
        .query<{ value: string }, [string]>(
          `SELECT DISTINCT je.value AS value FROM runner_outbox_receipts r, json_each(r.body,'$.coalescedOutboxIDs') je
           WHERE r.outbox_id=? AND json_valid(r.body) AND je.type='text'`,
        )
        .all(id)
        .map((row) => row.value),
    )
  }
  outboxRowByID(id: string): OutboxRow | undefined {
    return this.read(
      (db) =>
        db
          .query<OutboxRow, [string, string]>(
            `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,o.rowid AS sequence
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE p.project_directory=? AND o.id=?`,
          )
          .get(this.repository.projectDirectory, id) ?? undefined,
    )
  }
  activity(planID: string, taskID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<
          {
            id: number
            task_id: string | null
            event: string
            payload: string
            created_at: number
          },
          [string, string]
        >(
          "SELECT id,task_id,event,payload,created_at FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id",
        )
        .all(planID, taskID),
    )
  }
  effectiveWriteScope(
    taskID: string,
    task: ReturnType<typeof this.repository.get> = this.repository.get(taskID),
  ): string[] {
    if (!task) throw new Error("Task not found")
    const execution = this.execution(taskID)
    const amendment = execution
      ? this.latestTransition<{ writeScope: string[] }>(execution.planID, taskID, "SCOPE_AMENDED")
      : undefined
    return TaskProposalSchema.shape.writeScope.parse([
      ...new Set([...task.proposal.writeScope, ...(amendment?.writeScope ?? [])]),
    ])
  }
  /**
   * The scope model in force: the task's edit/create/protected plus what Architect amendments added
   * (`amended`) or released (exact paths an amendment named that the task protected).
   */
  effectiveScope(
    taskID: string,
    task: ReturnType<typeof this.repository.get> = this.repository.get(taskID),
  ): ScopeModel {
    if (!task) throw new Error("Task not found")
    const edit = this.effectiveWriteScope(taskID, task)
    const original = new Set(task.proposal.writeScope)
    const amended = edit.filter((pattern) => !original.has(pattern))
    const protectedScope = task.proposal.protectedScope ?? []
    return {
      edit,
      amended,
      create: task.proposal.createScope ?? [],
      protected: protectedScope,
      released: amended.filter((pattern) => !/[*?{}[\]!]/.test(pattern)),
    }
  }
  /** Edit plus create: what the task reserves against concurrent work. */
  effectiveReservationScope(taskID: string): string[] {
    const scope = this.effectiveScope(taskID)
    return reservationPatterns(scope.edit, scope.create)
  }
  dispatchReservations() {
    return [
      ...this.activeProjectAttempts().map((attempt) => ({
        taskID: attempt.task_id,
        shared: attempt.workspace === this.repository.projectDirectory,
        scopes: this.effectiveReservationScope(attempt.task_id),
      })),
      ...this.activeAdoptions().map((adoption) => ({
        taskID: adoption.task_id,
        shared: false,
        scopes: this.effectiveReservationScope(adoption.task_id),
      })),
    ]
  }

  waitingOnPlanFacts(prerequisiteIDs: readonly string[] | undefined) {
    if (!prerequisiteIDs) return { plans: [], count: 0, complete: false }
    const uniquePrerequisites: string[] = []
    const seen = new Set<string>()
    let inputComplete = true
    for (const [index, prerequisiteID] of prerequisiteIDs.entries()) {
      if (index > MAX_EXECUTION_PLAN_WAIT_REFERENCES) {
        inputComplete = false
        break
      }
      if (seen.has(prerequisiteID)) continue
      seen.add(prerequisiteID)
      uniquePrerequisites.push(prerequisiteID)
    }
    if (!uniquePrerequisites.length) return { plans: [], count: 0, complete: true }
    const rows = this.read((db) =>
      db
        .query<
          {
            plan_id: string
            title: string | null
            state: string | null
            version: number | null
            reason: string | null
            total: number
          },
          [string, string, number]
        >(
          `WITH prerequisites AS (
             SELECT CAST(key AS INTEGER) AS ordinal,value AS plan_id FROM json_each(?)
           )
           SELECT prerequisites.plan_id,
                  COALESCE(json_extract(required.body,'$.title'),
                           json_extract(required.body,'$.objective')) AS title,
                  required.state,required.version,required.reason,
                  COUNT(*) OVER() AS total
           FROM prerequisites
           LEFT JOIN runner_plans required
             ON required.project_directory=? AND required.id=prerequisites.plan_id
           WHERE required.id IS NULL
              OR required.state NOT IN ('cleaning','cleanup-blocked','integrated')
           ORDER BY prerequisites.ordinal
           LIMIT ?`,
        )
        .all(
          JSON.stringify(uniquePrerequisites),
          this.repository.projectDirectory,
          MAX_EXECUTION_PLAN_WAIT_REFERENCES + 1,
        ),
    )
    const count = rows[0]?.total ?? 0
    return {
      plans: rows.slice(0, MAX_EXECUTION_PLAN_WAIT_REFERENCES).map((row) => ({
        planID: row.plan_id,
        title: row.title?.slice(0, 120) ?? null,
        state: row.state?.slice(0, 80) ?? null,
        version: row.version,
        reason: row.reason?.slice(0, 400) ?? null,
      })),
      count,
      complete: inputComplete && count <= MAX_EXECUTION_PLAN_WAIT_REFERENCES,
    }
  }

  execution(taskID: string): Execution | undefined {
    const node = this.read((db) =>
      db
        .query<
          NodeRow & { plan_state: string; plan_reason: string | null; plan_body: string },
          [string, string]
        >(
          "SELECT n.*,p.state AS plan_state,p.reason AS plan_reason,p.body AS plan_body FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=? AND n.task_id=?",
        )
        .get(this.repository.projectDirectory, taskID),
    )
    if (!node) return undefined
    const adoption = this.activeAdoptionForTask(node.plan_id, taskID)
    const waitingOn = this.read((db) =>
      db
        .query<{ prerequisite: string }, [string, string]>(
          `SELECT d.prerequisite FROM runner_dependencies d
           JOIN runner_nodes n ON n.plan_id=d.plan_id AND n.task_id=d.prerequisite
           WHERE d.plan_id=? AND d.successor=? AND (n.state!='accepted' OR EXISTS(
             SELECT 1 FROM runner_adoptions a WHERE a.plan_id=n.plan_id AND a.task_id=n.task_id
               AND a.state IN ('pending','task-checks','combined-checks')
           ) OR NOT EXISTS(
             SELECT 1 FROM runner_transitions ti
             WHERE ti.plan_id=d.plan_id AND ti.task_id=d.prerequisite
               AND ti.event='TASK_INTEGRATION_RECORDED' AND json_valid(ti.payload)
               AND json_extract(ti.payload,'$.artifact')=n.artifact
           ))`,
        )
        .all(node.plan_id, taskID)
        .map((r) => r.prerequisite),
    )
    let prerequisites: string[] | undefined
    try {
      const parsed = PlanInput.safeParse(JSON.parse(node.plan_body))
      if (parsed.success) prerequisites = parsed.data.afterPlans ?? []
    } catch {
      prerequisites = undefined
    }
    const waitingPlans = this.waitingOnPlanFacts(prerequisites)
    return {
      planID: node.plan_id,
      taskID,
      state:
        adoption || (node.plan_state === "blocked" && ["queued", "ready"].includes(node.state))
          ? "blocked"
          : node.state,
      version: node.version,
      reason:
        adoption?.hold_reason ??
        (adoption ? `Descendant adoption ${adoption.id} is pending` : null) ??
        node.reason ??
        (node.plan_state === "blocked" ? node.plan_reason : null),
      waitingOn,
      ...(waitingPlans.count || !waitingPlans.complete
        ? {
            waitingOnPlans: waitingPlans.plans,
            waitingOnPlansCount: waitingPlans.count,
            waitingOnPlansComplete: waitingPlans.complete,
          }
        : {}),
      ...(["queued", "ready"].includes(node.state) && this.effectiveDispatchPause(node.plan_id)
        ? { dispatchPause: this.effectiveDispatchPause(node.plan_id) }
        : {}),
    }
  }
  command<T>(requestID: string, input: unknown, run: (db: Database) => T): T {
    return this.atomic((db) => {
      const hash = fingerprint(input)
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT * FROM runner_commands WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, requestID)
      if (previous) {
        if (!this.sameRequest(previous.fingerprint, hash, input))
          throw new Error("Request identity conflict")
        return JSON.parse(previous.receipt) as T
      }
      const result = run(db)
      db.query("INSERT INTO runner_commands VALUES(?,?,?,?)").run(
        this.repository.projectDirectory,
        requestID,
        hash,
        JSON.stringify(result),
      )
      this.repository.changed()
      return result
    })
  }

  priorCommand<T>(requestID: string, input: unknown): T | undefined {
    return this.read((db) => {
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT fingerprint,receipt FROM runner_commands WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, requestID)
      if (!previous) return undefined
      if (!this.sameRequest(previous.fingerprint, fingerprint(input), input))
        throw new Error("Request identity conflict")
      return JSON.parse(previous.receipt) as T
    })
  }

  /**
   * Plan commands recorded before the caller-supplied version was removed were
   * fingerprinted with their `expectedVersion`. A replay without it still
   * matches: the recorded version was some plan version no greater than the
   * current one, so the legacy fingerprint is reconstructed and compared.
   */
  private sameRequest(stored: string, current: string, input: unknown): boolean {
    if (stored === current) return true
    const wrapper = input as { command?: { planID?: unknown } } | null
    const command = wrapper?.command
    if (!command || typeof command.planID !== "string") return false
    const ceiling = this.plan(command.planID)?.version ?? 0
    for (let version = 1; version <= ceiling; version++)
      if (stored === fingerprint({ ...wrapper, command: { ...command, expectedVersion: version } }))
        return true
    return false
  }

  renew(owner: string, fence: number, now = Date.now()) {
    return this.atomic(
      (db) =>
        db
          .query(
            "UPDATE runner_leases SET expires_at=? WHERE project_directory=? AND owner=? AND fence=?",
          )
          .run(now + 30000, this.repository.projectDirectory, owner, fence).changes === 1,
    )
  }
  submit(
    input: unknown,
    owner: string,
    timeoutDefaults: VerificationTimeoutDefaults = verificationTimeoutDefaults(),
  ) {
    const plan = PlanSubmissionInput.parse(input)
    return this.command(plan.requestID, { plan, owner }, (db) => {
      this.validatePlanDependencies(plan.afterPlans ?? [])
      const invalidCombinedTimings = invalidVerificationTimings(plan.verification, timeoutDefaults)
      if (invalidCombinedTimings.length)
        throw new Error(
          `Combined verification check ${invalidCombinedTimings[0]!.checkID} inactivity allowance exceeds the configured hard backstop`,
        )
      for (const node of plan.nodes) {
        if (this.repository.taskDisposition(node.taskID))
          throw new Error("Task has been retired; inspect its disposition")
        const task = this.repository.get(node.taskID)
        if (!task || task.revision !== node.revision)
          throw new Error(`Missing, foreign, or stale task ${node.taskID}`)
        const invalidTaskTimings = invalidVerificationTimings(
          task.proposal.verification,
          timeoutDefaults,
        )
        if (invalidTaskTimings.length)
          throw new Error(
            `Task verification check ${invalidTaskTimings[0]!.checkID} inactivity allowance exceeds the configured hard backstop`,
          )
      }
      for (const relation of plan.dispositions)
        if (!this.repository.get(relation.otherTaskID)) throw new Error("Foreign relation target")
      const id = crypto.randomUUID()
      db.query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body,model,reason,artifact) VALUES(?,?,?,1,1,'draft',?,NULL,NULL,NULL)",
      ).run(id, this.repository.projectDirectory, owner, JSON.stringify(plan))
      db.query("INSERT INTO runner_plan_revisions VALUES(?,1,?,?,?)").run(
        id,
        JSON.stringify(plan),
        owner,
        Date.now(),
      )
      for (const taskID of plan.integrationOrder)
        db.query(
          "INSERT INTO runner_nodes(plan_id,task_id,spec_revision,ordinal,state,version,reason,artifact,snapshot,machine_version) VALUES(?,?,1,?,'queued',1,NULL,NULL,?,?)",
        ).run(
          id,
          taskID,
          plan.integrationOrder.indexOf(taskID),
          JSON.stringify(initialSnapshot()),
          machineVersion,
        )
      for (const edge of plan.dependencies)
        db.query("INSERT INTO runner_dependencies VALUES(?,?,?)").run(
          id,
          edge.prerequisite,
          edge.successor,
        )
      for (const relation of plan.dispositions) {
        db.query("INSERT INTO runner_relations VALUES(?,?,?,?,?,?,?)").run(
          this.repository.projectDirectory,
          relation.taskID,
          relation.otherTaskID,
          relation.relation,
          relation.rationale,
          owner,
          Date.now(),
        )
      }
      this.record(id, null, "PLAN_SUBMITTED", { owner, revision: 1 })
      return { status: "submitted", planID: id, version: 1 }
    })
  }
  validatePlanDependencies(dependencies: string[], sourceID?: string) {
    if (new Set(dependencies).size !== dependencies.length)
      throw new Error("Duplicate plan dependency")
    const visit = (id: string, path: Set<string>) => {
      if (id === sourceID || path.has(id)) throw new Error("Plan dependency cycle")
      const plan = this.plan(id)
      if (!plan) throw new Error("Missing or foreign plan dependency")
      const next = new Set(path).add(id)
      for (const dependency of new Set([
        ...(PlanInput.parse(JSON.parse(plan.body)).afterPlans ?? []),
        ...(this.dispatchPause(id)?.untilPlans ?? []),
      ]))
        visit(dependency, next)
    }
    for (const dependency of dependencies) visit(dependency, new Set())
  }
  revisePlan(plan: PlanRow, input: PlanInput, event: string, details: unknown) {
    this.atomic((db) => {
      db.query(
        "UPDATE runner_plans SET body=?,revision=revision+1,version=version+1 WHERE id=?",
      ).run(JSON.stringify(input), plan.id)
      db.query("INSERT INTO runner_plan_revisions VALUES(?,?,?,?,?)").run(
        plan.id,
        plan.revision + 1,
        JSON.stringify(input),
        plan.owner,
        Date.now(),
      )
      this.record(plan.id, null, event, details)
    })
  }
  record(planID: string, taskID: string | null, event: string, payload: unknown) {
    const plan = this.plan(planID)
    if (!plan) throw new Error("Plan not found")
    this.atomic((db) => {
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
      ).run(planID, taskID, plan.version, event, JSON.stringify(payload), Date.now())
      this.repository.changed()
    })
  }
  /** Record a changed condition without rewriting the same fact on every scheduler drain. */
  recordOnce(planID: string, taskID: string | null, event: string, payload: unknown): boolean {
    return this.atomic(() => {
      const previous = this.latestTransition<unknown>(planID, taskID, event)
      if (previous !== undefined && canonical(previous) === canonical(payload)) return false
      this.record(planID, taskID, event, payload)
      return true
    })
  }
  /**
   * Record an Architect source scan failure once per (source, cause). The plan-level
   * `recordOnce` compares only the newest row of the anchor plan, so several sources
   * sharing one anchor plan alternate and every process start re-recorded all of them.
   */
  recordSourceScanFailure(
    planID: string,
    payload: { renewalID: string; sourceSessionID: string; error: string },
  ): boolean {
    return this.atomic(() => {
      const previous = this.read((db) =>
        db
          .query<{ payload: string }, [string, string]>(
            `SELECT payload FROM runner_transitions
             WHERE plan_id=? AND task_id IS NULL AND event='ARCHITECT_SOURCE_SCAN_FAILED'
               AND json_extract(payload,'$.sourceSessionID')=? ORDER BY id DESC LIMIT 1`,
          )
          .get(planID, payload.sourceSessionID),
      )
      if (previous && canonical(JSON.parse(previous.payload)) === canonical(payload)) return false
      this.record(planID, null, "ARCHITECT_SOURCE_SCAN_FAILED", payload)
      return true
    })
  }
  latestTransition<T>(planID: string, taskID: string | null, event: string): T | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    const row = this.read((db) =>
      db
        .query<{ payload: string }, [string, string | null, string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id IS ? AND event=? ORDER BY id DESC LIMIT 1",
        )
        .get(planID, taskID, event),
    )
    return row ? (JSON.parse(row.payload) as T) : undefined
  }
  latestTransitionVersion(
    planID: string,
    taskID: string | null,
    event: string,
  ): number | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read(
      (db) =>
        db
          .query<{ version: number }, [string, string | null, string]>(
            "SELECT version FROM runner_transitions WHERE plan_id=? AND task_id IS ? AND event=? ORDER BY id DESC LIMIT 1",
          )
          .get(planID, taskID, event)?.version,
    )
  }
  verificationTimeoutAmendments(planID: string): VerificationTimeoutAmendment[] {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='VERIFICATION_DEADLINE_EXTENDED' ORDER BY id",
        )
        .all(planID)
        .map((row) => VerificationTimeoutAmendmentSchema.parse(JSON.parse(row.payload))),
    )
  }
  latestRetainedRepair<T>(planID: string, taskID?: string): T | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    const row = this.read((db) =>
      taskID === undefined
        ? db
            .query<{ payload: string }, [string]>(
              "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='RETAINED_REPAIR_REQUESTED' ORDER BY id DESC LIMIT 1",
            )
            .get(planID)
        : db
            .query<{ payload: string }, [string, string]>(
              "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id=? AND event='RETAINED_REPAIR_REQUESTED' ORDER BY id DESC LIMIT 1",
            )
            .get(planID, taskID),
    )
    return row ? (JSON.parse(row.payload) as T) : undefined
  }
  move(planID: string, taskID: string, event: string, reason: string | null = null) {
    return this.atomic((db) => {
      const node = this.nodes(planID).find((n) => n.task_id === taskID)
      if (!node) throw new Error("Task not in plan")
      if (node.machine_version !== machineVersion)
        throw new Error("Unsupported task machine version")
      const next = transition(node.state, event)
      if (["queued", "ready", "running"].includes(next.state)) {
        const fulfilled = db
          .query<{ id: number }, [string, string]>(
            `SELECT id FROM task_dispositions
             WHERE project_directory=? AND task_id=? AND disposition='fulfilled'
             ORDER BY id DESC LIMIT 1`,
          )
          .get(this.repository.projectDirectory, taskID)
        if (fulfilled)
          throw new Error("Task has a fulfilled disposition; worker execution is fenced")
      }
      db.query(
        "UPDATE runner_nodes SET state=?,version=version+1,reason=?,snapshot=? WHERE plan_id=? AND task_id=? AND version=?",
      ).run(next.state, reason, JSON.stringify(next.snapshot), planID, taskID, node.version)
      db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(planID)
      this.record(planID, taskID, event, { from: node.state, to: next.state, reason })
      return next.state
    })
  }
  /** Expire this owner's lease so a successor claims at once; never touches another owner's row. */
  releaseLease(owner: string) {
    return this.atomic(
      (db) =>
        db
          .query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=? AND owner=?")
          .run(this.repository.projectDirectory, owner).changes > 0,
    )
  }
  claim(owner: string, now = Date.now()) {
    return this.atomic((db) => {
      const old = db
        .query<{ owner: string; fence: number; expires_at: number }, [string]>(
          "SELECT * FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (old && old.owner !== owner && old.expires_at > now) return null
      const fence = old?.owner === owner ? old.fence : (old?.fence ?? 0) + 1
      db.query(
        "INSERT INTO runner_leases VALUES(?,?,?,?) ON CONFLICT(project_directory) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires_at=excluded.expires_at",
      ).run(this.repository.projectDirectory, owner, fence, now + 30000)
      return fence
    })
  }
  /** Time until the current lease lapses, bounded so a tick that lost the claim returns promptly. */
  leaseRetryDelayMs(now = Date.now()) {
    const lease = this.read((db) =>
      db
        .query<{ expires_at: number }, [string]>(
          "SELECT expires_at FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory),
    )
    return Math.min(30_000, Math.max(1_000, (lease?.expires_at ?? now) - now + 250))
  }
  private assertFence(db: Database, owner: string, fence: number) {
    const lease = db
      .query<{ owner: string; fence: number }, [string]>(
        "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
      )
      .get(this.repository.projectDirectory)
    if (lease?.owner !== owner || lease.fence !== fence) throw new Error("Stale scheduler fence")
  }
  fenced<T>(owner: string, fence: number, run: (db: Database) => T): T {
    return this.read((db) => {
      this.assertFence(db, owner, fence)
      return run(db)
    })
  }
  /** A scheduler-fenced write transaction for admissions that must pair with a durable row. */
  fencedAtomic<T>(owner: string, fence: number, run: (db: Database) => T): T {
    return this.repository.atomic((db) => {
      this.assertFence(db, owner, fence)
      return run(db)
    })
  }
  /**
   * Project audit. Per-task work (record parse, fingerprint, effective scope) runs
   * once per task inside the read; pair detection runs outside it. Exact duplicates
   * group by fingerprint; scope overlap compares only tasks sharing a top-level
   * path bucket (wildcard/root patterns compare against everything), so findings
   * equal the all-pairs result.
   */
  audit(): { watermark: number; findings: Finding[] } {
    const { tasks, relations, watermark } = this.read((db) => {
      const rows = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM tasks WHERE project_directory=? ORDER BY rowid",
        )
        .all(this.repository.projectDirectory)
        .filter((task) => !this.repository.taskDisposition(task.id))
      const tasks = rows.map(({ id }) => {
        const record = this.repository.get(id)
        return {
          id,
          planned: !!this.execution(id),
          content: fingerprint(record!.proposal),
          scope: reservationPatterns(
            this.effectiveWriteScope(id, record),
            record!.proposal.createScope ?? [],
          ),
        }
      })
      const relations = db
        .query<{ task_id: string; other_task_id: string }, [string]>(
          "SELECT task_id,other_task_id FROM runner_relations WHERE project_directory=?",
        )
        .all(this.repository.projectDirectory)
      return { tasks, relations, watermark: this.repository.version() }
    })
    const findings: Finding[] = []
    const add = (code: string, taskIDs: string[], evidence: string, actions: string[]) =>
      findings.push({
        id: fingerprint({ code, taskIDs }).slice(0, 24),
        code,
        taskIDs,
        evidence,
        actions,
      })
    for (const task of tasks)
      if (!task.planned)
        add("unplanned", [task.id], "Specification has no admitted execution plan", [
          "plan",
          "reuse",
        ])
    const related = new Set(
      relations.flatMap((r) => [
        `${r.task_id}\0${r.other_task_id}`,
        `${r.other_task_id}\0${r.task_id}`,
      ]),
    )
    const n = tasks.length
    const exact = new Set<number>()
    const candidates = new Set<number>()
    const key = (i: number, j: number) => (i < j ? i * n + j : j * n + i)
    const byContent = new Map<string, number[]>()
    const byBucket = new Map<string, number[]>()
    const wild: number[] = []
    tasks.forEach((task, i) => {
      const group = byContent.get(task.content)
      if (group) {
        for (const j of group) exact.add(key(j, i))
        group.push(i)
      } else byContent.set(task.content, [i])
      const buckets = scopeBuckets(task.scope)
      if (buckets === "wild") wild.push(i)
      else
        for (const bucket of buckets) {
          const list = byBucket.get(bucket)
          if (list) list.push(i)
          else byBucket.set(bucket, [i])
        }
    })
    for (const list of byBucket.values())
      for (let x = 0; x < list.length; x++)
        for (let y = x + 1; y < list.length; y++) candidates.add(key(list[x]!, list[y]!))
    for (const w of wild) for (let i = 0; i < n; i++) if (i !== w) candidates.add(key(w, i))
    const pairs = new Map<number, boolean>()
    for (const k of exact) pairs.set(k, true)
    for (const k of candidates)
      if (!pairs.has(k)) {
        const a = tasks[Math.floor(k / n)]!
        const b = tasks[k % n]!
        if (scopePatternsConflict(a.scope, b.scope)) pairs.set(k, false)
      }
    for (const k of [...pairs.keys()].sort((x, y) => x - y)) {
      const a = tasks[Math.floor(k / n)]!
      const b = tasks[k % n]!
      if (related.has(`${a.id}\0${b.id}`)) continue
      const isExact = pairs.get(k)!
      add(
        isExact ? "exact-content" : "scope-overlap",
        [a.id, b.id],
        isExact
          ? "Validated proposal fingerprints match"
          : `Conflicting path scopes: ${a.scope.join(", ")} ↔ ${b.scope.join(", ")}`,
        ["distinct", "duplicate", "supplements"],
      )
    }
    return { watermark, findings }
  }
  /** Admission needs duplicate-content conflicts for its selected tasks, not a project audit. */
  exactContentConflicts(taskIDs: readonly string[]): { watermark: number; findings: Finding[] } {
    return this.read((db) => {
      const selected = new Set(taskIDs)
      if (!selected.size) return { watermark: this.repository.version(), findings: [] }
      const tasks = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM tasks WHERE project_directory=?
           AND NOT EXISTS (SELECT 1 FROM task_dispositions d
             WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)
           ORDER BY rowid`,
        )
        .all(this.repository.projectDirectory)
        .map(({ id }) => ({ id, content: fingerprint(this.repository.get(id)!.proposal) }))
      const relations = db
        .query<{ task_id: string; other_task_id: string }, [string]>(
          "SELECT task_id,other_task_id FROM runner_relations WHERE project_directory=?",
        )
        .all(this.repository.projectDirectory)
      const related = new Set(
        relations.flatMap((r) => [
          JSON.stringify([r.task_id, r.other_task_id]),
          JSON.stringify([r.other_task_id, r.task_id]),
        ]),
      )
      const findings: Finding[] = []
      const byContent = new Map<string, number[]>()
      tasks.forEach((task, i) => {
        const group = byContent.get(task.content)
        if (group) group.push(i)
        else byContent.set(task.content, [i])
      })
      for (let i = 0; i < tasks.length; i++) {
        const a = tasks[i]!
        if (!selected.has(a.id)) continue
        for (const j of byContent.get(a.content)!) {
          const b = tasks[j]!
          if (i === j || (j < i && selected.has(b.id)) || related.has(JSON.stringify([a.id, b.id])))
            continue
          const pair = i < j ? [a.id, b.id] : [b.id, a.id]
          findings.push({
            id: fingerprint({ code: "exact-content", taskIDs: pair }).slice(0, 24),
            code: "exact-content",
            taskIDs: pair,
            evidence: "Validated proposal fingerprints match",
            actions: ["distinct", "duplicate", "supplements"],
          })
        }
      }
      return { watermark: this.repository.version(), findings }
    })
  }
  attempts(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<AttemptRow, [string]>(
          "SELECT * FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number",
        )
        .all(planID),
    )
  }
  /** Every live project reservation, independent of retained plan history or plan state. */
  activeProjectAttempts(): AttemptRow[] {
    return this.read((db) =>
      db
        .query<AttemptRow, [string]>(
          `SELECT a.* FROM runner_attempts a JOIN runner_plans p ON a.plan_id=p.id
           WHERE a.project_directory=? AND a.state IN ('preparing','running','verifying')
           ORDER BY ${planPrioritySortSQL("p.body")},p.rowid,a.started_at,a.number`,
        )
        .all(this.repository.projectDirectory),
    )
  }
  taskPrerequisiteIntegrationRows(planID: string, taskIDs: readonly string[]) {
    if (!taskIDs.length || new Set(taskIDs).size !== taskIDs.length) return []
    const rows: TaskPrerequisiteIntegrationRow[] = []
    for (let offset = 0; offset < taskIDs.length; offset += 100) {
      const batch = taskIDs.slice(offset, offset + 100)
      rows.push(
        ...this.read((db) =>
          db
            .query<TaskPrerequisiteIntegrationRow, [string, string, ...string[]]>(
              `SELECT p.id AS plan_id,n.task_id,p.project_directory,n.state AS node_state,
                 n.artifact,
                 (SELECT tr.id FROM runner_transitions tr
                  WHERE tr.plan_id=n.plan_id AND tr.task_id=n.task_id
                    AND tr.event='TASK_INTEGRATION_RECORDED' ORDER BY tr.id DESC LIMIT 1) AS integration_id,
                 (SELECT tr.payload FROM runner_transitions tr
                  WHERE tr.plan_id=n.plan_id AND tr.task_id=n.task_id
                    AND tr.event='TASK_INTEGRATION_RECORDED' ORDER BY tr.id DESC LIMIT 1) AS integration_payload
               FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
               WHERE p.project_directory=? AND n.plan_id=?
                 AND n.task_id IN (${batch.map(() => "?").join(",")})`,
            )
            .all(this.repository.projectDirectory, planID, ...batch),
        ),
      )
    }
    return rows
  }
  /** One bounded, read-only database view for the registered scheduling projection. */
  schedulingFacts(
    input: {
      maxPlans?: number
      maxNodes?: number
      maxReservations?: number
      scopeSessionID?: string
    } = {},
  ) {
    const maxPlans = Math.max(1, Math.min(input.maxPlans ?? 1_000, 1_000))
    const maxNodes = Math.max(1, Math.min(input.maxNodes ?? 10_000, 10_000))
    const maxReservations = Math.max(1, Math.min(input.maxReservations ?? 10_000, 10_000))
    const directory = this.repository.projectDirectory
    return this.read((db): SchedulingFactSnapshot => {
      const repositoryVersion = db
        .query<{ version: number }, [string]>(
          "SELECT COALESCE(MAX(id),0) AS version FROM task_changes WHERE project_directory=?",
        )
        .get(directory)!.version
      const scopedAssociations = input.scopeSessionID
        ? schedulingSessionAssociations(db, directory, input.scopeSessionID)
        : undefined
      const totalPlanCount = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runner_plans WHERE project_directory=?",
        )
        .get(directory)!.count
      const totalNodeCount = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=?",
        )
        .get(directory)!.count
      const plans = db
        .query<SchedulingPlanFact, [string, number]>(
          `SELECT p.*,p.rowid AS sequence,
             COALESCE(json_extract(p.body,'$.priority'),0) AS priority,
             (SELECT COUNT(*) FROM runner_nodes n WHERE n.plan_id=p.id) AS node_count,
             (SELECT a.policy FROM runner_attempts a WHERE a.plan_id=p.id
              ORDER BY a.number DESC LIMIT 1) AS last_attempt_policy,
             c.reason AS pause_reason,c.until_plans AS pause_until_plans
           FROM runner_plans p
           LEFT JOIN runner_dispatch_controls c ON c.plan_id=p.id AND c.state='paused'
           WHERE p.project_directory=?
           ORDER BY ${prioritySortSQL("priority")},p.rowid LIMIT ?`,
        )
        .all(directory, maxPlans)
      // A project or global pause holds every plan, with no resume condition.
      const outer = outerPauseIn(db, directory)
      if (outer)
        for (const plan of plans) {
          plan.pause_reason = outerPauseReason(outer)
          plan.pause_until_plans = "[]"
        }
      const nodes = db
        .query<SchedulingNodeFact, [string, string, number]>(
          `WITH selected_plans AS MATERIALIZED (
             SELECT id,rowid AS sequence,
               COALESCE(json_extract(body,'$.priority'),0) AS priority
             FROM runner_plans WHERE project_directory=?
             ORDER BY ${prioritySortSQL("priority")},rowid LIMIT ${maxPlans}
           )
           SELECT n.*,p.sequence,p.priority,t.body AS task_body,r.reference,
             (SELECT tr.payload FROM runner_transitions tr
              WHERE tr.plan_id=n.plan_id AND tr.task_id=n.task_id AND tr.event='SCOPE_AMENDED'
              ORDER BY tr.id DESC LIMIT 1) AS scope_payload
           FROM runner_nodes n JOIN selected_plans p ON p.id=n.plan_id
           JOIN tasks t ON t.project_directory=? AND t.id=n.task_id
           LEFT JOIN task_references r ON r.project_directory=t.project_directory AND r.task_id=t.id
           ORDER BY ${prioritySortSQL("p.priority")},p.sequence,n.ordinal LIMIT ?`,
        )
        .all(directory, directory, maxNodes + 1)
      if (nodes.length > maxNodes) nodes.pop()
      const coveredPlanNodeCount = plans.reduce((sum, plan) => sum + plan.node_count, 0)
      const planIDs = plans.map((plan) => plan.id)
      const dependencies = planIDs.length
        ? db
            .query<{ plan_id: string; prerequisite: string; successor: string }, string[]>(
              `SELECT d.plan_id,d.prerequisite,d.successor FROM runner_dependencies d
               JOIN runner_plans p ON p.id=d.plan_id
               WHERE p.project_directory=? AND d.plan_id IN (${planIDs.map(() => "?").join(",")})
               ORDER BY p.rowid,d.successor,d.prerequisite`,
            )
            .all(directory, ...planIDs)
        : []

      const reservations = db
        .query<SchedulingReservationFact, [string, string, number]>(
          `SELECT a.*,t.body AS task_body,
             (SELECT tr.payload FROM runner_transitions tr
              WHERE tr.plan_id=a.plan_id AND tr.task_id=a.task_id AND tr.event='SCOPE_AMENDED'
              ORDER BY tr.id DESC LIMIT 1) AS scope_payload
           FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
           JOIN tasks t ON t.project_directory=? AND t.id=a.task_id
           WHERE p.project_directory=? AND a.state IN ('preparing','running','verifying')
           ORDER BY ${planPrioritySortSQL("p.body")},p.rowid,a.started_at,a.number LIMIT ?`,
        )
        .all(directory, directory, maxReservations + 1)
      const totalReservationCount = db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
           WHERE p.project_directory=? AND a.state IN ('preparing','running','verifying')`,
        )
        .get(directory)!.count
      if (reservations.length > maxReservations) reservations.pop()
      const reservationsComplete = reservations.length === totalReservationCount

      const adoptions = db
        .query<AdoptionRow, [string, number]>(
          `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
           WHERE p.project_directory=? AND a.state IN ('pending','task-checks','combined-checks')
           ORDER BY p.rowid,a.created_at,a.id LIMIT ?`,
        )
        .all(directory, maxReservations + 1)
      const totalAdoptionCount = db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
           WHERE p.project_directory=? AND a.state IN ('pending','task-checks','combined-checks')`,
        )
        .get(directory)!.count
      const adoptionsComplete = adoptions.length <= maxReservations
      if (!adoptionsComplete) adoptions.pop()

      const nodeTaskIDs = [...new Set(nodes.map((node) => node.task_id))]
      const taskIntegrations: TaskPrerequisiteIntegrationRow[] = []
      for (let offset = 0; offset < nodeTaskIDs.length; offset += 100) {
        const batch = nodeTaskIDs.slice(offset, offset + 100)
        taskIntegrations.push(
          ...db
            .query<TaskPrerequisiteIntegrationRow, [string, ...string[]]>(
              `SELECT p.id AS plan_id,n.task_id,p.project_directory,n.state AS node_state,
                 n.artifact,
                 (SELECT tr.id FROM runner_transitions tr
                  WHERE tr.plan_id=n.plan_id AND tr.task_id=n.task_id
                    AND tr.event='TASK_INTEGRATION_RECORDED' ORDER BY tr.id DESC LIMIT 1) AS integration_id,
                 (SELECT tr.payload FROM runner_transitions tr
                  WHERE tr.plan_id=n.plan_id AND tr.task_id=n.task_id
                    AND tr.event='TASK_INTEGRATION_RECORDED' ORDER BY tr.id DESC LIMIT 1) AS integration_payload
               FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
               WHERE p.project_directory=? AND n.task_id IN (${batch.map(() => "?").join(",")})`,
            )
            .all(directory, ...batch),
        )
      }

      const planInputs = plans.flatMap((plan) => {
        try {
          const parsed = PlanInput.safeParse(JSON.parse(plan.body))
          return parsed.success ? [parsed.data] : []
        } catch {
          return []
        }
      })
      const prerequisiteIDs = [
        ...new Set([
          ...planInputs.flatMap((plan) => plan.afterPlans ?? []),
          ...plans.flatMap((plan) => JSON.parse(plan.pause_until_plans ?? "[]") as string[]),
        ]),
      ]
      const prerequisiteLimit = 10_000
      const selectedPrerequisites = prerequisiteIDs.slice(0, prerequisiteLimit)
      const planIntegrations: PrerequisiteIntegrationRow[] = []
      for (let offset = 0; offset < selectedPrerequisites.length; offset += 100) {
        const batch = selectedPrerequisites.slice(offset, offset + 100)
        planIntegrations.push(
          ...db
            .query<PrerequisiteIntegrationRow, [string, ...string[]]>(
              `SELECT p.id AS plan_id,p.project_directory,p.state,p.reason,p.artifact,
                 accepted.id AS accepted_id,accepted.version AS accepted_version,
                 accepted.payload AS accepted_payload,
                 integration.id AS integration_id,integration.version AS integration_version,
                 integration.payload AS integration_payload,
                 (SELECT tr.id FROM runner_transitions tr
                  WHERE tr.plan_id=p.id AND tr.task_id IS NULL AND tr.event='CANCEL_REQUESTED'
                  ORDER BY tr.id DESC LIMIT 1) AS invalidation_id
               FROM runner_plans p
               LEFT JOIN runner_transitions accepted ON accepted.id=(
                 SELECT tr.id FROM runner_transitions tr
                 WHERE tr.plan_id=p.id AND tr.task_id IS NULL AND tr.event='PLAN_ACCEPTED'
                 ORDER BY tr.id DESC LIMIT 1
               )
               LEFT JOIN runner_transitions integration ON integration.id=(
                 SELECT tr.id FROM runner_transitions tr
                 WHERE tr.plan_id=p.id AND tr.task_id IS NULL AND tr.event='INTEGRATION_RECORDED'
                 ORDER BY tr.id DESC LIMIT 1
               )
               WHERE p.project_directory=? AND p.id IN (${batch.map(() => "?").join(",")})
               ORDER BY p.id`,
            )
            .all(directory, ...batch),
        )
      }
      return {
        projectDirectory: directory,
        repositoryVersion,
        ...(scopedAssociations ? { sessionAssociations: scopedAssociations } : {}),
        plans,
        totalPlanCount,
        plansComplete: plans.length === totalPlanCount,
        totalNodeCount,
        nodes,
        nodesComplete: nodes.length === coveredPlanNodeCount,
        coveredPlanNodeCount,
        dependencies,
        reservations,
        totalReservationCount,
        reservationsComplete,
        adoptions,
        totalAdoptionCount,
        adoptionsComplete,
        taskIntegrations,
        planIntegrations,
        planIntegrationsComplete: prerequisiteIDs.length <= prerequisiteLimit,
      }
    })
  }
  progressFacts(attemptIDs: readonly string[], limit = 10_001): ProgressRow[] {
    if (!attemptIDs.length) return []
    const bounded = Math.max(1, Math.min(limit, 10_001))
    const placeholders = attemptIDs.map(() => "?").join(",")
    return this.read((db) =>
      db
        .query<ProgressRow, [string, ...string[], number]>(
          `SELECT * FROM (
             SELECT * FROM runner_progress WHERE project_directory=?
               AND attempt_id IN (${placeholders}) ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq`,
        )
        .all(this.repository.projectDirectory, ...attemptIDs, bounded),
    )
  }
  effects(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE plan_id=? ORDER BY rowid")
        .all(planID),
    )
  }
  adoption(id: string): AdoptionRow | undefined {
    return this.read(
      (db) =>
        db
          .query<AdoptionRow, [string, string]>(
            `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
           WHERE a.id=? AND p.project_directory=?`,
          )
          .get(id, this.repository.projectDirectory) ?? undefined,
    )
  }
  adoptions(planID: string): AdoptionRow[] {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.read((db) =>
      db
        .query<AdoptionRow, [string]>(
          "SELECT * FROM runner_adoptions WHERE plan_id=? ORDER BY created_at,id",
        )
        .all(planID),
    )
  }
  activeAdoptions(planID?: string): AdoptionRow[] {
    return this.read((db) =>
      planID
        ? db
            .query<AdoptionRow, [string, string]>(
              `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=? AND a.plan_id=?
                 AND a.state IN ('pending','task-checks','combined-checks')
               ORDER BY a.created_at,a.id`,
            )
            .all(this.repository.projectDirectory, planID)
        : db
            .query<AdoptionRow, [string]>(
              `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=?
                 AND a.state IN ('pending','task-checks','combined-checks')
               ORDER BY a.created_at,a.id`,
            )
            .all(this.repository.projectDirectory),
    )
  }
  activeAdoptionForTask(planID: string, taskID: string): AdoptionRow | undefined {
    return this.read(
      (db) =>
        db
          .query<AdoptionRow, [string, string]>(
            `SELECT * FROM runner_adoptions WHERE plan_id=? AND task_id=?
           AND state IN ('pending','task-checks','combined-checks')
           ORDER BY created_at DESC LIMIT 1`,
          )
          .get(planID, taskID) ?? undefined,
    )
  }
  createAdoption(input: {
    id: string
    planID: string
    taskID: string
    writeScope: string[]
    requestID: string
    owner: string
    expectedVersion: number
    taskRevision: number
    attemptID: string
    nodeState: string
    attemptState: string
    oldArtifact: string
    descendantCommit: string
    targetBranch: string
    landingHead: string
    reviewedBaseline: string
    candidateTree: string
    inputFingerprint: string
    environmentIdentity: string
    reason: string
    combinedArtifact: string
  }): AdoptionRow {
    return this.atomic((db) => {
      if (this.activeAdoptions(input.planID).length)
        throw new Error("A descendant adoption is already pending for this plan")
      const activeAttempts = db
        .query<{ id: string; task_id: string; workspace: string }, [string]>(
          `SELECT a.id,a.task_id,a.workspace FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
           WHERE p.project_directory=? AND a.state IN ('preparing','running','verifying')`,
        )
        .all(this.repository.projectDirectory)
      if (
        activeAttempts.some(
          (attempt) =>
            attempt.workspace === this.repository.projectDirectory ||
            scopePatternsConflict(
              input.writeScope,
              this.effectiveReservationScope(attempt.task_id),
            ),
        )
      )
        throw new Error("A conflicting worker prevents descendant adoption")
      if (
        this.activeAdoptions().some((adoption) =>
          scopePatternsConflict(input.writeScope, this.effectiveReservationScope(adoption.task_id)),
        )
      )
        throw new Error("An active descendant reservation conflicts with this task scope")
      const now = Date.now()
      const changed = db
        .query(
          `UPDATE runner_plans SET version=version+1 WHERE id=? AND project_directory=?
           AND owner=? AND version=? AND state='blocked'`,
        )
        .run(
          input.planID,
          this.repository.projectDirectory,
          input.owner,
          input.expectedVersion,
        ).changes
      if (changed !== 1) throw new Error("Stale plan version or plan is no longer blocked")
      db.query(
        `INSERT INTO runner_adoptions(
          id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,node_state,attempt_state,
          old_artifact,descendant_commit,target_branch,landing_head,reviewed_baseline,candidate_tree,
          input_fingerprint,environment_identity,reason,combined_artifact,task_workspace,combined_workspace,
          state,hold_reason,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'pending',NULL,?,?)`,
      ).run(
        input.id,
        input.planID,
        input.taskID,
        input.requestID,
        input.owner,
        input.expectedVersion,
        input.taskRevision,
        input.attemptID,
        input.nodeState,
        input.attemptState,
        input.oldArtifact,
        input.descendantCommit,
        input.targetBranch,
        input.landingHead,
        input.reviewedBaseline,
        input.candidateTree,
        input.inputFingerprint,
        input.environmentIdentity,
        input.reason,
        input.combinedArtifact,
        now,
        now,
      )
      this.record(input.planID, input.taskID, "DESCENDANT_ADOPTION_REQUESTED", {
        adoptionID: input.id,
        attemptID: input.attemptID,
        oldArtifact: input.oldArtifact,
        descendantCommit: input.descendantCommit,
        targetBranch: input.targetBranch,
        landingHead: input.landingHead,
        reviewedBaseline: input.reviewedBaseline,
        reason: input.reason,
      })
      this.repository.changed()
      return db
        .query<AdoptionRow, [string]>("SELECT * FROM runner_adoptions WHERE id=?")
        .get(input.id)!
    })
  }
  setAdoptionState(
    id: string,
    state: string,
    holdReason: string | null,
    fence?: { owner: string; value: number },
  ) {
    return this.atomic((db) => {
      if (fence) {
        const lease = db
          .query<{ owner: string; fence: number }, [string]>(
            "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
          )
          .get(this.repository.projectDirectory)
        if (lease?.owner !== fence.owner || lease.fence !== fence.value)
          throw new Error("Stale scheduler fence")
      }
      const changed = db
        .query(
          `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,?),hold_reason=?,updated_at=? WHERE id=?
           AND state IN ('pending','task-checks','combined-checks')`,
        )
        .run(state, holdReason, Date.now(), id).changes
      if (changed) this.repository.changed()
      return changed === 1
    })
  }
  setAdoptionWorkspace(
    id: string,
    phase: "task" | "combined",
    workspace: string,
    fence: { owner: string; value: number },
  ) {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== fence.owner || lease.fence !== fence.value)
        throw new Error("Stale scheduler fence")
      const column = phase === "task" ? "task_workspace" : "combined_workspace"
      db.query(`UPDATE runner_adoptions SET ${column}=?,updated_at=? WHERE id=?`).run(
        workspace,
        Date.now(),
        id,
      )
      this.repository.changed()
    })
  }
  adoptionChecks(adoptionID: string, phase?: "task" | "combined"): AdoptionCheckRow[] {
    return this.read((db) =>
      phase
        ? db
            .query<AdoptionCheckRow, [string, string]>(
              "SELECT * FROM runner_adoption_checks WHERE adoption_id=? AND phase=? ORDER BY created_at,check_id",
            )
            .all(adoptionID, phase)
        : db
            .query<AdoptionCheckRow, [string]>(
              "SELECT * FROM runner_adoption_checks WHERE adoption_id=? ORDER BY created_at,phase,check_id",
            )
            .all(adoptionID),
    )
  }
  beginAdoptionCheck(input: {
    adoptionID: string
    phase: "task" | "combined"
    checkID: string
    check: unknown
    workspace: string
    artifact: string
    inputFingerprint: string
    environmentIdentity: string
    receiptPath: string
    fence: { owner: string; value: number }
  }): AdoptionCheckRow {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== input.fence.owner || lease.fence !== input.fence.value)
        throw new Error("Stale scheduler fence")
      const existing = db
        .query<AdoptionCheckRow, [string, string, string]>(
          "SELECT * FROM runner_adoption_checks WHERE adoption_id=? AND phase=? AND check_id=?",
        )
        .get(input.adoptionID, input.phase, input.checkID)
      if (existing) return existing
      const now = Date.now()
      db.query(
        `INSERT INTO runner_adoption_checks(
          adoption_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
          environment_identity,receipt_path,state,receipt,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'intended',NULL,?)`,
      ).run(
        input.adoptionID,
        input.phase,
        input.checkID,
        JSON.stringify(input.check),
        input.workspace,
        input.artifact,
        input.inputFingerprint,
        input.environmentIdentity,
        input.receiptPath,
        now,
      )
      this.repository.changed()
      return db
        .query<AdoptionCheckRow, [string, string, string]>(
          "SELECT * FROM runner_adoption_checks WHERE adoption_id=? AND phase=? AND check_id=?",
        )
        .get(input.adoptionID, input.phase, input.checkID)!
    })
  }
  completeAdoptionCheck(
    adoptionID: string,
    phase: string,
    checkID: string,
    receipt: unknown,
    fence: { owner: string; value: number },
  ) {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== fence.owner || lease.fence !== fence.value)
        throw new Error("Stale scheduler fence")
      const changed = db
        .query(
          `UPDATE runner_adoption_checks SET state=lz_runner_transition('check',state,'completed'),receipt=?
           WHERE adoption_id=? AND phase=? AND check_id=? AND state IN ('intended','uncertain')`,
        )
        .run(JSON.stringify(receipt), adoptionID, phase, checkID).changes
      if (changed) this.repository.changed()
      return changed === 1
    })
  }
  markAdoptionCheckUncertain(
    adoptionID: string,
    phase: string,
    checkID: string,
    reason: string,
    fence: { owner: string; value: number },
  ) {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== fence.owner || lease.fence !== fence.value)
        throw new Error("Stale scheduler fence")
      const changed = db
        .query(
          `UPDATE runner_adoption_checks SET state=lz_runner_transition('check',state,'uncertain'),receipt=?
           WHERE adoption_id=? AND phase=? AND check_id=? AND state='intended'`,
        )
        .run(JSON.stringify({ error: reason }), adoptionID, phase, checkID).changes
      if (changed) this.repository.changed()
      return changed === 1
    })
  }
  /**
   * Stable reference for a commit in a fingerprint: its tree OID from recorded
   * identity, else from Git, else the SHA itself (marked, so it never collides
   * with a tree). A rewrite changes the SHA but never the tree.
   */
  treeRef(sha: string | null | undefined): string | null {
    if (!sha) return null
    // A commit's tree never changes, so resolved values are cached for the process.
    const cached = this.treeRefs.get(sha)
    if (cached) return cached
    const known = this.repository.read((db) => knownTree(db, sha))
    let resolved: string
    if (known) resolved = `tree:${known}`
    else
      try {
        resolved = `tree:${git(this.repository.projectDirectory, ["rev-parse", "--verify", `${sha}^{tree}`])}`
      } catch {
        return `sha:${sha}`
      }
    this.treeRefs.set(sha, resolved)
    return resolved
  }
  private readonly treeRefs = new Map<string, string>()
  /** A plan body with its baseCommit replaced by the baseline tree reference. */
  planBodyIdentity(body: string): unknown {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      return typeof parsed.baseCommit === "string"
        ? { ...parsed, baseCommit: this.treeRef(parsed.baseCommit) }
        : parsed
    } catch {
      return body
    }
  }
  /** Equal artifact SHAs, or SHAs recorded with the same tree OID. */
  sameArtifact(left: string | null | undefined, right: string | null | undefined): boolean {
    return this.repository.read((db) => sameArtifact(db, left, right))
  }
  cancelAdoptions(planID: string, reason: string) {
    return this.atomic((db) => {
      const changed = db
        .query(
          `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'cancelled'),hold_reason=?,updated_at=?
           WHERE plan_id=? AND state IN ('pending','task-checks','combined-checks')`,
        )
        .run(reason, Date.now(), planID).changes
      if (changed) this.repository.changed()
      return changed
    })
  }
  /**
   * Plan detail with bounded history. `activity`, `evidence` and `delivery` hold the
   * newest `limit` rows in ascending order; `paging.<name>.next` is the cursor to pass as
   * `<name>Before` for the next older page (null when exhausted).
   */
  detail(planID: string, page: DetailPage = {}) {
    const limit = Math.max(1, Math.min(page.limit ?? DETAIL_PAGE_LIMIT, 1000))
    const plan = this.plan(planID)
    if (!plan) throw new Error("Plan not found")
    return this.read((db) => {
      const newest = (table: string, key: string, before: number | undefined) => {
        const rows = db
          .query(
            `SELECT *,${key} AS __k FROM ${table} WHERE plan_id=? AND ${key}<? ORDER BY ${key} DESC LIMIT ?`,
          )
          .all(planID, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as any[] // eslint-disable-line @typescript-eslint/no-explicit-any
        const more = rows.length > limit
        const kept = (more ? rows.slice(0, limit) : rows).reverse()
        const next = more ? (kept[0]!.__k as number) : null
        for (const row of kept) delete (row as { __k?: number }).__k
        return { rows: kept, paging: { next, returned: kept.length } }
      }
      const activity = newest("runner_transitions", "id", page.activityBefore)
      const evidence = newest("runner_evidence", "rowid", page.evidenceBefore)
      const delivery = newest("runner_outbox", "rowid", page.deliveryBefore)
      return {
        plan,
        nodes: this.nodes(planID),
        attempts: this.attempts(planID),
        effects: this.effects(planID),
        adoptions: this.adoptions(planID),
        adoptionChecks: this.read((db) =>
          db
            .query(
              `SELECT c.* FROM runner_adoption_checks c JOIN runner_adoptions a ON a.id=c.adoption_id
             WHERE a.plan_id=? ORDER BY c.created_at,c.phase,c.check_id`,
            )
            .all(planID),
        ),
        adoptionEvidence: this.read((db) =>
          db
            .query(
              `SELECT e.* FROM runner_adoption_evidence e JOIN runner_adoptions a ON a.id=e.adoption_id
             WHERE a.plan_id=? ORDER BY e.created_at,e.id`,
            )
            .all(planID),
        ),
        evidence: evidence.rows,
        activity: activity.rows,
        verificationTimeoutAmendments: this.verificationTimeoutAmendments(planID),
        delivery: delivery.rows.map((row: OutboxRow) => ({
          ...row,
          // One explicit read of the entries for display, shaped as the old history document.
          receipt: row.receipt_count
            ? JSON.stringify({ history: this.outboxReceipts(row.id) })
            : null,
        })),
        paging: {
          limit,
          activity: activity.paging,
          evidence: evidence.paging,
          delivery: delivery.paging,
        },
      }
    })
  }
}
