import type { Database, SQLQueryBindings } from "bun:sqlite"
import { RECOVERY_FACT_WINDOW } from "../recovery/journal.ts"
import { AUDIT_RUNS_KIND, measureAuditRuns, retireAuditRunBatch } from "./audit-runs.ts"
import { planIn, planIs, samePlan } from "../runner/identity-read.ts"

/**
 * Retention: retire recorded detail of finished work. A purge is one bounded command, not a
 * workflow: every batch is its own transaction and re-selects what is still retirable, so an
 * interrupted purge simply continues on the next call and a repeated one finds nothing.
 *
 * Retired: bulky progress and tool observations, noisy transition events, delivered notices,
 * dead scan history and superseded caches. Never retired: tasks, references, titles, states,
 * dispositions, integration proofs, commit identity, the latest transition of every plan and
 * task, check and outcome records, anything of a non-terminal plan, settings and assignments.
 */

const DAY_MS = 86_400_000

/** Plan states that never run again without an explicit new command. */
const TERMINAL_PLAN_STATES = ["integrated", "cancelled"] as const

/** Progress record kinds that are activity detail; verification, outcome and usage records stay. */
const DETAIL_PROGRESS_KINDS = [
  "tool",
  "step",
  "native-observation",
  "commentary",
  "visible-text",
  "gap",
  "provider-retry",
  "reminder",
  "shell",
] as const

/**
 * Transition events that only narrate delivery and renewal churn. No reader selects them by
 * name; each plan keeps its latest transition and its latest per task regardless.
 */
const NOISE_TRANSITION_EVENTS = [
  "OUTCOME_OWNER_TRANSFER_UNCERTAIN",
  "OUTCOME_HOST_ADMITTED",
  "OUTCOME_SEND_STARTED",
  "OUTCOME_NATIVE_SOURCE_OBSERVED",
  "OUTCOME_SUPERSEDED",
  "OUTCOME_CONSUMED",
  "CLEANUP_RETRY_SCHEDULED",
  "OWNER_CONTINUED",
  "SOURCE_QUARANTINE_GUARD_RESTORED",
  "SOURCE_QUARANTINE_WAIT",
  "ARCHITECT_SOURCE_CHANGE_NOTICE_CREATED",
  "ARCHITECT_SOURCE_RECONCILED",
  "ARCHITECT_CONTINUITY_RECORDED",
  "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
  "ARCHITECT_RENEWAL_SOURCE_RESULT_OBSERVED",
  "ARCHITECT_RENEWAL_PREPARED",
  "ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED",
] as const

const NOISE_LIST = NOISE_TRANSITION_EVENTS.map((event) => `'${event}'`).join(",")

/** Newest read-only audit receipts kept per project; a replay of an older one just re-audits. */
export const AUDIT_RECEIPTS_KEPT = 5
/** Only bulky audit receipts are worth retiring; a small one costs less than finding it. */
const AUDIT_RECEIPT_MIN_BYTES = 65_536

export type RetentionKindID =
  | "progress"
  | "recovery-facts"
  | "recovery-fact-window"
  | "tool-calls"
  | "transcript-meta"
  | "transitions"
  | "notices"
  | "audit-receipts"
  | "change-log"
  | "model-snapshots"
  | "planning-detail"
  | "audit-runs"

type Spec = {
  table: string
  /** Boolean SQL over `table`; `?` placeholders bind `bind()` in order. */
  where: string
  bind: SQLQueryBindings[]
  /** SQL byte estimate per row. */
  bytes: string
  /** The table may be absent in a database that never installed its module. */
  optional?: boolean
  /** Retire by setting this column to NULL instead of deleting the row. `where` must exclude NULLs. */
  clear?: string
}

type Kind = {
  id: RetentionKindID
  label: string
  /** What is removed, for the preview. */
  detail: string
  /** True when age does not apply: the rows are superseded the moment a newer one exists. */
  ageIndependent: boolean
  specs: (ctx: Context, db: Database) => Spec[]
}

type Context = {
  now: number
  days: number
  cutoff: number
  cutoffISO: string
  retired: string[]
  retiredJSON: string
}

export type KindTotal = {
  id: RetentionKindID
  label: string
  detail: string
  rows: number
  bytes: number
}
export type Protected = { reason: string; count: number; noun: string }
export type RetentionPlan = {
  id: string
  project: string
  state: string
  lastActivity: number | null
}

export type RetentionPreview = {
  days: number
  cutoff: number
  kinds: KindTotal[]
  rows: number
  bytes: number
  plans: { retired: number; kept: number }
  protected: Protected[]
}

const AUDIT_GATE = `length(CAST(receipt AS BLOB)) > ${AUDIT_RECEIPT_MIN_BYTES} AND substr(receipt,1,19)='{"status":"audited"'`

/** Row ids of the newest bulky audit receipts of every project: the ones that stay. */
function newestAuditReceipts(db: Database): number[] {
  const kept: number[] = []
  const projects = db
    .query<{ project_directory: string }, []>(
      "SELECT DISTINCT project_directory FROM runner_commands",
    )
    .all()
  for (const { project_directory } of projects)
    kept.push(
      ...db
        .query<{ rowid: number }, [string, number]>(
          `SELECT rowid FROM runner_commands WHERE project_directory=? AND ${AUDIT_GATE} ORDER BY rowid DESC LIMIT ?`,
        )
        .all(project_directory, AUDIT_RECEIPTS_KEPT)
        .map((row) => row.rowid),
    )
  return kept
}

/**
 * The newest mutation counter of each project that has tasks or plans. Only MAX(id) of a project is
 * ever read, so every earlier counter is superseded; a project not listed here keeps all of its own.
 */
function newestMutations(db: Database): Array<[string, number]> {
  const projects = db
    .query<{ project_directory: string }, []>(
      `SELECT project_directory FROM tasks UNION SELECT project_directory FROM runner_plans
       UNION SELECT project_directory FROM runner_commands`,
    )
    .all()
  const newest = db.query<{ id: number | null }, [string]>(
    "SELECT MAX(id) AS id FROM task_changes WHERE project_directory=? AND kind='mutation'",
  )
  return projects.flatMap(({ project_directory }) => {
    const id = newest.get(project_directory)?.id
    return id === null || id === undefined ? [] : [[project_directory, id] as [string, number]]
  })
}

/**
 * Per project, the newest fact id outside the journal's recent window, held back to the slowest
 * registered consumer's cursor. Facts at or below it have no reader (see RECOVERY_FACT_WINDOW).
 */
function outsideFactWindow(db: Database): Array<[string, number]> {
  const edge = db.query<{ change_id: number }, [string, number]>(
    `SELECT change_id FROM recovery_progress_facts WHERE project_directory=?
      ORDER BY change_id DESC LIMIT 1 OFFSET ?`,
  )
  const consumer = db.query<{ id: number | null }, [string]>(
    "SELECT MIN(change_id) AS id FROM recovery_progress_consumers WHERE project_directory=?",
  )
  const projects = db
    .query<{ project_directory: string }, []>(
      "SELECT DISTINCT project_directory FROM recovery_progress_coverage",
    )
    .all()
  return projects.flatMap(({ project_directory }) => {
    const outside = edge.get(project_directory, RECOVERY_FACT_WINDOW)?.change_id
    if (outside === undefined) return []
    const slowest = consumer.get(project_directory)?.id
    return [[project_directory, Math.min(outside, slowest ?? outside)] as [string, number]]
  })
}

const inPlans = "(SELECT value FROM json_each(?))"
const PLAN_LIST = "SELECT value FROM json_each(?)"

const KINDS: Kind[] = [
  {
    id: "progress",
    label: "Worker activity",
    detail: "tool calls, steps and observations of finished attempts",
    ageIndependent: false,
    specs: (ctx, db) => [
      {
        table: "runner_progress",
        where: `${planIn(db, "runner_progress", PLAN_LIST)} AND kind IN (${DETAIL_PROGRESS_KINDS.map((k) => `'${k}'`).join(",")})`,
        bind: [ctx.retiredJSON],
        bytes:
          "length(payload)+length(sources_json)+length(event_ids_json)+length(dedupe_key)+length(session_id)+length(attempt_id)+length(project_directory)+96",
      },
      {
        table: "runner_progress_reconciled",
        where: `attempt_id IN (SELECT id FROM runner_attempts WHERE plan_id IN ${inPlans})`,
        bind: [ctx.retiredJSON],
        bytes: 'length(light)+COALESCE(length("full"),0)+length(message_id)+length(session_id)+64',
        optional: true,
      },
    ],
  },
  {
    id: "recovery-facts",
    label: "Progress facts",
    detail: "change facts already consumed by every detector",
    ageIndependent: false,
    specs: (ctx) => [
      {
        table: "recovery_progress_facts",
        where: `plan_id IN ${inPlans} AND change_id <= COALESCE((SELECT MIN(c.change_id) FROM recovery_progress_consumers c WHERE c.project_directory=recovery_progress_facts.project_directory),9007199254740991)`,
        bind: [ctx.retiredJSON],
        bytes:
          "length(changed_fields)+length(plan_id)+length(task_id)+length(attempt_id)+length(session_id)+length(project_directory)+length(project_id)+length(source)+length(source_kind)+110",
        optional: true,
      },
    ],
  },
  {
    id: "tool-calls",
    label: "Tool call records",
    detail: "native tool observations of finished work and of Architect sessions past the age",
    ageIndependent: false,
    specs: (ctx) => [
      {
        table: "native_tool_calls",
        where: `(plan_id IN ${inPlans} OR (plan_id IS NULL AND last_observed_at < ?))`,
        bind: [ctx.retiredJSON, ctx.cutoff],
        bytes:
          "length(payload)+length(sources_json)+length(event_ids_json)+length(invocation_id)+length(session_id)+length(project_directory)+length(COALESCE(native_call_id,''))+length(COALESCE(parent_call_id,''))+length(COALESCE(message_id,''))+length(COALESCE(tool,''))+160",
        optional: true,
      },
    ],
  },
  {
    id: "transcript-meta",
    label: "Transcript metadata",
    detail: "routes, times and counts of finished attempts' worker transcripts (no text)",
    ageIndependent: false,
    specs: (ctx) =>
      (["transcript_steps", "transcript_sessions"] as const).map((table) => ({
        table,
        where: `session_id IN (SELECT a.session_id FROM runner_attempts a WHERE a.plan_id IN ${inPlans})`,
        bind: [ctx.retiredJSON],
        bytes:
          table === "transcript_steps"
            ? "length(session_id)+length(message_id)+length(project_directory)+length(COALESCE(provider_id,''))+length(COALESCE(model_id,''))+length(COALESCE(variant,''))+length(COALESCE(error_type,''))+length(COALESCE(retry_error_type,''))+104"
            : "length(session_id)+length(project_directory)+length(COALESCE(cursor,''))+length(read_state)+48",
        optional: true,
      })),
  },
  {
    id: "transitions",
    label: "Delivery history",
    detail: "delivery and renewal churn events; each plan and task keeps its latest transition",
    ageIndependent: false,
    specs: (ctx, db) => [
      {
        table: "runner_transitions",
        where: `${planIn(db, "runner_transitions", PLAN_LIST)} AND event IN (${NOISE_TRANSITION_EVENTS.map((e) => `'${e}'`).join(",")}) AND id < (SELECT MAX(l.id) FROM runner_transitions l WHERE ${samePlan(db, "runner_transitions", "l", "runner_transitions")}) AND id < (SELECT MAX(l.id) FROM runner_transitions l WHERE ${samePlan(db, "runner_transitions", "l", "runner_transitions")} AND l.task_id IS runner_transitions.task_id)`,
        bind: [ctx.retiredJSON],
        bytes: "length(payload)+length(event)+length(plan_id)+length(COALESCE(task_id,''))+96",
      },
    ],
  },
  {
    id: "notices",
    label: "Delivered notices",
    detail: "Architect notices already delivered or superseded",
    ageIndependent: false,
    specs: (ctx) => [
      {
        table: "runner_outbox",
        where: `plan_id IN ${inPlans} AND state IN ('delivered','superseded')`,
        bind: [ctx.retiredJSON],
        // Receipt histories are child rows (deleted with the notice by ON DELETE CASCADE); the
        // legacy `receipt` column is NULL once migrated. 56 bytes is a child row's key and header.
        bytes:
          "length(payload)+length(COALESCE(metadata,''))+length(COALESCE(receipt,''))+length(session_id)+length(message_id)+length(id)+96+COALESCE((SELECT SUM(length(r.body)+56) FROM runner_outbox_receipts r WHERE r.outbox_id=runner_outbox.id),0)",
      },
    ],
  },
  {
    id: "audit-receipts",
    label: "Audit receipts",
    detail: `read-only audit results beyond the newest ${AUDIT_RECEIPTS_KEPT} per project`,
    ageIndependent: true,
    specs: (_ctx, db) => [
      {
        table: "runner_commands",
        where: `${AUDIT_GATE} AND rowid NOT IN (SELECT value FROM json_each(?))`,
        bind: [JSON.stringify(newestAuditReceipts(db))],
        bytes:
          "length(receipt)+length(request_id)+length(fingerprint)+length(project_directory)+64",
      },
    ],
  },
  {
    id: "recovery-fact-window",
    label: "Old progress facts",
    detail:
      "journal facts older than the newest window per project; only the recent window is ever read",
    ageIndependent: true,
    specs: (_ctx, db) => {
      if (
        !tableExists(db, "recovery_progress_facts") ||
        !tableExists(db, "recovery_progress_coverage")
      )
        return []
      const outside = outsideFactWindow(db)
      if (!outside.length) return []
      return [
        {
          table: "recovery_progress_facts",
          where: outside.map(() => "(project_directory=? AND change_id<=?)").join(" OR "),
          bind: outside.flatMap(([project, id]) => [project, id]),
          bytes:
            "length(changed_fields)+length(plan_id)+length(task_id)+length(attempt_id)+length(session_id)+length(project_directory)+length(project_id)+length(source)+length(source_kind)+110",
        },
      ]
    },
  },
  {
    id: "change-log",
    label: "Task change counters",
    detail: "superseded change counters; only the newest per project is ever read",
    ageIndependent: true,
    specs: (_ctx, db) => {
      const newest = newestMutations(db)
      if (!newest.length) return []
      return [
        {
          table: "task_changes",
          where: `kind='mutation' AND (${newest.map(() => "(project_directory=? AND id<?)").join(" OR ")})`,
          bind: newest.flatMap(([project, id]) => [project, id]),
          bytes: "length(project_directory)+length(kind)+48",
        },
      ]
    },
  },
  {
    id: "model-snapshots",
    label: "Superseded model snapshots",
    detail: "catalog, benchmark and price snapshots older than the age that are not the latest",
    ageIndependent: false,
    specs: (ctx) => [
      {
        table: "model_evidence_snapshots",
        where: `retrieved_at < ? AND snapshot_id NOT IN (SELECT latest_snapshot_id FROM model_evidence_refreshes WHERE latest_snapshot_id IS NOT NULL) AND generation < (SELECT MAX(s.generation) FROM model_evidence_snapshots s WHERE s.project_directory=model_evidence_snapshots.project_directory AND s.source=model_evidence_snapshots.source)`,
        bind: [ctx.cutoffISO],
        bytes: "length(body)+length(snapshot_id)+length(source)+length(project_directory)+96",
        optional: true,
      },
      {
        table: "model_endpoint_pricing_snapshots",
        where: `retrieved_at < ? AND snapshot_id NOT IN (SELECT latest_snapshot_id FROM model_endpoint_pricing_refreshes WHERE latest_snapshot_id IS NOT NULL) AND generation < (SELECT MAX(s.generation) FROM model_endpoint_pricing_snapshots s WHERE s.project_directory=model_endpoint_pricing_snapshots.project_directory AND s.product_id=model_endpoint_pricing_snapshots.product_id)`,
        bind: [ctx.cutoffISO],
        bytes: "length(body)+length(snapshot_id)+length(product_id)+length(project_directory)+96",
        optional: true,
      },
    ],
  },
]

/**
 * Plans of the planning flow that are finished: tasked or abandoned, untouched since the cutoff,
 * and (when tasked) whose runner plan is in a terminal state. Bound: cutoff, then the terminal states.
 */
const FINISHED_PLANNINGS = `(SELECT id FROM planning_plannings WHERE state IN ('tasked','abandoned') AND updated_at < ? AND (tasked_plan_id IS NULL OR tasked_plan_id IN (SELECT id FROM runner_plans WHERE state IN (${TERMINAL_PLAN_STATES.map((s) => `'${s}'`).join(",")}))))`

KINDS.push({
  id: "planning-detail",
  label: "Plan drafts",
  detail:
    "intermediate revisions of finished plans (the first, every reviewed one and the last stay) and the raw replies of their planning agents",
  ageIndependent: false,
  specs: (ctx) => [
    {
      table: "planning_revisions",
      where: `planning_id IN ${FINISHED_PLANNINGS}
        AND revision > (SELECT MIN(r.revision) FROM planning_revisions r WHERE r.planning_id=planning_revisions.planning_id)
        AND revision < (SELECT MAX(r.revision) FROM planning_revisions r WHERE r.planning_id=planning_revisions.planning_id)
        AND revision NOT IN (SELECT v.revision FROM planning_reviews v WHERE v.planning_id=planning_revisions.planning_id)`,
      bind: [ctx.cutoff],
      bytes: "length(body)+length(validation)+length(field_hashes)+length(planning_id)+64",
      optional: true,
    },
    {
      table: "planning_runs",
      clear: "raw_reply",
      where: `raw_reply IS NOT NULL AND review_id IN (SELECT id FROM planning_reviews WHERE planning_id IN ${FINISHED_PLANNINGS})`,
      bind: [ctx.cutoff],
      bytes: "length(raw_reply)",
      optional: true,
    },
  ],
})

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

function tableExists(db: Database, name: string) {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null
}

function retentionContext(now: number, days: number, retired: string[]): Context {
  const cutoff = now - days * DAY_MS
  return {
    now,
    days,
    cutoff,
    cutoffISO: new Date(cutoff).toISOString(),
    retired,
    retiredJSON: JSON.stringify(retired),
  }
}

/**
 * Every plan with why it is or is not retirable at this age. A plan is retirable when it is in a
 * terminal state, nothing is waiting on it and its last activity is older than the cutoff.
 */
export function classifyPlans(db: Database, now: number, days: number) {
  const cutoff = now - days * DAY_MS
  const plans = db
    .query<{ id: string; project: string; state: string; at: number | null }, []>(
      `SELECT p.id, p.project_directory AS project, p.state,
              MAX(COALESCE((SELECT t.created_at FROM runner_transitions t WHERE t.id=(SELECT MAX(l.id) FROM runner_transitions l WHERE ${planIs(db, "runner_transitions", "l", "p.id")} AND l.event NOT IN (${NOISE_LIST}))),0),
                  COALESCE((SELECT MAX(a.started_at) FROM runner_attempts a WHERE a.plan_id=p.id),0)) AS at
         FROM runner_plans p`,
    )
    .all()
  const ids = (sql: string, table: string | undefined = undefined) =>
    new Set(
      table && !tableExists(db, table)
        ? []
        : db
            .query<{ plan_id: string }, []>(sql)
            .all()
            .map((row) => row.plan_id),
    )
  const waiting = new Map<string, Set<string>>([
    [
      "an Architect notice is still pending",
      ids("SELECT DISTINCT plan_id FROM runner_outbox WHERE state='pending'"),
    ],
    [
      "a takeover is open",
      ids(
        "SELECT DISTINCT plan_id FROM runner_takeovers WHERE state NOT IN ('taken-over','cancelled')",
        "runner_takeovers",
      ),
    ],
    [
      "an adoption is open",
      ids(
        "SELECT DISTINCT plan_id FROM runner_adoptions WHERE state NOT IN ('accepted','failed','cancelled')",
        "runner_adoptions",
      ),
    ],
    [
      "an effect is held, uncertain or unfinished",
      ids(
        "SELECT DISTINCT plan_id FROM runner_effects WHERE state IN ('intended','held','uncertain')",
      ),
    ],
    [
      "a worker concern is open",
      ids(
        `SELECT DISTINCT v.plan_id FROM recovery_concern_versions v
          WHERE v.version=(SELECT MAX(w.version) FROM recovery_concern_versions w
                            WHERE w.project_directory=v.project_directory AND w.concern_id=v.concern_id)
            AND NOT EXISTS (SELECT 1 FROM recovery_concern_dispositions d
                             WHERE d.project_directory=v.project_directory
                               AND d.concern_id=v.concern_id AND d.version=v.version)`,
        "recovery_concern_versions",
      ),
    ],
    [
      "a handoff is open",
      ids(
        `SELECT DISTINCT r.plan_id FROM recovery_handoff_requests r
          WHERE NOT EXISTS (SELECT 1 FROM recovery_handoff_dispositions d
                             WHERE d.project_directory=r.project_directory AND d.request_id=r.request_id)
            ${
              // A takeover's request never gets a report, so never a disposition; it closes with
              // its takeover.
              tableExists(db, "runner_takeovers")
                ? `AND NOT EXISTS (SELECT 1 FROM runner_takeovers t
                                    WHERE t.project_directory=r.project_directory
                                      AND 'takeover:'||t.id=r.request_id
                                      AND t.state IN ('taken-over','cancelled'))`
                : ""
            }`,
        "recovery_handoff_requests",
      ),
    ],
    [
      "a task also belongs to a plan that is not finished",
      ids(
        `SELECT DISTINCT n.plan_id FROM runner_nodes n
          WHERE EXISTS (SELECT 1 FROM runner_nodes o JOIN runner_plans q ON q.id=o.plan_id
                         WHERE o.task_id=n.task_id AND o.plan_id<>n.plan_id
                           AND q.state NOT IN (${TERMINAL_PLAN_STATES.map((s) => `'${s}'`).join(",")}))`,
      ),
    ],
  ])
  const retired: RetentionPlan[] = []
  const kept = new Map<string, number>()
  const keep = (reason: string) => kept.set(reason, (kept.get(reason) ?? 0) + 1)
  for (const plan of plans) {
    const view = { id: plan.id, project: plan.project, state: plan.state, lastActivity: plan.at }
    if (!(TERMINAL_PLAN_STATES as readonly string[]).includes(plan.state)) {
      keep("plan is not finished (queued, running, blocked or cleaning up)")
      continue
    }
    const reason = [...waiting].find(([, set]) => set.has(plan.id))?.[0]
    if (reason) {
      keep(`finished plan kept: ${reason}`)
      continue
    }
    if (!plan.at || plan.at >= cutoff) {
      keep(
        plan.at
          ? `finished plan kept: activity within ${days} days`
          : "finished plan kept: no recorded activity to date it by",
      )
      continue
    }
    retired.push(view)
  }
  return { retired, kept }
}

function selectSpecs(db: Database, ctx: Context, kind: Kind) {
  return kind.specs(ctx, db).filter((spec) => !spec.optional || tableExists(db, spec.table))
}

/** Byte length from the record header: no overflow pages are read to size a big text column. */
const sized = (expression: string) =>
  expression.replace(/length\((COALESCE\([^)]*\)|[A-Za-z_".]+)\)/g, "length(CAST($1 AS BLOB))")

/** Rows scanned between yields; keeps one synchronous statement to a few tens of milliseconds. */
const WINDOW = 100_000

/** Exact rows and estimated bytes of one spec, scanned in rowid windows with a turn between. */
async function measure(db: Database, spec: Spec) {
  const bounds = db
    .query<{ lo: number | null; hi: number | null }, []>(
      `SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${spec.table}`,
    )
    .get()!
  let rows = 0
  let bytes = 0
  if (bounds.lo === null || bounds.hi === null) return { rows, bytes }
  const query = db.query<{ n: number; b: number | null }, SQLQueryBindings[]>(
    `SELECT COUNT(*) AS n, SUM(${sized(spec.bytes)}) AS b FROM ${spec.table}
      WHERE rowid > ? AND rowid <= ? AND (${spec.where})`,
  )
  for (let low = bounds.lo - 1; low < bounds.hi; low += WINDOW) {
    const row = query.get(low, low + WINDOW, ...spec.bind)!
    rows += row.n
    bytes += row.b ?? 0
    if (low + WINDOW < bounds.hi) await turn()
  }
  return { rows, bytes }
}

/**
 * Exact counts and estimated payload bytes of what a purge at this age would remove, plus what it
 * leaves and why. Reads only: this is the dry run, and the real run removes the same rows.
 */
export async function previewRetention(
  db: Database,
  input: {
    now: number
    days: number
    ageIndependent?: boolean
    ageDependent?: boolean
    /** The plugin data folder; with it the audit runs of retired plans (and their files) count. */
    dataDirectory?: string
  },
): Promise<RetentionPreview> {
  const { retired, kept } = classifyPlans(db, input.now, input.days)
  const ctx = retentionContext(
    input.now,
    input.days,
    retired.map((plan) => plan.id),
  )
  const kinds: KindTotal[] = []
  for (const kind of KINDS) {
    if (kind.ageIndependent ? input.ageIndependent === false : input.ageDependent === false)
      continue
    let rows = 0
    let bytes = 0
    for (const spec of selectSpecs(db, ctx, kind)) {
      const total = await measure(db, spec)
      rows += total.rows
      bytes += total.bytes
    }
    kinds.push({ id: kind.id, label: kind.label, detail: kind.detail, rows, bytes })
  }
  if (input.dataDirectory !== undefined && input.ageDependent !== false) {
    const total = measureAuditRuns(db, { retired: ctx.retired, dataDirectory: input.dataDirectory })
    kinds.push({ ...AUDIT_RUNS_KIND, ...total })
  }
  const taskCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n
  const protectedRows: Protected[] = [
    ...[...kept].map(([reason, count]) => ({ reason, count, noun: "plans" })),
    {
      reason: "tasks with their reference, title, state and disposition",
      count: taskCount,
      noun: "tasks",
    },
    {
      reason: "check, verification, artifact, outcome and usage records",
      count: db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM runner_progress WHERE kind NOT IN (${DETAIL_PROGRESS_KINDS.map((k) => `'${k}'`).join(",")})`,
        )
        .get()!.n,
      noun: "records",
    },
    {
      reason: "integration proofs, accepted and integrated transitions, commit identity",
      count: db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM runner_transitions WHERE event NOT IN (${NOISE_TRANSITION_EVENTS.map((e) => `'${e}'`).join(",")})`,
        )
        .get()!.n,
      noun: "transitions",
    },
    {
      reason: "evidence, effects and attempts of every plan",
      count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_attempts").get()!.n,
      noun: "attempts",
    },
  ]
  return {
    days: input.days,
    cutoff: ctx.cutoff,
    kinds,
    rows: kinds.reduce((sum, kind) => sum + kind.rows, 0),
    bytes: kinds.reduce((sum, kind) => sum + kind.bytes, 0),
    plans: {
      retired: retired.length,
      kept: [...kept.values()].reduce((sum, count) => sum + count, 0),
    },
    protected: protectedRows,
  }
}

export type SliceResult = {
  removed: Record<string, { rows: number; bytes: number }>
  rows: number
  /** True once nothing retirable remains; false when the time budget ended the slice. */
  done: boolean
}

/**
 * Remove at most `budgetMs` of work: bounded batches, each in its own transaction (`atomic`), with
 * a turn of the event loop between batches so the scheduler and panels are never starved.
 */
export async function retireSlice(
  atomic: <T>(run: (db: Database) => T) => T,
  read: <T>(run: (db: Database) => T) => T,
  input: {
    now: number
    days: number
    budgetMs: number
    batch: number
    /** False: only the kinds that age does not apply to (superseded rows), whatever `days` says. */
    ageDependent?: boolean
    /** The plugin data folder; with it the audit runs of retired plans go with their files. */
    dataDirectory?: string
  },
): Promise<SliceResult> {
  const started = Date.now()
  const removed: SliceResult["removed"] = {}
  let rows = 0
  // Which (kind, table) pairs exist is stable; what each may delete is not. Eligibility is
  // therefore recomputed inside every batch's own transaction: a plan retried, waited on or
  // newly shared between batches is protected from the next batch on.
  const targets = read((db) => {
    const { retired } = classifyPlans(db, input.now, input.days)
    const ctx = retentionContext(
      input.now,
      input.days,
      retired.map((plan) => plan.id),
    )
    return KINDS.filter((kind) => kind.ageIndependent || input.ageDependent !== false).flatMap(
      (kind) => selectSpecs(db, ctx, kind).map((spec) => ({ kind, table: spec.table })),
    )
  })
  for (const { kind, table } of targets) {
    for (;;) {
      if (Date.now() - started >= input.budgetMs) return { removed, rows, done: false }
      const result = atomic((db) => {
        const { retired } = classifyPlans(db, input.now, input.days)
        const ctx = retentionContext(
          input.now,
          input.days,
          retired.map((plan) => plan.id),
        )
        const spec = selectSpecs(db, ctx, kind).find((candidate) => candidate.table === table)
        const sample = spec ? measureBatch(db, spec, input.batch) : { rows: 0, bytes: 0 }
        if (!spec || !sample.rows) return sample
        db.query(
          spec.clear
            ? `UPDATE ${spec.table} SET ${spec.clear}=NULL WHERE rowid IN (SELECT rowid FROM ${spec.table} WHERE ${spec.where} LIMIT ?)`
            : `DELETE FROM ${spec.table} WHERE rowid IN (SELECT rowid FROM ${spec.table} WHERE ${spec.where} LIMIT ?)`,
        ).run(...spec.bind, input.batch)
        return sample
      })
      if (!result.rows) break
      const entry = (removed[kind.id] ??= { rows: 0, bytes: 0 })
      entry.rows += result.rows
      entry.bytes += result.bytes
      rows += result.rows
      await turn()
    }
  }
  // Audit runs follow the one finished-plan age the owner configured, like other finished-plan
  // detail. With no age (the superseded-only pass, which runs with days 0) none is retired.
  if (input.dataDirectory !== undefined && input.ageDependent !== false) {
    const dataDirectory = input.dataDirectory
    for (;;) {
      if (Date.now() - started >= input.budgetMs) return { removed, rows, done: false }
      const retired = read((db) => classifyPlans(db, input.now, input.days).retired).map(
        (plan) => plan.id,
      )
      const result = retireAuditRunBatch(atomic, read, {
        retired,
        dataDirectory,
        batch: Math.min(input.batch, 50),
      })
      if (!result.rows) break
      const entry = (removed[AUDIT_RUNS_KIND.id] ??= { rows: 0, bytes: 0 })
      entry.rows += result.rows
      entry.bytes += result.bytes
      rows += result.rows
      await turn()
    }
  }
  return { removed, rows, done: true }
}

/** Rows and bytes the next batch will delete, measured in the same transaction. */
function measureBatch(db: Database, spec: Spec, limit: number) {
  const row = db
    .query<{ n: number; b: number | null }, SQLQueryBindings[]>(
      `SELECT COUNT(*) AS n, SUM(b) AS b FROM (SELECT ${sized(spec.bytes)} AS b FROM ${spec.table} WHERE ${spec.where} LIMIT ?)`,
    )
    .get(...spec.bind, limit)!
  return { rows: row.n, bytes: row.b ?? 0 }
}
