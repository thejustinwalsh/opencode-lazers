import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { RunnerStore } from "../runner/store.ts"
import type { HandoffStore } from "./handoff/store.ts"
import {
  canStruggle,
  durationLabel,
  readTrajectoryFacts,
  readTrajectoryTail,
  tokenLabel,
  type TrajectoryFacts,
  type TrajectoryTail,
} from "./trajectory-facts.ts"

export type { TrajectoryTail }

/**
 * The producer of recovery concerns. Deterministic rules read the recorded trajectory of each
 * running task (runner transitions, attempts and the progress journal) and record a concern
 * through the handoff store, where versions, dispositions and Architect follow-ups already
 * live. The detector never pauses, cancels or steers a worker; the Architect decides. It keeps
 * no memory of its own: concern ids are derived from the attempt and rule, and every decision
 * to record or skip reads the stored versions, so ticks and reloads agree.
 *
 * Thresholds prefer lack of progress and repeated cycles over size. Replayed over the 173
 * accepted, 25 failed or cancelled and 3 live tasks of the production database (Nov 2026) with
 * `bun scripts/replay-concerns.ts`: the full rule set flags 9 of 173 accepted tasks (5.2%), of
 * which 8 had churn on record (three or more verification rounds or a reopen after acceptance).
 * The previous raw-size thresholds (3 verification rounds, 75M tokens, 4h, 3 repairs) flagged
 * 32 of 175 (18%). Each constant carries its own replay count.
 */
export const DETECTOR_THRESHOLDS = {
  /**
   * A verification round that failed after this many tokens. The next repair costs about as
   * much again. Alone it flags 6 of 173 accepted tasks (3.5%) and, on LZ-200, fires at 51M
   * tokens after 1.9h, where the old rules fired at 87M.
   */
  verifyFailureTokens: 50_000_000,
  /** The same failure after this much spend recommends taking over instead of steering. */
  verifyTakeoverTokens: 75_000_000,
  /** Repairs and resumes at or past this count, with `repairCycleTokens` spent: 5 of 173, all of them also caught above. */
  repairCycles: 3,
  repairCycleTokens: 60_000_000,
  /** The Architect reopened the task after accepting it this many times. 2 of 173 (1.2%). */
  reopenedAfterAccept: 3,
  /** Tokens since the last file change. Healthy tasks peak at 10.9M, so this flags 0 of 173. */
  tokensWithoutFileChange: 12_000_000,
  /** Raw size as a backstop only. 1 of 173 (0.6%); 75M flagged 8 and 100M flagged 5. */
  tokens: 150_000_000,
  /** Worker time. Healthy tasks reach 23.8h at most; 0 of 173, and it catches a worker left open for days. */
  attemptMs: 36 * 3_600_000,
  /** Interrupted workers. Healthy tasks peak at 2; 3 flags 0 of 173. */
  interruptions: 3,
  /** The same hold family. No accepted task was held for one reason three times; the look-back is empty. */
  sameHoldFamily: 3,
  /** Consecutive failed tool calls at the end of an attempt. 1 of 173 reaches 6. */
  trailingToolFailures: 6,
  /** Tool calls since the last edit or patch. The longest healthy stretch is 150; 0 of 173. */
  callsWithoutFileChange: 200,
  /** Distinct files edited outside the write scope; 1 or 2 are routine scope amendments (16 of 173), 3 flags 1. */
  outOfScopePaths: 3,
} as const

export type DetectorThresholds = { readonly [K in keyof typeof DETECTOR_THRESHOLDS]: number }

/** A follow-up on a condition cannot be evaluated by the runtime; reassess it after this long. */
const CONDITION_REASSESS_MS = 2 * 3_600_000

const WORKER_CONCERN_EVENT = "WORKER_CONCERN_RAISED"
export const DETECTOR_ACTOR = {
  sessionID: "lazers-runtime",
  agent: "lazers-runtime",
  role: "runtime",
} as const

export type RuleID =
  | "verify-rounds-repeated"
  | "repair-cycles-repeated"
  | "reopened-after-accept"
  | "spend-without-file-change"
  | "token-spend-high"
  | "worker-time-long"
  | "interruptions-repeated"
  | "hold-family-repeated"
  | "out-of-scope-write"
  | "tool-failures-repeated"
  | "no-file-changes"
  | "spend-ceiling"

/**
 * What the Architect is advised to do, from the `lz-plan-command` and recovery tool vocabulary:
 * `acknowledge` lets the worker continue (`lz-disposition-recovery-concern`), `steer` checks in
 * with it (`lz-checkpoint-recovery-worker`), `takeover` stops it and finishes in its workspace
 * (`lz-request-handoff`, then `lz-plan-command takeover-submit`), `cancel` ends the task.
 */
export type ConcernAction = "acknowledge" | "steer" | "takeover" | "cancel"

export type Finding = {
  ruleID: RuleID
  reason: string
  /** The rule's measure in its natural unit; materially larger than before is new evidence. */
  magnitude: number
  action: ConcernAction
  /** One sentence naming the exact tool call that follows from the evidence. */
  because: string
  evidence: { kind: "trajectory" | "other"; reference: string; note: string }[]
}

export type RuleOptions = {
  thresholds?: DetectorThresholds
  /** Owner-set ceiling on a task's total tokens; off when undefined. */
  spendCeilingTokens?: number
}

const million = (tokens: number) => Math.floor(tokens / 1_000_000)

/** Pure: facts and tail in, findings out. */
export function evaluateRules(
  facts: TrajectoryFacts,
  tail: TrajectoryTail,
  where: string,
  options: RuleOptions = {},
): Finding[] {
  const t = options.thresholds ?? DETECTOR_THRESHOLDS
  const found: Finding[] = []
  const add = (
    ruleID: RuleID,
    reason: string,
    magnitude: number,
    action: ConcernAction,
    because: string,
    note: string,
  ) =>
    found.push({
      ruleID,
      reason,
      magnitude,
      action,
      because,
      evidence: [{ kind: "trajectory", reference: where, note }],
    })
  if (facts.verifyFailures >= 1 && facts.tokens >= t.verifyFailureTokens) {
    const takeover = facts.tokens >= t.verifyTakeoverTokens
    add(
      "verify-rounds-repeated",
      `verification failed ${facts.verifyFailures} time(s) in ${facts.verifyRounds} round(s) after ${tokenLabel(facts.tokens)} tokens`,
      million(facts.tokens),
      takeover ? "takeover" : "steer",
      takeover
        ? "Each further repair costs about what was already spent; lz-request-handoff, then finish the task in its workspace with lz-plan-command takeover-submit."
        : "Send the failing check output to the worker with lz-checkpoint-recovery-worker before it spends another repair on it.",
      "VERIFY and REPAIR transitions of this task; attempt token counts, summed",
    )
  }
  if (facts.repairsAndResumes >= t.repairCycles && facts.tokens >= t.repairCycleTokens)
    add(
      "repair-cycles-repeated",
      `${facts.repairsAndResumes} repairs and resumes after ${tokenLabel(facts.tokens)} tokens`,
      facts.repairsAndResumes,
      "takeover",
      "The worker is not converging across repair cycles; lz-request-handoff, then finish the task with lz-plan-command takeover-submit.",
      "REPAIR, RESUME, RETAINED_REPAIR and RETRY_REQUESTED transitions",
    )
  if (facts.reopenedAfterAccept >= t.reopenedAfterAccept)
    add(
      "reopened-after-accept",
      `reopened ${facts.reopenedAfterAccept} times after acceptance`,
      facts.reopenedAfterAccept,
      "takeover",
      "The accepted result keeps coming back; lz-request-handoff, then finish the task with lz-plan-command takeover-submit.",
      "RETAINED_REPAIR transitions from accepted",
    )
  if (tail.tokensWithoutFileChange >= t.tokensWithoutFileChange)
    add(
      "spend-without-file-change",
      `${tokenLabel(tail.tokensWithoutFileChange)} tokens since the last file change`,
      million(tail.tokensWithoutFileChange),
      "takeover",
      "Heavy spend with no file progress; lz-request-handoff to read what the worker learned, then finish the task with lz-plan-command takeover-submit.",
      "step token counts since the last edit or patch call in the progress journal",
    )
  if (facts.tokens >= t.tokens)
    add(
      "token-spend-high",
      `${tokenLabel(facts.tokens)} tokens across ${facts.attempts} attempt(s)`,
      million(facts.tokens),
      "takeover",
      "Spend is far past any landed task; lz-request-handoff, then finish the task, or split it and lz-plan-command cancel.",
      "attempt token counts, summed",
    )
  if (facts.attemptMs >= t.attemptMs)
    add(
      "worker-time-long",
      `${durationLabel(facts.attemptMs)} of worker time`,
      Math.floor(facts.attemptMs / 3_600_000),
      "steer",
      "No healthy task ran this long; lz-checkpoint-recovery-worker to find out whether the worker is stuck.",
      "worker start or resume to stop, summed",
    )
  if (facts.interruptions >= t.interruptions)
    add(
      "interruptions-repeated",
      `${facts.interruptions} interruptions`,
      facts.interruptions,
      "acknowledge",
      "Only interruptions repeated and the work may be fine; lz-disposition-recovery-concern acknowledge, and let it continue.",
      "WORKER_STOPPED transitions with outcome interrupted",
    )
  if (facts.repeatedHold && facts.repeatedHold.count >= t.sameHoldFamily)
    add(
      "hold-family-repeated",
      `held ${facts.repeatedHold.count} times for ${facts.repeatedHold.family}`,
      facts.repeatedHold.count,
      "steer",
      `The same hold (${facts.repeatedHold.family}) keeps recurring; lz-checkpoint-recovery-worker with what the hold requires.`,
      "BLOCKED transitions of one hold family",
    )
  if (tail.protectedWrites.length)
    add(
      "out-of-scope-write",
      `wrote protected paths: ${tail.protectedWrites.slice(0, 6).join(", ")}`,
      tail.protectedWrites.length,
      "steer",
      "The worker wrote a protected path, the one hard scope boundary; lz-checkpoint-recovery-worker to stop it and revert, or take it over with lz-request-handoff.",
      `paths: ${tail.protectedWrites.slice(0, 20).join(", ")}`,
    )
  else if (tail.outOfScope.length >= t.outOfScopePaths)
    add(
      "out-of-scope-write",
      `edited outside the write scope: ${tail.outOfScope.slice(0, 6).join(", ")}`,
      tail.outOfScope.length,
      "steer",
      "The worker diverged from the planned scope; lz-checkpoint-recovery-worker to stop it, and review the paths before accepting (lz-plan-command amend-scope only if the writes were right).",
      `paths: ${tail.outOfScope.slice(0, 20).join(", ")}`,
    )
  if (tail.trailingToolFailures >= t.trailingToolFailures)
    add(
      "tool-failures-repeated",
      `the last ${tail.trailingToolFailures} tool calls all failed`,
      tail.trailingToolFailures,
      "steer",
      "A failing tool call is being repeated; lz-checkpoint-recovery-worker with the error and a different approach.",
      "newest tool calls in the progress journal",
    )
  if (tail.callsWithoutFileChange >= t.callsWithoutFileChange)
    add(
      "no-file-changes",
      `${tail.callsWithoutFileChange} tool calls since the last file change`,
      tail.callsWithoutFileChange,
      "steer",
      "The worker keeps reading without changing a file; lz-checkpoint-recovery-worker to ask what is blocking it.",
      "newest tool calls in the progress journal",
    )
  if (options.spendCeilingTokens !== undefined && facts.tokens >= options.spendCeilingTokens)
    add(
      "spend-ceiling",
      `${tokenLabel(facts.tokens)} tokens, past the ${tokenLabel(options.spendCeilingTokens)} spend ceiling`,
      million(facts.tokens),
      "takeover",
      "The task is past the spend ceiling you set; lz-request-handoff, then finish it with lz-plan-command takeover-submit.",
      "attempt token counts, summed; workerSpendCeilingTokens option",
    )
  return found
}

/** A stable UUID for one rule on one attempt, so replays and reopens address one concern. */
export function concernIDFor(attemptID: string, ruleID: string): string {
  const h = createHash("sha256").update(`lazers-concern:${attemptID}:${ruleID}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Rules over the whole task. Their concern follows the task across attempts, so a repair that
 * starts a new attempt does not raise the same concern again; the tail rules read one attempt
 * and stay per attempt.
 */
const TASK_WIDE_RULES: ReadonlySet<string> = new Set<RuleID>([
  "verify-rounds-repeated",
  "repair-cycles-repeated",
  "reopened-after-accept",
  "token-spend-high",
  "worker-time-long",
  "interruptions-repeated",
  "hold-family-repeated",
  "spend-ceiling",
])

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
  /** The advice the rule recorded; null for a concern recorded before rules carried advice. */
  advice: { action: ConcernAction; because: string } | null
  boundary: { fromSequence: number; throughSequence: number }
  evidence: { reference: string; note?: string }[]
  recordedAt: string
}

const ADVICE_NOTE = /; magnitude=\d+; action=(acknowledge|steer|takeover|cancel); because=(.*)$/s

/** The evidence note a finding is recorded with; `magnitude=` and the advice are read back from it. */
function evidenceNote(finding: Finding, note: string): string {
  return `${note}; magnitude=${finding.magnitude}; action=${finding.action}; because=${finding.because}`
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
    .query<{ payload: string; node_state: string | null }, string[]>(
      `SELECT v.payload,n.state AS node_state FROM recovery_concern_versions v
         LEFT JOIN runner_nodes n ON n.plan_id=v.plan_id AND n.task_id=v.task_id
        WHERE v.project_directory=? ${filter?.taskID ? "AND v.task_id=?" : ""}
          AND v.version=(SELECT max(version) FROM recovery_concern_versions
                          WHERE project_directory=v.project_directory AND concern_id=v.concern_id)
          AND NOT EXISTS (SELECT 1 FROM recovery_concern_dispositions d
                           WHERE d.project_directory=v.project_directory
                             AND d.concern_id=v.concern_id AND d.version=v.version)`,
    )
    .all(projectDirectory, ...(filter?.taskID ? [filter.taskID] : []))
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
    const advised = ADVICE_NOTE.exec(record.evidence[0]?.note ?? "")
    open.push({
      concernID: record.concernID,
      version: record.version,
      planID: record.source.planID,
      taskID: record.source.taskID,
      attemptID: record.source.attemptID,
      ruleID: record.ruleID,
      reason: record.reason,
      advice: advised ? { action: advised[1] as ConcernAction, because: advised[2]! } : null,
      boundary: record.evidenceBoundary,
      evidence: record.evidence,
      recordedAt: record.createdAt,
    })
  }
  return open
}

/** A takeover attempt is the Architect working on the task, not a worker to watch. */
export function isTakeoverAttempt(policy: string): boolean {
  try {
    const parsed = JSON.parse(policy) as { takeover?: unknown } | null
    return parsed?.takeover !== undefined && parsed.takeover !== null
  } catch {
    return false
  }
}

export type DetectorDeps = {
  store: RunnerStore
  handoff: Pick<HandoffStore, "recordConcern">
  now: () => number
  /** `workerSpendCeilingTokens`: record a takeover concern past this many tokens; off when undefined. */
  spendCeilingTokens?: number | (() => number | undefined)
}

export class RecoveryDetector {
  constructor(private readonly deps: DetectorDeps) {}

  /**
   * Evaluate every running task once. Bounded: one pass over the project's running plans, a
   * fixed number of indexed reads per task, and at most `FAILURE_WINDOW` progress rows each.
   * Returns the concerns recorded.
   */
  evaluate(owner: string, fence: number): { concernID: string; ruleID: string; version: number }[] {
    const { store } = this.deps
    const recorded: { concernID: string; ruleID: string; version: number }[] = []
    // Ids of the running plans only: a plan body is not read on a timer.
    for (const plan of store.planHeads(["running"])) {
      const attempts = store.attempts(plan.id)
      for (const node of store.nodes(plan.id)) {
        if (!canStruggle(node.state) || store.repository.taskDisposition(node.task_id)) continue
        const attempt = attempts.filter((a) => a.task_id === node.task_id).at(-1)
        if (!attempt || !["preparing", "running", "verifying"].includes(attempt.state)) continue
        if (isTakeoverAttempt(attempt.policy)) continue
        const scope = store.effectiveScope(node.task_id)
        const { facts, tail } = store.read((db) => ({
          // Transitions are stamped with the wall clock, so open intervals end on it too.
          facts: readTrajectoryFacts(db, plan.id, node.task_id, Date.now()),
          tail: readTrajectoryTail(db, store.repository.projectDirectory, attempt.id, scope),
        }))
        const where = `attempt ${attempt.id} of task ${node.task_id} in plan ${plan.id}`
        const options: RuleOptions = {}
        const ceiling =
          typeof this.deps.spendCeilingTokens === "function"
            ? this.deps.spendCeilingTokens()
            : this.deps.spendCeilingTokens
        if (ceiling !== undefined) options.spendCeilingTokens = ceiling
        for (const finding of evaluateRules(facts, tail, where, options))
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
    const { latest, disposition, taskWide } = store.read((db) => {
      const wide = TASK_WIDE_RULES.has(finding.ruleID)
        ? db
            .query<
              VersionRow & { concern_id: string; attempt_id: string },
              [string, string, string]
            >(
              `SELECT concern_id,attempt_id,version,payload FROM recovery_concern_versions
                WHERE project_directory=? AND task_id=? AND json_extract(payload,'$.ruleID')=?
                ORDER BY created_at DESC, version DESC LIMIT 1`,
            )
            .get(store.repository.projectDirectory, taskID, finding.ruleID)
        : null
      return {
        ...this.versionsOf(db, wide?.concern_id ?? concernIDFor(attemptID, finding.ruleID)),
        taskWide: wide,
      }
    })
    const concernID = taskWide?.concern_id ?? concernIDFor(attemptID, finding.ruleID)
    // A version is always recorded against the attempt that first raised the concern.
    const sourceAttemptID = taskWide?.attempt_id ?? attemptID
    let through = tail.throughSequence
    let reason = finding.reason
    if (latest) {
      const previous = JSON.parse(latest.payload) as {
        evidenceBoundary: { throughSequence: number }
        evidence: { note?: string }[]
      }
      through = Math.max(through, previous.evidenceBoundary.throughSequence)
      const seen = Number(previous.evidence[0]?.note?.match(/magnitude=(\d+)/)?.[1] ?? 0)
      const grown = finding.magnitude >= Math.max(2, seen * 2)
      if (!disposition) {
        // Unanswered: said again only when the measure has doubled, in stronger words.
        if (!grown) return []
        reason = `Escalated, still unanswered: now ${finding.reason}`
      } else {
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
        } else if (!grown) return []
      }
    }
    const version = (latest?.version ?? 0) + 1
    const receipt = handoff.recordConcern(
      {
        requestID: `detector:${concernID}:${version}`,
        concernID,
        sourceAttemptID,
        ruleID: finding.ruleID,
        reason,
        evidenceBoundary: { fromSequence: 0, throughSequence: through },
        evidence: finding.evidence.map((item) => ({
          kind: item.kind,
          reference: item.reference,
          note: evidenceNote(finding, item.note),
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
        reason,
      }),
    )
    return [{ concernID, ruleID: finding.ruleID, version }]
  }

  private versionsOf(db: Database, concernID: string) {
    const row = db
      .query<VersionRow, [string, string]>(
        `SELECT version,payload FROM recovery_concern_versions
          WHERE project_directory=? AND concern_id=? ORDER BY version DESC LIMIT 1`,
      )
      .get(this.deps.store.repository.projectDirectory, concernID)
    const dispositionRow = row
      ? db
          .query<DispositionRow, [string, string, number]>(
            `SELECT payload FROM recovery_concern_dispositions
              WHERE project_directory=? AND concern_id=? AND version=?`,
          )
          .get(this.deps.store.repository.projectDirectory, concernID, row.version)
      : null
    return { latest: row, disposition: dispositionRow }
  }
}
