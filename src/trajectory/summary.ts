import type { Database } from "bun:sqlite"
import { isTakeoverAttempt, openConcerns } from "../recovery/detector.ts"
import type { RunnerStore } from "../runner/store.ts"
import type { TaskSpec } from "../task.ts"
import { storedTranscriptSession } from "../transcript-meta/schema.ts"
import { storedSessionOf } from "./effort-compute.ts"
import { readTaskEffort } from "./effort-store.ts"
import type { CheckView } from "./events.ts"
import { modelView } from "./message-events.ts"
import type { TrajectorySession } from "./native.ts"
import { privacyStats, safeText, type PrivacyStats } from "./privacy.ts"
import {
  ACTIVE_ATTEMPTS,
  attemptView,
  focusedPlanViews,
  privacyView,
  snapshots,
  taskView,
  type PlanSnapshot,
} from "./read.ts"

/**
 * The summary sections of `lz-inspect-trajectory` (task, plans, attempts, effort, coverage,
 * privacy), composed from stored rows only: no host read and no message text.
 *
 * ```
 * task, plans    tasks, runner_plans ⋈ runner_nodes, runner_attempts; waitingOn: task_schedule
 * checks         task_events (kind check, the stored check view in `detail`)
 * attempts       runner_attempts + host_session_state + transcript_steps routes + open concerns
 * effort         trajectory_task_effort (the stored summary; per-call routes are events rows)
 * coverage       transcript_sessions read state, task_events progress counts
 * ```
 *
 * The section builders are the old read's (`read.ts`), fed stored rows instead of a host read, so
 * a field means what it meant there.
 */
type Concern = { line: string; action?: string; because?: string }

/** Check rows read per statement: a unit of work, the loop reads every check of the task. */
const CHECK_PAGE = 200

function storedChecks(db: Database, project: string, taskID: string) {
  const page = db.query<
    {
      id: number
      plan_id: string | null
      detail: string | null
      sort_at: number
      sort_key: string
    },
    [string, string, number, number]
  >(
    `SELECT id,plan_id,detail,sort_at,sort_key FROM task_events
     WHERE project_directory=? AND task_id=? AND kind='check' AND id>? ORDER BY id LIMIT ?`,
  )
  const rows: ReturnType<typeof page.all> = []
  for (let after = 0; ;) {
    const next = page.all(project, taskID, after, CHECK_PAGE)
    rows.push(...next)
    if (next.length < CHECK_PAGE) break
    after = next.at(-1)!.id
  }
  rows.sort((a, b) => a.sort_at - b.sort_at || (a.sort_key < b.sort_key ? -1 : 1) || a.id - b.id)
  const byPlan = new Map<string, CheckView[]>()
  const all: CheckView[] = []
  for (const row of rows) {
    const check = (JSON.parse(row.detail ?? "{}") as { check?: CheckView }).check
    if (!check || row.plan_id === null) continue
    all.push(check)
    byPlan.set(row.plan_id, [...(byPlan.get(row.plan_id) ?? []), check])
  }
  return { all, byPlan }
}

/** Distinct routes read per statement: a unit of work, the loop reads them all. */
const ROUTE_PAGE = 50

/** The distinct step routes of a session's stored transcript, in first-seen order. */
function messageModels(db: Database, project: string, sessionID: string, stats: PrivacyStats) {
  const page = db.query<
    { provider_id: string; model_id: string; variant: string | null; first: number },
    [string, string, number, number]
  >(
    `SELECT provider_id,model_id,variant,MIN(ordinal) AS first FROM transcript_steps
     WHERE project_directory=? AND session_id=? AND provider_id IS NOT NULL AND model_id IS NOT NULL
     GROUP BY provider_id,model_id,variant HAVING MIN(ordinal)>? ORDER BY first LIMIT ?`,
  )
  const models: NonNullable<ReturnType<typeof modelView>>[] = []
  for (let after = -1; ;) {
    const rows = page.all(project, sessionID, after, ROUTE_PAGE)
    for (const row of rows) {
      const model = modelView(
        {
          providerID: row.provider_id,
          id: row.model_id,
          ...(row.variant !== null ? { variant: row.variant } : {}),
        },
        stats,
      )
      if (model) models.push(model)
    }
    if (rows.length < ROUTE_PAGE) return models
    after = rows.at(-1)!.first
  }
}

/** Progress rows of the task's attempts by display kind: every stored row, one aggregate. */
function progressCounts(db: Database, project: string, taskID: string) {
  const row = db
    .query<
      { facts: number; commentary: number; gaps: number; steps: number; snapshots: number },
      [string, string]
    >(
      `SELECT COUNT(*) AS facts, COALESCE(SUM(event='commentary'),0) AS commentary,
         COALESCE(SUM(event='gap'),0) AS gaps, COALESCE(SUM(event='step'),0) AS steps,
         COALESCE(SUM(event='usage-snapshot'),0) AS snapshots
       FROM task_events WHERE project_directory=? AND task_id=? AND kind='progress'`,
    )
    .get(project, taskID)!
  return {
    facts: row.facts,
    truncated: false,
    commentary: row.commentary,
    automaticFacts: row.facts - row.commentary,
    recoveryGaps: row.gaps,
    additiveStepMeasurements: row.steps,
    cumulativeUsageSnapshots: row.snapshots,
  }
}

function concernsOf(db: Database, project: string, taskID: string) {
  const concerns = new Map<string, Concern>()
  for (const open of openConcerns(db, project, { taskID })) {
    const known = concerns.get(open.attemptID)
    concerns.set(open.attemptID, {
      line: known ? `${known.line}; ${open.reason}` : open.reason,
      ...(open.advice ? { action: open.advice.action, because: open.advice.because } : {}),
    })
  }
  return concerns
}

/** What Tasks shows the task waiting behind (`task_schedule.blocker_task_ids`); none without a row. */
function waitingOn(db: Database, taskID: string): string[] {
  const row = db
    .query<{ blocker_task_ids: string | null }, [string]>(
      "SELECT blocker_task_ids FROM task_schedule WHERE task_id=?",
    )
    .get(taskID)
  const ids: unknown = row?.blocker_task_ids ? JSON.parse(row.blocker_task_ids) : []
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

const hasTable = (db: Database, name: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

/**
 * The summary of one project-owned task, focused on `attemptID` when given. Undefined when the
 * task is not stored.
 */
export function readTrajectorySummary(store: RunnerStore, taskID: string, attemptID?: string) {
  const stats = privacyStats()
  const project = store.repository.projectDirectory
  const task: TaskSpec | undefined = store.repository.get(taskID)
  if (!task) return undefined
  const rawPlans: PlanSnapshot[] = snapshots(store, task, false)
  const allAttempts = rawPlans.flatMap((snapshot) =>
    snapshot.attempts.map((attempt) => ({ attempt, snapshot })),
  )
  const sessionOf = storedSessionOf(store.repository, project, task.provenance.projectID)
  const sessions = new Map<string, TrajectorySession | null>()
  // An Architect takeover has no native worker session; nothing is missing.
  for (const { attempt } of allAttempts)
    if (!isTakeoverAttempt(attempt.policy)) sessions.set(attempt.id, sessionOf(attempt.session_id))
  return store.read((db) => {
    const checks = storedChecks(db, project, task.id)
    const concerns = concernsOf(db, project, task.id)
    const transcripts = new Map<string, string>()
    for (const attemptID of sessions.keys()) {
      const { attempt } = allAttempts.find((entry) => entry.attempt.id === attemptID)!
      const transcript = storedTranscriptSession(db, project, attempt.session_id)
      transcripts.set(attempt.id, transcript?.state ?? "not-read")
    }
    const attemptViews = allAttempts.map(({ attempt, snapshot }) => {
      const session = sessions.get(attempt.id) ?? null
      return attemptView(
        attempt,
        snapshot,
        session,
        transcripts.get(attempt.id) === "available"
          ? messageModels(db, project, attempt.session_id, stats)
          : [],
        session ? "available" : "missing",
        null,
        stats,
        checks.all,
        concerns.get(attempt.id),
      )
    })
    const stored = hasTable(db, "trajectory_task_effort")
      ? readTaskEffort(db, project, task.id)
      : undefined
    const busy =
      stored?.busy ??
      allAttempts.some(
        ({ attempt }) =>
          ACTIVE_ATTEMPTS.has(attempt.state) || sessions.get(attempt.id)?.busy === true,
      )
    const statuses = [...transcripts.values()]
    return {
      task: taskView(store, task, rawPlans, stats),
      plans: focusedPlanViews(
        hasTable(db, "task_schedule") ? waitingOn(db, task.id) : [],
        rawPlans,
        checks.byPlan,
        stats,
      ),
      focusedAttemptID: attemptID ? safeText(attemptID, stats, 128) : null,
      attempts: attemptID
        ? attemptViews.filter((attempt) => attempt.id === attemptID)
        : attemptViews,
      /**
       * The stored effort summary (`trajectory_task_effort`), null until the effort fold has
       * computed the task. Its per-call route lists are counts here; each call's route is its
       * `assistant-step` row in `trajectory.events`.
       */
      effort: stored?.effort ?? null,
      effortRefreshedAt: stored?.refreshedAt ?? null,
      coverage: {
        sessionRead: "Stored host session facts (host_session_state); no host read",
        transcript:
          "Stored transcript metadata (transcript_steps, transcript_sessions); message text is not stored",
        availableSessionContexts: statuses.filter((state) => state === "available").length,
        unavailableSessionContexts: statuses.filter((state) => state === "unavailable").length,
        fullSessionHistory:
          "not guaranteed; use explicit warnings and do not infer omitted history",
        /** Compaction is in the host transcript, which this read does not open. */
        compacted: null,
        ongoing: busy,
        attemptsWithoutRecordedSessions: attemptViews.filter(
          (attempt) => attempt.sessionStatus !== "available" && !attempt.takeover,
        ).length,
        workerProgress: progressCounts(db, project, task.id),
      },
      privacy: privacyView(stats),
    }
  })
}
