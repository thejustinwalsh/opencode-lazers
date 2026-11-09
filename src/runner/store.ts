import { ensureObservationRevision } from "../observability/source-revision.ts"
import type { Database } from "bun:sqlite"
import { fingerprint } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"
import { TaskProposalSchema } from "../task.ts"
import { RecoveryJournal } from "../recovery/journal.ts"
import { scopePatternsConflict } from "./artifacts.ts"
import { initialSnapshot, machineVersion, transition } from "./machine.ts"
import { PlanInput } from "./schema.ts"
import type { Execution, Finding, TaskState } from "./schema.ts"
import type { ArchitectSourceResult } from "./host.ts"
import { readSourceJournalPage } from "./source-journal.ts"
import type { SourceJournalPage } from "./source-journal.ts"
import { parseOutcomeOwnership } from "./inbox.ts"

export type PlanRow = {
  id: string
  owner: string
  revision: number
  version: number
  state: string
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
  state: string
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
  state: string
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
export type AdoptionEvidenceRow = {
  id: string
  adoption_id: string
  task_id: string | null
  phase: "task" | "combined" | "legacy"
  assertion_id: string
  artifact: string
  body: string
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
export type ArchitectContinuityRow = {
  project_directory: string
  session_id: string
  revision: number
  decisions: string
  unresolved_questions: string
  updated_at: number
}
export type ArchitectRenewalPlanRow = {
  renewal_id: string
  plan_id: string
  prior_continuation: string | null
}
export type ArchitectSourceResultRow = {
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
export type ArchitectSourceRow = {
  session_id: string
  renewal_id: string
  anchor_plan_id: string
  scan_cursor: string | null
  scan_sweep: number
  revision: number
  state: string
  updated_at: number
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
  version: number
  sequence: number
}

export type ArchitectSourceNoticeTarget = {
  owner: string
  planID: string
  planIDs: string[]
}

type ArchitectSourceNoticeSource = Pick<
  ArchitectSourceRow,
  "session_id" | "renewal_id" | "revision"
>

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

function architectSourceNoticeTargets(
  db: Database,
  projectDirectory: string,
  renewalID: string,
): ArchitectSourceNoticeTarget[] {
  const plans = db
    .query<{ plan_id: string; owner: string }, [string, string]>(
      `SELECT p.id AS plan_id,p.owner
       FROM runner_architect_renewal_plans rp
       JOIN runner_plans p ON p.id=rp.plan_id
       JOIN runner_architect_renewals r ON r.id=rp.renewal_id
       WHERE rp.renewal_id=? AND rp.transferred=1 AND p.project_directory=?
         AND r.state IN ('archiving','committed')
       ORDER BY p.owner,p.id`,
    )
    .all(renewalID, projectDirectory)
  const targets = new Map<string, ArchitectSourceNoticeTarget>()
  for (const plan of plans) {
    const target = targets.get(plan.owner)
    if (target) {
      target.planIDs.push(plan.plan_id)
      continue
    }
    targets.set(plan.owner, {
      owner: plan.owner,
      planID: plan.plan_id,
      planIDs: [plan.plan_id],
    })
  }
  return [...targets.values()]
}

function ensureArchitectSourceChangeNotices(
  db: Database,
  input: {
    projectDirectory: string
    projectID: string
    source: ArchitectSourceNoticeSource
  },
) {
  const targets = architectSourceNoticeTargets(db, input.projectDirectory, input.source.renewal_id)
  const notices: Array<{ id: string; sessionID: string; planIDs: string[] }> = []
  const created: Array<{ id: string; sessionID: string; planIDs: string[] }> = []
  for (const target of targets) {
    const latest = db
      .query<
        { id: string; payload: string; state: string; receipt: string | null },
        [string, string, string]
      >(
        `SELECT o.id,o.payload,o.state,o.receipt FROM runner_outbox o
         JOIN runner_plans p ON p.id=o.plan_id
         WHERE p.project_directory=? AND o.session_id=?
           AND json_extract(o.payload,'$.status')='architect-source-change'
           AND json_extract(o.payload,'$.sourceSessionID')=?
         ORDER BY o.rowid DESC LIMIT 1`,
      )
      .get(input.projectDirectory, target.owner, input.source.session_id)
    let latestRevision = -1
    if (latest) {
      try {
        const payload = JSON.parse(latest.payload) as { sourceRevision?: unknown }
        if (Number.isSafeInteger(payload.sourceRevision))
          latestRevision = payload.sourceRevision as number
      } catch {
        // A corrupt prior notice is not coverage. Preserve it and issue a fresh pointer.
      }
    }
    const pendingStale =
      latest?.state === "pending" && latestRevision >= 0 && latestRevision < input.source.revision
    if (pendingStale) {
      const receipt = appendOutboxReceipt(latest.receipt ?? null, {
        kind: "source-change-pointer-superseded-before-native-admission",
        previousSourceRevision: latestRevision,
        currentSourceRevision: input.source.revision,
      })
      db.query(
        "UPDATE runner_outbox SET state='superseded',receipt=? WHERE id=? AND state='pending'",
      ).run(receipt, latest.id)
    }
    const unresolved = latest && !pendingStale && !["consumed", "superseded"].includes(latest.state)
    const alreadyCovered = latest?.state === "consumed" && latestRevision >= input.source.revision
    if (unresolved || alreadyCovered) {
      notices.push({ id: latest.id, sessionID: target.owner, planIDs: target.planIDs })
      continue
    }

    const id = fingerprint({
      kind: "architect-source-change",
      sourceSessionID: input.source.session_id,
      owner: target.owner,
      sourceRevision: input.source.revision,
    })
    const messageID = `msg_${fingerprint({ outboxID: id, owner: target.owner }).slice(0, 32)}`
    const payload = {
      status: "architect-source-change",
      version: input.source.revision,
      sourceSessionID: input.source.session_id,
      sourceRevision: input.source.revision,
      planID: target.planID,
      planIDs: target.planIDs,
      preserveOriginalInput: true,
    }
    const metadata = {
      lazersKind: "runner-outcome",
      lazersProjectID: input.projectID,
      lazersProjectDirectory: input.projectDirectory,
      lazersPlanID: target.planID,
      lazersOutboxID: id,
      lazersMessageID: messageID,
      lazersSessionID: target.owner,
      lazersStatus: "architect-source-change",
      lazersVersion: input.source.revision,
    }
    const inserted = db
      .query(
        `INSERT OR IGNORE INTO runner_outbox(
        id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
      ) VALUES(?,?,?,?,?,'pending',0,?,NULL)`,
      )
      .run(
        id,
        target.planID,
        target.owner,
        messageID,
        JSON.stringify(payload),
        JSON.stringify(metadata),
      ).changes
    notices.push({ id, sessionID: target.owner, planIDs: target.planIDs })
    if (inserted) created.push({ id, sessionID: target.owner, planIDs: target.planIDs })
  }
  return { targets, notices, created }
}

function hasArchitectSourceReferenceOwnership(
  row: OutboxRow,
  sourceSessionID: string,
  projectID: string,
  projectDirectory: string,
) {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const ownership = parseOutcomeOwnership(row.metadata ? JSON.parse(row.metadata) : null)
    return Boolean(
      payload.status === "architect-source-reference" &&
      payload.sourceSessionID === sourceSessionID &&
      ownership &&
      ownership.lazersProjectID === projectID &&
      ownership.lazersProjectDirectory === projectDirectory &&
      ownership.lazersPlanID === row.plan_id &&
      ownership.lazersOutboxID === row.id &&
      ownership.lazersMessageID === row.message_id &&
      ownership.lazersSessionID === row.session_id &&
      ownership.lazersStatus === payload.status &&
      ownership.lazersVersion === payload.version,
    )
  } catch {
    return false
  }
}

function sourceNoticeClaimMatches(receipt: string | null, claimID: string) {
  if (!receipt) return false
  try {
    const parsed = JSON.parse(receipt) as { history?: unknown[] }
    const claim = parsed.history?.toReversed().find((entry) => {
      const candidate = entry as { kind?: unknown }
      return candidate.kind === "source-notice-reconciliation-claimed"
    }) as { kind?: unknown; claimID?: unknown } | undefined
    return claim?.kind === "source-notice-reconciliation-claimed" && claim.claimID === claimID
  } catch {
    return false
  }
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

export function appendOutboxReceipt(previous: string | null, next: unknown) {
  let history: unknown[] = []
  if (previous) {
    const parsed: unknown = JSON.parse(previous)
    history =
      typeof parsed === "object" &&
      parsed !== null &&
      "history" in parsed &&
      Array.isArray(parsed.history)
        ? parsed.history
        : [parsed]
  }
  history.push(next)
  return JSON.stringify({ history })
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

export class RunnerStore {
  constructor(readonly repository: TaskRepository) {
    repository.atomic((db) => {
      // F-S4-1: preserve historical conflict scans under their actual domain name.
      if (
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_audits'").get()
      ) {
        if (
          db
            .query(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_conflict_scans'",
            )
            .get()
        )
          db.exec(`INSERT OR IGNORE INTO runner_conflict_scans SELECT * FROM runner_audits;
                   DROP TABLE runner_audits`)
        else db.exec("ALTER TABLE runner_audits RENAME TO runner_conflict_scans")
      }
      db.exec(`
      CREATE TABLE IF NOT EXISTS runner_plans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT
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
      CREATE TABLE IF NOT EXISTS runner_source_quarantines (
        attempt_id TEXT PRIMARY KEY REFERENCES runner_attempts(id),
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), session_id TEXT NOT NULL UNIQUE,
        assigned_message_id TEXT NOT NULL, requested_owner TEXT NOT NULL,
        workspace TEXT NOT NULL, request_id TEXT NOT NULL, reason TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('pending','sealed')), hold_reason TEXT, review_input_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_source_quarantines_pending
        ON runner_source_quarantines(plan_id,created_at) WHERE phase='pending';
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
        metadata TEXT, receipt TEXT
      );
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
        state TEXT NOT NULL, updated_at INTEGER NOT NULL
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
      const quarantineColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(runner_source_quarantines)")
        .all()
      if (!quarantineColumns.some((column) => column.name === "review_input_json"))
        db.exec("ALTER TABLE runner_source_quarantines ADD COLUMN review_input_json TEXT")
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
      const renewalColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(runner_architect_renewals)")
        .all()
        .map((column) => column.name)
      if (!renewalColumns.includes("continuity_json"))
        db.exec("ALTER TABLE runner_architect_renewals ADD COLUMN continuity_json TEXT")
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
      // Version-1 delivered meant native admission, never proven model consumption.
      db.query(
        "UPDATE runner_outbox SET state='admitted',receipt=COALESCE(receipt,?) WHERE state='delivered'",
      ).run(JSON.stringify({ kind: "legacy-host-admitted", consumption: "unknown" }))
      ensureObservationRevision(db)
      ensureArchitectSourceJournalRevisions(db)
    })
    new RecoveryJournal(repository)
  }
  atomic<T>(run: (db: Database) => T): T {
    return this.repository.atomic(run)
  }
  plan(id: string) {
    return this.atomic((db) =>
      db
        .query<PlanRow, [string, string]>(
          "SELECT * FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(id, this.repository.projectDirectory),
    )
  }
  nodes(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
      db
        .query<NodeRow, [string]>("SELECT * FROM runner_nodes WHERE plan_id=? ORDER BY ordinal")
        .all(planID),
    )
  }
  plans() {
    return this.atomic((db) =>
      db
        .query<PlanRow, [string]>(
          "SELECT * FROM runner_plans WHERE project_directory=? ORDER BY COALESCE(json_extract(body, '$.priority'),0) DESC,rowid LIMIT 1000",
        )
        .all(this.repository.projectDirectory),
    )
  }
  /** Page execution candidates after filtering history; never use the display window for scheduling. */
  *runnablePlans(terminalStates: ReadonlySet<string>): Generator<PlanRow> {
    type Candidate = PlanRow & { queue_rank: number; priority: number; sequence: number }
    const states = [...terminalStates]
    let cursor: Candidate | undefined
    for (;;) {
      const page: Candidate[] = this.atomic((db) =>
        db
          .query<Candidate, (string | number)[]>(
            `SELECT *,CASE WHEN state='cancelling' THEN 1 ELSE 0 END AS queue_rank,
           COALESCE(json_extract(body,'$.priority'),0) AS priority,rowid AS sequence
           FROM runner_plans WHERE project_directory=?
           ${states.length ? `AND state NOT IN (${states.map(() => "?").join(",")})` : ""}
           ${cursor ? "AND (CASE WHEN state='cancelling' THEN 1 ELSE 0 END,COALESCE(json_extract(body,'$.priority'),0),-rowid) < (?,?,?)" : ""}
           ORDER BY queue_rank DESC,priority DESC,rowid LIMIT 1000`,
          )
          .all(
            this.repository.projectDirectory,
            ...states,
            ...(cursor ? [cursor.queue_rank, cursor.priority, -cursor.sequence] : []),
          ),
      )
      yield* page
      if (page.length < 1000) return
      cursor = page.at(-1)!
    }
  }
  /** A transitive dependent with execution history prevents rewriting its prerequisite. */
  startedDependentPlan(planID: string): PlanRow | null {
    return this.atomic((db) =>
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
  continuation(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
      db
        .query<ContinuationRow, [string]>("SELECT * FROM runner_continuations WHERE plan_id=?")
        .get(planID),
    )
  }
  architectRenewal(id: string) {
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
    return this.atomic((db) => {
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
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
    return this.atomic((db) =>
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
  architectSource(sessionID: string) {
    return this.atomic((db) =>
      db
        .query<ArchitectSourceRow, [string, string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND anchor.project_directory=?`,
        )
        .get(sessionID, this.repository.projectDirectory),
    )
  }
  architectSourceNoticeTargets(sessionID: string) {
    return this.atomic((db) => {
      const source = db
        .query<{ renewal_id: string }, [string, string]>(
          `SELECT s.renewal_id FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND anchor.project_directory=?`,
        )
        .get(sessionID, this.repository.projectDirectory)
      return source
        ? architectSourceNoticeTargets(db, this.repository.projectDirectory, source.renewal_id)
        : []
    })
  }
  architectSourceNoticeRows(sessionID: string) {
    return this.atomic((db) =>
      db
        .query<OutboxRow, [string, string]>(
          `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
             o.rowid AS sequence
           FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
           WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
             AND json_extract(o.payload,'$.status') IN (
               'architect-source-reference','architect-source-change'
             )
           ORDER BY o.rowid`,
        )
        .all(this.repository.projectDirectory, sessionID),
    )
  }
  architectCurrentSourceChangeNoticeRows(sessionID: string) {
    return this.atomic((db) => {
      const source = db
        .query<{ renewal_id: string }, [string, string]>(
          `SELECT s.renewal_id FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND s.state='active' AND anchor.project_directory=?`,
        )
        .get(sessionID, this.repository.projectDirectory)
      if (!source) return []
      const targets = architectSourceNoticeTargets(
        db,
        this.repository.projectDirectory,
        source.renewal_id,
      )
      const rows: OutboxRow[] = []
      for (const target of targets) {
        // Return just the newest pointer for each current owner. Historical source
        // payloads stay in SQLite and are not copied into the runtime.
        const row = db
          .query<OutboxRow, [string, string, string, string, string]>(
            `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
               o.rowid AS sequence
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE p.project_directory=? AND p.owner=? AND o.session_id=?
               AND json_extract(o.payload,'$.sourceSessionID')=?
               AND json_extract(o.payload,'$.status')='architect-source-change'
               AND EXISTS(
                 SELECT 1 FROM runner_architect_renewal_plans rp
                 JOIN runner_architect_renewals r ON r.id=rp.renewal_id
                 WHERE rp.plan_id=o.plan_id AND rp.renewal_id=? AND rp.transferred=1
                   AND r.state IN ('archiving','committed')
               )
             ORDER BY o.rowid DESC LIMIT 1`,
          )
          .get(
            this.repository.projectDirectory,
            target.owner,
            target.owner,
            sessionID,
            source.renewal_id,
          )
        if (row) rows.push(row)
      }
      return rows
    })
  }
  architectSourceChangeNoticeRowsByIDs(
    sourceSessionID: string,
    notices: Array<{ id: string; sessionID: string }>,
  ) {
    return this.atomic((db) => {
      if (!notices.length) return []
      const source = db
        .query<Pick<ArchitectSourceRow, "renewal_id">, [string, string]>(
          `SELECT s.renewal_id FROM runner_architect_sources s
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND s.state='active' AND anchor.project_directory=?`,
        )
        .get(sourceSessionID, this.repository.projectDirectory)
      if (!source) return []
      const currentOwners = new Set(
        architectSourceNoticeTargets(db, this.repository.projectDirectory, source.renewal_id).map(
          (target) => target.owner,
        ),
      )
      const rows: OutboxRow[] = []
      for (const notice of notices) {
        if (!currentOwners.has(notice.sessionID)) continue
        // IDs originate from ensureArchitectSourceChangeNotices. Constrain every
        // lookup by that exact ID, source, project and current native owner.
        const row = db
          .query<OutboxRow, [string, string, string, string, string, string]>(
            `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
               o.rowid AS sequence
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE o.id=? AND p.project_directory=? AND p.owner=? AND o.session_id=?
               AND json_extract(o.payload,'$.sourceSessionID')=?
               AND json_extract(o.payload,'$.status')='architect-source-change'
               AND EXISTS(
                 SELECT 1 FROM runner_architect_renewal_plans rp
                 JOIN runner_architect_renewals r ON r.id=rp.renewal_id
                 WHERE rp.plan_id=o.plan_id AND rp.renewal_id=? AND rp.transferred=1
                   AND r.state IN ('archiving','committed')
               )`,
          )
          .get(
            notice.id,
            this.repository.projectDirectory,
            notice.sessionID,
            notice.sessionID,
            sourceSessionID,
            source.renewal_id,
          )
        if (row) rows.push(row)
      }
      return rows
    })
  }
  architectLegacySourceNoticePage(sessionID: string, limit = 20) {
    const boundedLimit = Math.min(20, Math.max(1, Math.floor(limit)))
    return this.atomic((db) => ({
      rows: db
        .query<OutboxRow, [string, string, number]>(
          `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
             o.rowid AS sequence
           FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
           WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
             AND json_extract(o.payload,'$.status')='architect-source-reference'
             AND o.state NOT IN ('consumed','superseded')
           ORDER BY o.rowid LIMIT ?`,
        )
        .all(this.repository.projectDirectory, sessionID, boundedLimit),
      total: db
        .query<{ total: number }, [string, string]>(
          `SELECT COUNT(*) AS total FROM runner_outbox o
           JOIN runner_plans p ON p.id=o.plan_id
           WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
             AND json_extract(o.payload,'$.status')='architect-source-reference'
             AND o.state NOT IN ('consumed','superseded')`,
        )
        .get(this.repository.projectDirectory, sessionID)!.total,
    }))
  }
  architectSourceNoticeContext(input: {
    planID: string
    sourceSessionID: string
    expectedOwner: string
    expectedPlanVersion: number
  }) {
    return this.atomic((db) => {
      const plan = db
        .query<{ owner: string; version: number }, [string, string]>(
          "SELECT owner,version FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(input.planID, this.repository.projectDirectory)
      if (!plan || plan.owner !== input.expectedOwner || plan.version !== input.expectedPlanVersion)
        return null
      const source = db
        .query<ArchitectSourceRow, [string, string, string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_architect_renewal_plans rp ON rp.renewal_id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND rp.plan_id=? AND rp.transferred=1
             AND s.state='active' AND anchor.project_directory=?`,
        )
        .get(input.sourceSessionID, input.planID, this.repository.projectDirectory)
      if (!source) return null
      const targets = architectSourceNoticeTargets(
        db,
        this.repository.projectDirectory,
        source.renewal_id,
      )
      return targets.some((target) => target.owner === input.expectedOwner)
        ? { sourceRevision: source.revision, targets }
        : null
    })
  }
  ensureArchitectSourceChangeNotices(input: {
    planID: string
    sourceSessionID: string
    expectedOwner: string
    expectedPlanVersion: number
    projectID: string
  }) {
    return this.atomic((db) => {
      const plan = db
        .query<{ owner: string; version: number }, [string, string]>(
          "SELECT owner,version FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(input.planID, this.repository.projectDirectory)
      if (!plan || plan.owner !== input.expectedOwner || plan.version !== input.expectedPlanVersion)
        throw new Error("Architect source notice owner changed before journal coverage")
      const source = db
        .query<ArchitectSourceRow, [string, string, string]>(
          `SELECT s.* FROM runner_architect_sources s
           JOIN runner_architect_renewal_plans rp ON rp.renewal_id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND rp.plan_id=? AND rp.transferred=1
             AND s.state='active' AND anchor.project_directory=?`,
        )
        .get(input.sourceSessionID, input.planID, this.repository.projectDirectory)
      if (!source) throw new Error("Architect source is not current durable journal for this plan")
      if (!architectSourceJournalExists(db, input.sourceSessionID))
        throw new Error("Architect source has no durable journal records to replace legacy notices")
      const targets = architectSourceNoticeTargets(
        db,
        this.repository.projectDirectory,
        source.renewal_id,
      )
      if (!targets.some((target) => target.owner === input.expectedOwner))
        throw new Error("Architect source notice target is no longer a current plan owner")
      const ensured = ensureArchitectSourceChangeNotices(db, {
        projectDirectory: this.repository.projectDirectory,
        projectID: input.projectID,
        source,
      })
      if (ensured.targets.length) {
        const inputMarkers = db
          .query(
            "UPDATE runner_architect_inputs SET referenced_revision=? WHERE session_id=? AND referenced_revision=0",
          )
          .run(source.revision, source.session_id)
        const resultMarkers = db
          .query(
            "UPDATE runner_architect_source_results SET referenced_revision=? WHERE session_id=? AND referenced_revision=0",
          )
          .run(source.revision, source.session_id)
        if (ensured.created.length || inputMarkers.changes || resultMarkers.changes)
          this.record(source.anchor_plan_id, null, "ARCHITECT_SOURCE_CHANGE_NOTICE_CREATED", {
            sourceSessionID: source.session_id,
            sourceRevision: source.revision,
            requestPlanID: input.planID,
            currentOwners: ensured.targets.map((target) => ({
              sessionID: target.owner,
              planIDs: target.planIDs,
            })),
            outboxIDs: ensured.notices.map((notice) => notice.id),
            createdOutboxIDs: ensured.created.map((notice) => notice.id),
            markedInputCount: inputMarkers.changes,
            markedResultCount: resultMarkers.changes,
          })
        if (ensured.created.length || inputMarkers.changes || resultMarkers.changes)
          this.repository.changed()
      }
      return {
        sourceRevision: source.revision,
        targets: ensured.targets,
        notices: ensured.notices,
      }
    })
  }
  recordArchitectSourceChangeObservation(input: {
    outboxID: string
    expectedState: string
    state: "admitted" | "consumed" | "unknown"
    receipt: unknown
    event: string
  }) {
    return this.atomic((db) => {
      const current = db
        .query<{ plan_id: string; state: string; receipt: string | null }, [string, string]>(
          `SELECT o.plan_id,o.state,o.receipt FROM runner_outbox o
           JOIN runner_plans p ON p.id=o.plan_id
           WHERE o.id=? AND p.project_directory=?
             AND json_extract(o.payload,'$.status')='architect-source-change'`,
        )
        .get(input.outboxID, this.repository.projectDirectory)
      if (!current || current.state !== input.expectedState) return false
      const receipt = appendOutboxReceipt(current.receipt, input.receipt)
      const changed = db
        .query("UPDATE runner_outbox SET state=?,receipt=? WHERE id=? AND state=?")
        .run(input.state, receipt, input.outboxID, input.expectedState).changes
      if (!changed) return false
      this.record(current.plan_id, null, input.event, {
        outboxID: input.outboxID,
        from: current.state,
        to: input.state,
        receipt: input.receipt,
      })
      this.repository.changed()
      return true
    })
  }
  beginArchitectSourceNoticeReconciliation(input: {
    planID: string
    sourceSessionID: string
    expectedOwner: string
    expectedPlanVersion: number
    projectID: string
    outboxID: string
    requestID: string
    claimID: string
  }) {
    return this.atomic((db) => {
      const plan = db
        .query<{ owner: string; version: number }, [string, string]>(
          "SELECT owner,version FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(input.planID, this.repository.projectDirectory)
      if (!plan || plan.owner !== input.expectedOwner || plan.version !== input.expectedPlanVersion)
        throw new Error("Architect source notice owner changed before reconciliation")
      const source = db
        .query<Pick<ArchitectSourceRow, "anchor_plan_id">, [string, string, string]>(
          `SELECT s.anchor_plan_id FROM runner_architect_sources s
           JOIN runner_architect_renewal_plans rp ON rp.renewal_id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND rp.plan_id=? AND rp.transferred=1
             AND s.state='active' AND anchor.project_directory=?`,
        )
        .get(input.sourceSessionID, input.planID, this.repository.projectDirectory)
      if (!source) throw new Error("Architect source is not current durable journal for this plan")
      const row = db
        .query<OutboxRow, [string, string, string, string]>(
          `SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
             o.rowid AS sequence
           FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
           JOIN runner_architect_sources s ON s.session_id=? AND s.anchor_plan_id=o.plan_id
           WHERE o.id=? AND p.project_directory=?
             AND json_extract(o.payload,'$.sourceSessionID')=?
             AND json_extract(o.payload,'$.status')='architect-source-reference'
             AND s.state='active'`,
        )
        .get(
          input.sourceSessionID,
          input.outboxID,
          this.repository.projectDirectory,
          input.sourceSessionID,
        )
      if (!row) return { status: "not-found" as const }
      if (
        !hasArchitectSourceReferenceOwnership(
          row,
          input.sourceSessionID,
          input.projectID,
          this.repository.projectDirectory,
        )
      )
        return { status: "ownership-unavailable" as const, row }
      if (["consumed", "superseded"].includes(row.state))
        return { status: "terminal" as const, row }
      if (
        ![
          "pending",
          "sending",
          "uncertain",
          "admitted",
          "delivered",
          "unknown",
          "reconciling",
        ].includes(row.state)
      )
        return { status: "unavailable-state" as const, row }
      const receipt = appendOutboxReceipt(row.receipt, {
        kind: "source-notice-reconciliation-claimed",
        requestID: input.requestID,
        claimID: input.claimID,
        originalState: row.state === "reconciling" ? undefined : row.state,
      })
      const changed = db
        .query("UPDATE runner_outbox SET state='reconciling',receipt=? WHERE id=? AND state=?")
        .run(receipt, row.id, row.state).changes
      if (!changed) return { status: "claim-lost" as const, row }
      this.record(row.plan_id, null, "ARCHITECT_SOURCE_NOTICE_RECONCILING", {
        sourceSessionID: input.sourceSessionID,
        outboxID: row.id,
        messageID: row.message_id,
        requestID: input.requestID,
        claimID: input.claimID,
        originalState: row.state,
      })
      this.repository.changed()
      return {
        status: "claimed" as const,
        row: { ...row, state: "reconciling", receipt },
      }
    })
  }
  architectSourceNoticeClaimCurrent(outboxID: string, claimID: string) {
    return this.atomic((db) => {
      const row = db
        .query<{ state: string; receipt: string | null }, [string, string]>(
          `SELECT o.state,o.receipt FROM runner_outbox o
           JOIN runner_plans p ON p.id=o.plan_id
           WHERE o.id=? AND p.project_directory=?`,
        )
        .get(outboxID, this.repository.projectDirectory)
      return row?.state === "reconciling" && sourceNoticeClaimMatches(row.receipt, claimID)
    })
  }
  finishArchitectSourceNoticeReconciliation(input: {
    outboxID: string
    claimID: string
    state: "reconciling" | "consumed" | "superseded" | "unknown"
    receipt: unknown
    event: string
  }) {
    return this.atomic((db) => {
      const row = db
        .query<{ plan_id: string; state: string; receipt: string | null }, [string, string]>(
          `SELECT o.plan_id,o.state,o.receipt FROM runner_outbox o
           JOIN runner_plans p ON p.id=o.plan_id
           WHERE o.id=? AND p.project_directory=?`,
        )
        .get(input.outboxID, this.repository.projectDirectory)
      if (row?.state !== "reconciling" || !sourceNoticeClaimMatches(row.receipt, input.claimID))
        return false
      const receipt = appendOutboxReceipt(row.receipt, input.receipt)
      const changed = db
        .query("UPDATE runner_outbox SET state=?,receipt=? WHERE id=? AND state='reconciling'")
        .run(input.state, receipt, input.outboxID).changes
      if (!changed) return false
      this.record(row.plan_id, null, input.event, {
        outboxID: input.outboxID,
        state: input.state,
        receipt: input.receipt,
      })
      this.repository.changed()
      return true
    })
  }
  architectSourceInputs(sessionID: string) {
    return this.atomic((db) =>
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
    return this.atomic((db) => {
      const source = db
        .query<{ renewal_id: string }, [string, string, string]>(
          `SELECT s.renewal_id FROM runner_architect_sources s
           JOIN runner_architect_renewal_plans rp ON rp.renewal_id=s.renewal_id
           JOIN runner_plans anchor ON anchor.id=s.anchor_plan_id
           WHERE s.session_id=? AND rp.plan_id=? AND rp.transferred=1
             AND s.state='active' AND anchor.project_directory=?`,
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
    return this.atomic((db) =>
      readSourceJournalPage(db, this.repository.projectDirectory, planID, limit, cursor),
    )
  }
  retiredArchitectSourceForPlan(sessionID: string, planID: string) {
    return this.atomic((db) =>
      Boolean(
        db
          .query<{ present: number }, [string, string, string, string]>(
            `SELECT 1 AS present FROM runner_architect_renewals r
             JOIN runner_architect_renewal_plans p ON p.renewal_id=r.id
             JOIN runner_plans current ON current.id=p.plan_id
             JOIN runner_plans anchor ON anchor.id=r.anchor_plan_id
             WHERE r.previous_session_id=? AND p.plan_id=? AND p.transferred=1
               AND current.owner<>? AND anchor.project_directory=? LIMIT 1`,
          )
          .get(sessionID, planID, sessionID, this.repository.projectDirectory),
      ),
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
      const sweep = input.cursor === null ? source.scan_sweep + 1 : source.scan_sweep
      const inboxByID = new Map(input.inbox.map((entry) => [entry.id, entry]))
      const changes = new Map<string, { id: string; type: string; disposition: string }>()
      const changedResults = new Map<
        string,
        { id: string; revision: number; state: ArchitectSourceResult["state"] }
      >()

      const generatedNotification = (id: string, metadata?: Record<string, unknown>) => {
        if (!metadata || metadata.lazersKind !== "runner-outcome") return false
        const row = db
          .query<
            {
              id: string
              plan_id: string
              state: string
              metadata: string | null
              receipt: string | null
            },
            [string, string]
          >(
            "SELECT id,plan_id,state,metadata,receipt FROM runner_outbox WHERE session_id=? AND message_id=?",
          )
          .get(input.sessionID, id)
        if (!row?.metadata) return false
        try {
          const expected = JSON.parse(row.metadata) as unknown
          if (fingerprint(expected) !== fingerprint(metadata)) return false
          const inInbox = inboxByID.has(id)
          const nextState = inInbox ? "admitted" : "consumed"
          if (
            row.state !== nextState &&
            [
              "pending",
              "sending",
              "uncertain",
              "admitted",
              "delivered",
              "unknown",
              "superseded",
            ].includes(row.state)
          ) {
            db.query("UPDATE runner_outbox SET state=?,receipt=? WHERE id=? AND state=?").run(
              nextState,
              appendOutboxReceipt(row.receipt, {
                kind: "architect-source-native-observation",
                sourceSessionID: input.sessionID,
                messageID: id,
                disposition: inInbox ? "queued-native-input" : "native-transcript-consumed",
              }),
              row.id,
              row.state,
            )
            this.record(row.plan_id, null, "OUTCOME_NATIVE_SOURCE_OBSERVED", {
              outboxID: row.id,
              messageID: id,
              sourceSessionID: input.sessionID,
              disposition: nextState,
            })
          }
          return true
        } catch {
          return false
        }
      }
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
            },
            [string, string]
          >(
            `SELECT native_type,delivery,disposition,referenced_revision FROM runner_architect_inputs
             WHERE session_id=? AND message_id=?`,
          )
          .get(input.sessionID, observed.id)
        const changed =
          !old ||
          old.native_type !== observed.type ||
          old.delivery !== delivery ||
          old.disposition !== disposition
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
          observed.metadata ? JSON.stringify(observed.metadata) : null,
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
              "result_fingerprint" | "result_revision" | "referenced_revision"
            >,
            [string, string]
          >(
            `SELECT result_fingerprint,result_revision,referenced_revision
             FROM runner_architect_source_results
             WHERE session_id=? AND message_id=?`,
          )
          .get(input.sessionID, message.id)
        const changed = old?.result_fingerprint !== resultFingerprint
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
              `UPDATE runner_architect_renewals SET state='deferred',input_message_id=?,error=?
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
        `UPDATE runner_architect_sources SET scan_cursor=?,scan_sweep=?,revision=?,updated_at=?
         WHERE session_id=? AND renewal_id=?`,
      ).run(input.nextCursor, sweep, revision, input.now, input.sessionID, source.renewal_id)

      this.repository.changed()
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
    return this.atomic((db) =>
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
        this.record(input.anchorPlanID, null, "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT", {
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
        if (latest.model !== input.model || latest.directory !== input.directory) {
          this.record(latest.anchor_plan_id, null, "ARCHITECT_RENEWAL_RETRY_BLOCKED", {
            renewalID: latest.id,
            reason: "Selected route or directory changed after the prior successor was created",
          })
          return null
        }
        db.query(
          `UPDATE runner_architect_renewals SET idle_at=?,state='creating',handoff_message_id=?,
             handoff_outbox_id=NULL,input_message_id=NULL,error=NULL,continuity_json=?,started_at=?
           WHERE id=? AND state IN ('deferred','archive-failed')`,
        ).run(input.idleAt, input.handoffMessageID, continuityJSON, input.now, latest.id)
        db.query("DELETE FROM runner_architect_renewal_coverage WHERE renewal_id=?").run(latest.id)
        for (const messageID of coveredInputs)
          db.query(
            "INSERT INTO runner_architect_renewal_coverage(renewal_id,session_id,message_id) VALUES(?,?,?)",
          ).run(latest.id, input.previousSessionID, messageID)
        db.query(
          `INSERT INTO runner_architect_sources(
            session_id,renewal_id,anchor_plan_id,scan_cursor,scan_sweep,revision,state,updated_at
          ) VALUES(?,?,?,NULL,0,0,'preparing',?) ON CONFLICT(session_id) DO UPDATE SET
            renewal_id=excluded.renewal_id,anchor_plan_id=excluded.anchor_plan_id,
            scan_cursor=NULL,scan_sweep=0,state='preparing',
            updated_at=excluded.updated_at`,
        ).run(input.previousSessionID, latest.id, input.anchorPlanID, input.now)
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
      db.query(
        `INSERT INTO runner_architect_sources(
          session_id,renewal_id,anchor_plan_id,scan_cursor,scan_sweep,revision,state,updated_at
        ) VALUES(?,?,?,NULL,0,0,'preparing',?)`,
      ).run(input.previousSessionID, id, input.anchorPlanID, input.now)
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
          `UPDATE runner_architect_renewals SET state='deferred',input_message_id=?,error=NULL
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
            `UPDATE runner_architect_renewals SET state=?,error=? WHERE id=? AND state IN (${placeholders})`,
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
          `UPDATE runner_architect_renewals SET state='deferred',error=?
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
          `UPDATE runner_architect_renewals SET state='deferred',error=?
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
          `UPDATE runner_architect_renewals SET state='deferred',input_message_id=?,error=?
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
          "UPDATE runner_architect_renewals SET state='deferred',input_message_id=?,error=NULL WHERE id=? AND state='creating'",
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
        if (existing && existing.session_id !== renewal.previous_session_id)
          throw new Error("Architect continuation changed during renewal")
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
            renewal.previous_session_id,
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
        `UPDATE runner_architect_renewals SET state='archiving',handoff_outbox_id=?,error=NULL
         WHERE id=? AND state='creating'`,
      ).run(input.outboxID, renewal.id)
      db.query(
        "UPDATE runner_architect_sources SET state='active',updated_at=? WHERE session_id=? AND renewal_id=?",
      ).run(Date.now(), renewal.previous_session_id, renewal.id)
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
          "UPDATE runner_architect_renewals SET state='committed',error=NULL WHERE id=? AND state='archiving'",
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
        const outbox = db
          .query<{ state: string; receipt: string | null }, [string]>(
            "SELECT state,receipt FROM runner_outbox WHERE id=?",
          )
          .get(renewal.handoff_outbox_id)
        if (outbox?.state === "pending")
          db.query(
            "UPDATE runner_outbox SET state='superseded',receipt=? WHERE id=? AND state='pending'",
          ).run(
            appendOutboxReceipt(outbox.receipt, {
              kind: "architect-renewal-rolled-back",
              renewalID: renewal.id,
              reason: state,
            }),
            renewal.handoff_outbox_id,
          )
      }
      const changed = db
        .query(
          `UPDATE runner_architect_renewals SET state=?,error=? WHERE id=?
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
        .query<{ state: string; receipt: string | null }, [string]>(
          "SELECT state,receipt FROM runner_outbox WHERE id=?",
        )
        .get(input.id)
      if (current?.state !== input.expectedState) return false
      const receipt = appendOutboxReceipt(current.receipt, input.receipt)
      const changed =
        db
          .query(
            "UPDATE runner_outbox SET session_id=?,message_id=?,metadata=?,state='pending',receipt=? WHERE id=? AND state=?",
          )
          .run(
            input.sessionID,
            input.messageID,
            input.metadata,
            receipt,
            input.id,
            input.expectedState,
          ).changes === 1
      if (changed) this.repository.changed()
      return changed
    })
  }
  outboxForDelivery(projectDirectory = this.repository.projectDirectory): OutboxRow[] {
    return this.atomic((db) =>
      db
        .query<OutboxRow, [string]>(
          // Rank the narrow keys once, rather than parsing and sorting a plan's
          // entire history again for every terminal row on every scheduler tick.
          `WITH candidates AS MATERIALIZED (
             SELECT o.rowid AS sequence,
               row_number() OVER (PARTITION BY o.plan_id
                 ORDER BY CAST(json_extract(o.payload,'$.version') AS INTEGER) DESC,o.rowid DESC) AS position
             FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
             WHERE p.project_directory=? AND o.state<>'reconciling'
           )
           SELECT o.*,CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,o.rowid AS sequence
           FROM candidates c JOIN runner_outbox o ON o.rowid=c.sequence
           WHERE o.state IN ('pending','sending','uncertain','admitted','delivered') OR c.position=1
           ORDER BY o.rowid`,
        )
        .all(projectDirectory),
    )
  }
  activity(planID: string, taskID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
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
  effectiveWriteScope(taskID: string): string[] {
    const task = this.repository.get(taskID)
    if (!task) throw new Error("Task not found")
    const execution = this.execution(taskID)
    const amendment = execution
      ? this.latestTransition<{ writeScope: string[] }>(execution.planID, taskID, "SCOPE_AMENDED")
      : undefined
    return TaskProposalSchema.shape.writeScope.parse([
      ...new Set([...task.proposal.writeScope, ...(amendment?.writeScope ?? [])]),
    ])
  }
  execution(taskID: string): Execution | undefined {
    const node = this.atomic((db) =>
      db
        .query<NodeRow & { plan_state: string; plan_reason: string | null }, [string, string]>(
          "SELECT n.*,p.state AS plan_state,p.reason AS plan_reason FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=? AND n.task_id=?",
        )
        .get(this.repository.projectDirectory, taskID),
    )
    if (!node) return undefined
    const adoption = this.activeAdoptionForTask(node.plan_id, taskID)
    const waitingOn = this.atomic((db) =>
      db
        .query<{ prerequisite: string }, [string, string]>(
          `SELECT d.prerequisite FROM runner_dependencies d
           JOIN runner_nodes n ON n.plan_id=d.plan_id AND n.task_id=d.prerequisite
           WHERE d.plan_id=? AND d.successor=? AND (n.state!='accepted' OR EXISTS(
             SELECT 1 FROM runner_adoptions a WHERE a.plan_id=n.plan_id AND a.task_id=n.task_id
               AND a.state IN ('pending','task-checks','combined-checks','waiting-human')
           ))`,
        )
        .all(node.plan_id, taskID)
        .map((r) => r.prerequisite),
    )
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
        if (previous.fingerprint !== hash) throw new Error("Request identity conflict")
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
    return this.atomic((db) => {
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT fingerprint,receipt FROM runner_commands WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, requestID)
      if (!previous) return undefined
      if (previous.fingerprint !== fingerprint(input)) throw new Error("Request identity conflict")
      return JSON.parse(previous.receipt) as T
    })
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
  submit(input: unknown, owner: string) {
    const plan = PlanInput.parse(input)
    return this.command(plan.requestID, { plan, owner }, (db) => {
      this.validatePlanDependencies(plan.afterPlans ?? [])
      for (const node of plan.nodes) {
        if (this.repository.taskDisposition(node.taskID))
          throw new Error("Task has been retired; inspect its disposition")
        const task = this.repository.get(node.taskID)
        if (!task || task.revision !== node.revision)
          throw new Error(`Missing, foreign, or stale task ${node.taskID}`)
      }
      for (const relation of plan.dispositions)
        if (!this.repository.get(relation.otherTaskID)) throw new Error("Foreign relation target")
      const id = crypto.randomUUID()
      db.query("INSERT INTO runner_plans VALUES(?,?,?,1,1,'draft',?,NULL,NULL,NULL)").run(
        id,
        this.repository.projectDirectory,
        owner,
        JSON.stringify(plan),
      )
      db.query("INSERT INTO runner_plan_revisions VALUES(?,1,?,?,?)").run(
        id,
        JSON.stringify(plan),
        owner,
        Date.now(),
      )
      for (const taskID of plan.integrationOrder)
        db.query("INSERT INTO runner_nodes VALUES(?,?,1,?,'queued',1,NULL,NULL,?,?)").run(
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
      for (const dependency of PlanInput.parse(JSON.parse(plan.body)).afterPlans ?? [])
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
  latestTransition<T>(planID: string, taskID: string | null, event: string): T | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    const row = this.atomic((db) =>
      db
        .query<{ payload: string }, [string, string | null, string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id IS ? AND event=? ORDER BY id DESC LIMIT 1",
        )
        .get(planID, taskID, event),
    )
    return row ? (JSON.parse(row.payload) as T) : undefined
  }
  latestRetainedRepair<T>(planID: string, taskID?: string): T | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    const row = this.atomic((db) =>
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
  /** Confirms an ordered plan-level owner-transfer path after the retained attempt began. */
  hasPlanOwnerTransfer(planID: string, previousOwner: string, currentOwner: string, after: number) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    if (!previousOwner || !currentOwner || previousOwner === currentOwner) return false
    return this.atomic(
      (db) =>
        db
          .query<{ payload: string }, [string, number]>(
            `SELECT payload FROM runner_transitions
           WHERE plan_id=? AND task_id IS NULL AND created_at>=?
             AND event IN ('OWNER_REASSIGNED','OWNER_CONTINUED')
           ORDER BY id`,
          )
          .all(planID, after)
          .reduce((owner, transition) => {
            try {
              const payload = JSON.parse(transition.payload) as {
                from?: unknown
                to?: unknown
              }
              return payload.from === owner && typeof payload.to === "string" && payload.to
                ? payload.to
                : owner
            } catch {
              return owner
            }
          }, previousOwner) === currentOwner,
    )
  }
  /** High-water mark for plan-level owner/cancellation changes, excluding task activity. */
  planControlEpoch(planID: string): number {
    return this.atomic(
      (db) =>
        db
          .query<{ epoch: number }, [string]>(
            `SELECT COALESCE(MAX(id),0) AS epoch FROM runner_transitions
             WHERE plan_id=? AND task_id IS NULL AND event IN (
               'OWNER_REASSIGNED','OWNER_CONTINUED','OWNER_CONTINUATION_ROLLED_BACK','CANCEL_REQUESTED'
             )`,
          )
          .get(planID)!.epoch,
    )
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
  fenced<T>(owner: string, fence: number, run: (db: Database) => T): T {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== owner || lease.fence !== fence) throw new Error("Stale scheduler fence")
      return run(db)
    })
  }
  audit(): { watermark: number; findings: Finding[] } {
    return this.atomic((db) => {
      const tasks = db
        .query<{ id: string; body: string }, [string]>(
          "SELECT id,body FROM tasks WHERE project_directory=? ORDER BY rowid",
        )
        .all(this.repository.projectDirectory)
        .filter((task) => !this.repository.taskDisposition(task.id))
      const relations = db
        .query<{ task_id: string; other_task_id: string }, [string]>(
          "SELECT task_id,other_task_id FROM runner_relations WHERE project_directory=?",
        )
        .all(this.repository.projectDirectory)
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
        if (!this.execution(task.id))
          add("unplanned", [task.id], "Specification has no admitted execution plan", [
            "plan",
            "reuse",
          ])
      for (let i = 0; i < tasks.length; i++)
        for (let j = i + 1; j < tasks.length; j++) {
          const a = tasks[i]!,
            b = tasks[j]!
          if (
            relations.some(
              (r) =>
                (r.task_id === a.id && r.other_task_id === b.id) ||
                (r.task_id === b.id && r.other_task_id === a.id),
            )
          )
            continue
          const aa = this.repository.get(a.id)!,
            bb = this.repository.get(b.id)!
          const exact = fingerprint(aa.proposal) === fingerprint(bb.proposal)
          const aScope = this.effectiveWriteScope(a.id)
          const bScope = this.effectiveWriteScope(b.id)
          const overlap = scopePatternsConflict(aScope, bScope)
          if (exact || overlap)
            add(
              exact ? "exact-content" : "scope-overlap",
              [a.id, b.id],
              exact
                ? "Validated proposal fingerprints match"
                : `Conflicting path scopes: ${aScope.join(", ")} ↔ ${bScope.join(", ")}`,
              ["distinct", "duplicate", "supplements"],
            )
        }
      const watermark = this.repository.version()
      return { watermark, findings }
    })
  }
  /** Admission needs duplicate-content conflicts for its selected tasks, not a project audit. */
  exactContentConflicts(taskIDs: readonly string[]): { watermark: number; findings: Finding[] } {
    return this.atomic((db) => {
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
      for (let i = 0; i < tasks.length; i++) {
        const a = tasks[i]!
        if (!selected.has(a.id)) continue
        for (let j = 0; j < tasks.length; j++) {
          const b = tasks[j]!
          if (
            i === j ||
            (j < i && selected.has(b.id)) ||
            a.content !== b.content ||
            related.has(JSON.stringify([a.id, b.id]))
          )
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
    return this.atomic((db) =>
      db
        .query<AttemptRow, [string]>(
          "SELECT * FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number",
        )
        .all(planID),
    )
  }
  /** Every live project reservation, independent of retained plan history or plan state. */
  activeProjectAttempts(): AttemptRow[] {
    return this.atomic((db) =>
      db
        .query<AttemptRow, [string]>(
          `SELECT a.* FROM runner_attempts a JOIN runner_plans p ON a.plan_id=p.id
           WHERE a.project_directory=? AND a.state IN ('preparing','running','verifying')
           ORDER BY COALESCE(json_extract(p.body,'$.priority'),0) DESC,p.rowid,a.started_at,a.number`,
        )
        .all(this.repository.projectDirectory),
    )
  }
  progressFacts(attemptIDs: readonly string[], limit = 10_001): ProgressRow[] {
    if (!attemptIDs.length) return []
    const bounded = Math.max(1, Math.min(limit, 10_001))
    const placeholders = attemptIDs.map(() => "?").join(",")
    return this.atomic((db) =>
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
    return this.atomic((db) =>
      db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE plan_id=? ORDER BY rowid")
        .all(planID),
    )
  }
  adoption(id: string): AdoptionRow | undefined {
    return this.atomic(
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
    return this.atomic((db) =>
      db
        .query<AdoptionRow, [string]>(
          "SELECT * FROM runner_adoptions WHERE plan_id=? ORDER BY created_at,id",
        )
        .all(planID),
    )
  }
  activeAdoptions(planID?: string): AdoptionRow[] {
    return this.atomic((db) =>
      planID
        ? db
            .query<AdoptionRow, [string, string]>(
              `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=? AND a.plan_id=?
                 AND a.state IN ('pending','task-checks','combined-checks','waiting-human')
               ORDER BY a.created_at,a.id`,
            )
            .all(this.repository.projectDirectory, planID)
        : db
            .query<AdoptionRow, [string]>(
              `SELECT a.* FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=?
                 AND a.state IN ('pending','task-checks','combined-checks','waiting-human')
               ORDER BY a.created_at,a.id`,
            )
            .all(this.repository.projectDirectory),
    )
  }
  activeAdoptionForTask(planID: string, taskID: string): AdoptionRow | undefined {
    return this.atomic(
      (db) =>
        db
          .query<AdoptionRow, [string, string]>(
            `SELECT * FROM runner_adoptions WHERE plan_id=? AND task_id=?
           AND state IN ('pending','task-checks','combined-checks','waiting-human')
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
            scopePatternsConflict(input.writeScope, this.effectiveWriteScope(attempt.task_id)),
        )
      )
        throw new Error("A conflicting worker prevents descendant adoption")
      if (
        this.activeAdoptions().some((adoption) =>
          scopePatternsConflict(input.writeScope, this.effectiveWriteScope(adoption.task_id)),
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
          `UPDATE runner_adoptions SET state=?,hold_reason=?,updated_at=? WHERE id=?
           AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
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
    return this.atomic((db) =>
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
          `UPDATE runner_adoption_checks SET state='completed',receipt=?
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
          `UPDATE runner_adoption_checks SET state='uncertain',receipt=?
           WHERE adoption_id=? AND phase=? AND check_id=? AND state='intended'`,
        )
        .run(JSON.stringify({ error: reason }), adoptionID, phase, checkID).changes
      if (changed) this.repository.changed()
      return changed === 1
    })
  }
  recordAdoptionEvidence(input: {
    id: string
    adoptionID: string
    taskID: string | null
    phase: "task" | "combined"
    assertionID: string
    artifact: string
    body: unknown
  }): AdoptionEvidenceRow {
    return this.atomic((db) => {
      const row: AdoptionEvidenceRow = {
        id: input.id,
        adoption_id: input.adoptionID,
        task_id: input.taskID,
        phase: input.phase,
        assertion_id: input.assertionID,
        artifact: input.artifact,
        body: JSON.stringify(input.body),
        created_at: Date.now(),
      }
      db.query(
        `INSERT INTO runner_adoption_evidence(
           id,adoption_id,task_id,phase,assertion_id,artifact,body,created_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.adoption_id,
        row.task_id,
        row.phase,
        row.assertion_id,
        row.artifact,
        row.body,
        row.created_at,
      )
      this.repository.changed()
      return row
    })
  }
  adoptionEvidence(adoptionID: string): AdoptionEvidenceRow[] {
    return this.atomic((db) =>
      db
        .query<AdoptionEvidenceRow, [string]>(
          "SELECT * FROM runner_adoption_evidence WHERE adoption_id=? ORDER BY created_at,id",
        )
        .all(adoptionID),
    )
  }
  hasAdoptionEvidence(
    adoptionID: string,
    phase: "task" | "combined",
    taskID: string | null,
    assertionID: string,
    artifact: string,
  ): boolean {
    return this.atomic((db) =>
      Boolean(
        db
          .query(
            `SELECT 1 FROM runner_adoption_evidence
             WHERE adoption_id=? AND phase=? AND task_id IS ? AND assertion_id=? AND artifact=? LIMIT 1`,
          )
          .get(adoptionID, phase, taskID, assertionID, artifact),
      ),
    )
  }
  cancelAdoptions(planID: string, reason: string) {
    return this.atomic((db) => {
      const changed = db
        .query(
          `UPDATE runner_adoptions SET state='cancelled',hold_reason=?,updated_at=?
           WHERE plan_id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
        )
        .run(reason, Date.now(), planID).changes
      if (changed) this.repository.changed()
      return changed
    })
  }
  detail(planID: string) {
    const plan = this.plan(planID)
    if (!plan) throw new Error("Plan not found")
    return this.atomic((db) => ({
      plan,
      nodes: this.nodes(planID),
      attempts: this.attempts(planID),
      effects: this.effects(planID),
      adoptions: this.adoptions(planID),
      adoptionChecks: this.atomic((db) =>
        db
          .query(
            `SELECT c.* FROM runner_adoption_checks c JOIN runner_adoptions a ON a.id=c.adoption_id
             WHERE a.plan_id=? ORDER BY c.created_at,c.phase,c.check_id`,
          )
          .all(planID),
      ),
      adoptionEvidence: this.atomic((db) =>
        db
          .query(
            `SELECT e.* FROM runner_adoption_evidence e JOIN runner_adoptions a ON a.id=e.adoption_id
             WHERE a.plan_id=? ORDER BY e.created_at,e.id`,
          )
          .all(planID),
      ),
      evidence: db
        .query("SELECT * FROM runner_evidence WHERE plan_id=? ORDER BY created_at")
        .all(planID),
      activity: db
        .query("SELECT * FROM runner_transitions WHERE plan_id=? ORDER BY id")
        .all(planID),
      delivery: db.query("SELECT * FROM runner_outbox WHERE plan_id=? ORDER BY rowid").all(planID),
    }))
  }
}
