import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import { scopeViolations } from "../runner/artifacts.ts"
import {
  STRUGGLING_THRESHOLDS,
  canStruggle,
  durationLabel,
  readStrugglingFacts,
  tokenLabel,
  type StrugglingFacts,
} from "../runner/struggling.ts"
import type { RunnerStore } from "../runner/store.ts"
import type { HandoffStore } from "./handoff/store.ts"

/**
 * The producer of recovery concerns. Deterministic rules read the recorded trajectory of each
 * running task (runner transitions, attempts and the progress journal) and record a concern
 * through the handoff store, where versions, dispositions and Architect follow-ups already
 * live. The detector never pauses, cancels or steers a worker; the Architect decides.
 *
 * Thresholds come from the 175 tasks accepted in the production database (Nov 2026); see
 * `STRUGGLING_THRESHOLDS` for the distribution of the measures that are not listed here.
 */
export const DETECTOR_THRESHOLDS = {
  ...STRUGGLING_THRESHOLDS,
  /**
   * Consecutive failed tool calls at the end of an attempt. A run of five is rare in healthy
   * work, which retries a failed call once or twice and then changes approach.
   */
  trailingToolFailures: 5,
  /**
   * Consecutive tool calls since the last edit or patch. A task's whole attempt is a median of
   * 117 calls (p90 429), so 100 calls with no file change is most of a typical attempt.
   */
  callsWithoutFileChange: 100,
} as const

/** A follow-up on a condition cannot be evaluated by the runtime; reassess it after this long. */
export const CONDITION_REASSESS_MS = 2 * 3_600_000

export const WORKER_CONCERN_EVENT = "WORKER_CONCERN_RAISED"
export const DETECTOR_ACTOR = {
  sessionID: "lazers-runtime",
  agent: "lazers-runtime",
  role: "runtime",
} as const

export type RuleID =
  | "verify-rounds-repeated"
  | "repair-cycles-repeated"
  | "worker-time-long"
  | "token-spend-high"
  | "interruptions-repeated"
  | "reopened-after-accept"
  | "hold-family-repeated"
  | "out-of-scope-write"
  | "tool-failures-repeated"
  | "no-file-changes"

export type Finding = {
  ruleID: RuleID
  reason: string
  /** How far past its threshold the measure is; a materially larger one is new evidence. */
  magnitude: number
  evidence: { kind: "trajectory" | "other"; reference: string; note: string }[]
}

export type TrajectoryTail = {
  /** Newest sequence of the attempt's progress journal; 0 when it has none. */
  throughSequence: number
  trailingToolFailures: number
  callsWithoutFileChange: number
  /** Files edited or patched outside the write scope. */
  outOfScope: string[]
}

/** Pure: facts and tail in, findings out. */
export function evaluateRules(
  facts: StrugglingFacts,
  tail: TrajectoryTail,
  where: string,
): Finding[] {
  const t = DETECTOR_THRESHOLDS
  const found: Finding[] = []
  const add = (ruleID: RuleID, reason: string, magnitude: number, note: string) =>
    found.push({
      ruleID,
      reason,
      magnitude,
      evidence: [{ kind: "trajectory", reference: where, note }],
    })
  if (facts.verifyRounds >= t.verifyRounds)
    add(
      "verify-rounds-repeated",
      `${facts.verifyRounds} verification rounds`,
      facts.verifyRounds,
      "VERIFY transitions of this task",
    )
  if (facts.repairsAndResumes >= t.repairsAndResumes)
    add(
      "repair-cycles-repeated",
      `${facts.repairsAndResumes} repairs and resumes`,
      facts.repairsAndResumes,
      "REPAIR, RESUME, RETAINED_REPAIR and RETRY_REQUESTED transitions",
    )
  if (facts.attemptMs >= t.attemptMs)
    add(
      "worker-time-long",
      `${durationLabel(facts.attemptMs)} of worker time`,
      Math.floor(facts.attemptMs / t.attemptMs),
      "worker start or resume to stop, summed",
    )
  if (facts.tokens >= t.tokens)
    add(
      "token-spend-high",
      `${tokenLabel(facts.tokens)} tokens across ${facts.attempts} attempt(s)`,
      Math.floor(facts.tokens / t.tokens),
      "attempt token counts, summed",
    )
  if (facts.interruptions >= t.interruptions)
    add(
      "interruptions-repeated",
      `${facts.interruptions} interruptions`,
      facts.interruptions,
      "WORKER_STOPPED transitions with outcome interrupted",
    )
  if (facts.reopenedAfterAccept >= t.reopenedAfterAccept)
    add(
      "reopened-after-accept",
      `reopened ${facts.reopenedAfterAccept} times after acceptance`,
      facts.reopenedAfterAccept,
      "RETAINED_REPAIR transitions from accepted",
    )
  if (facts.repeatedHold && facts.repeatedHold.count >= t.sameHoldFamily)
    add(
      "hold-family-repeated",
      `held ${facts.repeatedHold.count} times for ${facts.repeatedHold.family}`,
      facts.repeatedHold.count,
      "BLOCKED transitions of one hold family",
    )
  if (tail.outOfScope.length)
    add(
      "out-of-scope-write",
      `edited outside the write scope: ${tail.outOfScope.slice(0, 6).join(", ")}`,
      tail.outOfScope.length,
      `paths: ${tail.outOfScope.slice(0, 20).join(", ")}`,
    )
  if (tail.trailingToolFailures >= t.trailingToolFailures)
    add(
      "tool-failures-repeated",
      `the last ${tail.trailingToolFailures} tool calls all failed`,
      tail.trailingToolFailures,
      "newest tool calls in the progress journal",
    )
  if (tail.callsWithoutFileChange >= t.callsWithoutFileChange)
    add(
      "no-file-changes",
      `${tail.callsWithoutFileChange} tool calls since the last file change`,
      tail.callsWithoutFileChange,
      "newest tool calls in the progress journal",
    )
  return found
}

const TAIL_ROWS = 400

/** The newest tool calls of an attempt. Bounded: never more than `TAIL_ROWS` rows. */
export function readTrajectoryTail(
  db: Database,
  projectDirectory: string,
  attemptID: string,
  scope: string[],
): TrajectoryTail {
  const last = db
    .query<{ seq: number | null }, [string, string]>(
      "SELECT max(seq) AS seq FROM runner_progress WHERE project_directory=? AND attempt_id=?",
    )
    .get(projectDirectory, attemptID)
  const rows = db
    .query<
      { status: string | null; operation: string | null; paths: string | null },
      [string, string, number]
    >(
      `SELECT json_extract(payload,'$.status') AS status,
              json_extract(payload,'$.fileTargets.operation') AS operation,
              json_extract(payload,'$.fileTargets.paths') AS paths
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND kind='tool' AND call_id IS NOT NULL
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(projectDirectory, attemptID, TAIL_ROWS)
  let trailingToolFailures = 0
  for (const row of rows) {
    if (row.status !== "failed") break
    trailingToolFailures += 1
  }
  let callsWithoutFileChange = 0
  for (const row of rows) {
    if (row.operation === "edit" || row.operation === "patch") break
    callsWithoutFileChange += 1
  }
  // Out-of-scope edits are read over the whole attempt, not only the tail.
  const edits = db
    .query<{ paths: string | null }, [string, string]>(
      `SELECT json_extract(payload,'$.fileTargets.paths') AS paths FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND kind='tool'
          AND json_extract(payload,'$.fileTargets.operation') IN ('edit','patch')
          AND coalesce(json_extract(payload,'$.status'),'') <> 'failed'`,
    )
    .all(projectDirectory, attemptID)
  const edited = new Set<string>()
  for (const row of edits) {
    try {
      const paths = JSON.parse(row.paths ?? "[]") as unknown
      if (Array.isArray(paths))
        for (const path of paths) if (typeof path === "string" && path) edited.add(path)
    } catch {
      /* an unreadable target list names no file */
    }
  }
  return {
    throughSequence: last?.seq ?? 0,
    trailingToolFailures,
    callsWithoutFileChange,
    outOfScope: scopeViolations([...edited], scope).toSorted(),
  }
}

/** A stable UUID for one rule on one attempt, so replays and reopens address one concern. */
export function concernIDFor(attemptID: string, ruleID: string): string {
  const h = createHash("sha256").update(`lazers-concern:${attemptID}:${ruleID}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

type VersionRow = { version: number; payload: string }
type DispositionRow = { payload: string }

export type OpenConcern = {
  concernID: string
  version: number
  planID: string
  taskID: string
  attemptID: string
  ruleID: string
  reason: string
  boundary: { fromSequence: number; throughSequence: number }
  evidence: { reference: string; note?: string }[]
  recordedAt: string
}

/** Concerns whose newest version no Architect decision covers yet, for unsettled tasks. */
export function openConcerns(
  db: Database,
  projectDirectory: string,
  filter?: { taskID?: string },
): OpenConcern[] {
  // The tables belong to the handoff store; a project that never opened it has no concerns.
  const exists = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_concern_versions'")
    .get()
  if (!exists) return []
  const rows = db
    .query<{ payload: string; node_state: string | null }, [string]>(
      `SELECT v.payload,n.state AS node_state FROM recovery_concern_versions v
         LEFT JOIN runner_nodes n ON n.plan_id=v.plan_id AND n.task_id=v.task_id
        WHERE v.project_directory=?
          AND v.version=(SELECT max(version) FROM recovery_concern_versions
                          WHERE project_directory=v.project_directory AND concern_id=v.concern_id)
          AND NOT EXISTS (SELECT 1 FROM recovery_concern_dispositions d
                           WHERE d.project_directory=v.project_directory
                             AND d.concern_id=v.concern_id AND d.version=v.version)`,
    )
    .all(projectDirectory)
  const open: OpenConcern[] = []
  for (const row of rows) {
    if (row.node_state !== null && !canStruggle(row.node_state)) continue
    const record = JSON.parse(row.payload) as {
      concernID: string
      version: number
      source: { planID: string; taskID: string; attemptID: string }
      ruleID: string
      reason: string
      evidenceBoundary: { fromSequence: number; throughSequence: number }
      evidence: { reference: string; note?: string }[]
      createdAt: string
    }
    if (filter?.taskID && record.source.taskID !== filter.taskID) continue
    open.push({
      concernID: record.concernID,
      version: record.version,
      planID: record.source.planID,
      taskID: record.source.taskID,
      attemptID: record.source.attemptID,
      ruleID: record.ruleID,
      reason: record.reason,
      boundary: record.evidenceBoundary,
      evidence: record.evidence,
      recordedAt: record.createdAt,
    })
  }
  return open
}

export type DetectorDeps = {
  store: RunnerStore
  handoff: Pick<HandoffStore, "recordConcern">
  now: () => number
}

export class RecoveryDetector {
  constructor(private readonly deps: DetectorDeps) {}

  /**
   * Evaluate every running task once. Bounded: one pass over the project's running plans, a
   * fixed number of indexed reads per task, and at most `TAIL_ROWS` progress rows each.
   * Returns the concerns recorded.
   */
  evaluate(owner: string, fence: number): { concernID: string; ruleID: string; version: number }[] {
    const { store } = this.deps
    const recorded: { concernID: string; ruleID: string; version: number }[] = []
    for (const plan of store.plans()) {
      if (plan.state !== "running") continue
      for (const node of store.nodes(plan.id)) {
        if (!canStruggle(node.state) || store.repository.taskDisposition(node.task_id)) continue
        const attempt = store
          .attempts(plan.id)
          .filter((a) => a.task_id === node.task_id)
          .at(-1)
        if (!attempt || !["preparing", "running", "verifying"].includes(attempt.state)) continue
        const scope = store.effectiveWriteScope(node.task_id)
        const { facts, tail } = store.read((db) => ({
          // Transitions are stamped with the wall clock, so open intervals end on it too.
          facts: readStrugglingFacts(db, plan.id, node.task_id, Date.now()),
          tail: readTrajectoryTail(db, store.repository.projectDirectory, attempt.id, scope),
        }))
        const where = `attempt ${attempt.id} of task ${node.task_id} in plan ${plan.id}`
        for (const finding of evaluateRules(facts, tail, where))
          recorded.push(
            ...this.record(owner, fence, plan.id, node.task_id, attempt.id, finding, tail),
          )
      }
    }
    return recorded
  }

  private record(
    owner: string,
    fence: number,
    planID: string,
    taskID: string,
    attemptID: string,
    finding: Finding,
    tail: TrajectoryTail,
  ) {
    const { store, handoff } = this.deps
    const concernID = concernIDFor(attemptID, finding.ruleID)
    const { latest, disposition } = store.read((db) => {
      const row = db
        .query<VersionRow, [string, string]>(
          `SELECT version,payload FROM recovery_concern_versions
            WHERE project_directory=? AND concern_id=? ORDER BY version DESC LIMIT 1`,
        )
        .get(store.repository.projectDirectory, concernID)
      const dispositionRow = row
        ? db
            .query<DispositionRow, [string, string, number]>(
              `SELECT payload FROM recovery_concern_dispositions
                WHERE project_directory=? AND concern_id=? AND version=?`,
            )
            .get(store.repository.projectDirectory, concernID, row.version)
        : null
      return { latest: row, disposition: dispositionRow }
    })
    let through = tail.throughSequence
    if (latest) {
      const previous = JSON.parse(latest.payload) as {
        evidenceBoundary: { throughSequence: number }
        evidence: { note?: string }[]
      }
      through = Math.max(through, previous.evidenceBoundary.throughSequence)
      // An unanswered concern is not repeated; an answered one comes back only for new evidence.
      if (!disposition) return []
      const decided = JSON.parse(disposition.payload) as {
        decision: "acknowledge" | "follow-up"
        followUp?: { kind: "at"; dueAt: string } | { kind: "condition" }
        createdAt: string
      }
      const decidedAt = Date.parse(decided.createdAt)
      if (decided.decision === "follow-up") {
        const due =
          decided.followUp?.kind === "at"
            ? Date.parse(decided.followUp.dueAt)
            : decidedAt + CONDITION_REASSESS_MS
        if (this.deps.now() < due) return []
      } else {
        const seen = Number(previous.evidence[0]?.note?.match(/magnitude=(\d+)/)?.[1] ?? 0)
        if (finding.magnitude < Math.max(2, seen * 2)) return []
      }
    }
    const version = (latest?.version ?? 0) + 1
    const receipt = handoff.recordConcern(
      {
        requestID: `detector:${concernID}:${version}`,
        concernID,
        sourceAttemptID: attemptID,
        ruleID: finding.ruleID,
        reason: finding.reason,
        evidenceBoundary: { fromSequence: 0, throughSequence: through },
        evidence: finding.evidence.map((item) => ({
          kind: item.kind,
          reference: item.reference,
          note: `${item.note}; magnitude=${finding.magnitude}`,
        })),
      },
      DETECTOR_ACTOR,
    )
    if (receipt.status !== "recorded") return []
    store.fenced(owner, fence, () =>
      store.record(planID, taskID, WORKER_CONCERN_EVENT, {
        concernID,
        ruleID: finding.ruleID,
        version,
        reason: finding.reason,
      }),
    )
    return [{ concernID, ruleID: finding.ruleID, version }]
  }
}
