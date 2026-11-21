import { createHash } from "node:crypto"
import type { PriceInputs } from "../models/price-state.ts"
import { priceIndexFromSources } from "../models/price-state.ts"
import { ModelEvidenceReadStore } from "../models/source-store.ts"
import {
  createTaskValuationReader,
  currentPriceIndexFreshness,
  type TaskValuationProvider,
} from "../models/task-valuation.ts"
import {
  storedTranscriptSession,
  transcriptRoutes,
  type TranscriptReadState,
} from "../transcript-meta/schema.ts"
import type { TrajectorySession } from "./native.ts"
import { inspectTaskEffort, type TaskEffort } from "./read.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * What one effort refresh computes, off the main thread: the task's stored facts read on a
 * read-only connection, the effort composed (`inspectTaskEffort`) and valued, and the row the
 * store writes. The effort worker runs it; tests run it in-thread with a fixed provider.
 */

/** The stored columns of `host_session_state` the effort reads. */
type EffortSessionRow = {
  session_id: string
  parent_session_id: string | null
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
  outcome: string | null
  busy: number
  last_busy_at: number | null
  last_idle_at: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  created_at: number | null
  host_updated_at: number
}

const OUTCOMES = new Set(["succeeded", "failed", "interrupted"])

/** A transcript's read state as the host session's context status. */
const CONTEXT: Record<TranscriptReadState, TrajectorySession["messageStatus"]> = {
  available: "available",
  unavailable: "unavailable",
  "not-read": "not-read",
}

/**
 * A stored session as the trajectory host's read returns it: model, outcome, busy, stamp and the
 * cumulative token snapshot; its context status is the stored transcript's read state (`not-read`
 * before the transcript fold has read it in full), its busy and idle endpoints the host record's
 * last `time.busy` / `time.idle`. The messages themselves are never here.
 */
function trajectorySessionOf(
  row: EffortSessionRow,
  projectID: string,
  context: TranscriptReadState,
): TrajectorySession {
  const tokens = [
    row.tokens_in,
    row.tokens_out,
    row.tokens_reasoning,
    row.tokens_cache_read,
    row.tokens_cache_write,
  ]
  return {
    id: row.session_id,
    projectID,
    parentID: row.parent_session_id,
    model:
      row.route_provider && row.route_model
        ? {
            providerID: row.route_provider,
            id: row.route_model,
            ...(row.route_variant ? { variant: row.route_variant } : {}),
          }
        : null,
    outcome:
      row.outcome && OUTCOMES.has(row.outcome)
        ? (row.outcome as NonNullable<TrajectorySession["outcome"]>)
        : null,
    busy: row.busy === 1,
    time: {
      created: row.created_at ?? 0,
      updated: row.host_updated_at,
      busy: row.last_busy_at,
      idle: row.last_idle_at,
    },
    tokens: tokens.every((value) => value === null)
      ? null
      : {
          input: row.tokens_in!,
          output: row.tokens_out!,
          reasoning: row.tokens_reasoning!,
          cache: { read: row.tokens_cache_read!, write: row.tokens_cache_write! },
        },
    messages: null,
    messageStatus: CONTEXT[context],
    messageError: null,
  }
}

const SESSION_COLUMNS =
  "session_id,parent_session_id,route_provider,route_model,route_variant,outcome,busy," +
  "last_busy_at,last_idle_at," +
  "tokens_in,tokens_out,tokens_reasoning,tokens_cache_read,tokens_cache_write,created_at," +
  "host_updated_at"

/**
 * `currentIndex.retrievedAt` is when the price index was read, a new value on every read (the
 * trajectory read drops it from its cursor identity for the same reason). A refresh whose effort
 * differs only there changes nothing, so it writes nothing.
 */
function effortKey(effort: TaskEffortSummary) {
  const index = effort.marketEquivalentCost?.currentIndex
  const stable = index
    ? {
        ...effort,
        marketEquivalentCost: {
          ...effort.marketEquivalentCost,
          currentIndex: { ...index, retrievedAt: null },
        },
      }
    : effort
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex")
}

/**
 * The stored summary of an effort: everything but the per-call route lists
 * (`taskEffortBasis.routes.observedStepRoutes`, `.assessments` and `.mismatches`, a filter of the
 * assessments), which grow with every model step (3,619 calls: about 2 MB of the row). Their
 * lengths stay; the lists are composed from the stored transcript and progress rows on read
 * (`computeTaskEffortDetail`).
 */
export type TaskEffortSummary = Omit<TaskEffort, "taskEffortBasis"> & {
  taskEffortBasis: Omit<TaskEffort["taskEffortBasis"], "routes"> & {
    routes: Omit<
      TaskEffort["taskEffortBasis"]["routes"],
      "observedStepRoutes" | "assessments" | "mismatches"
    > & { observedStepRouteCount: number; assessmentCount: number; mismatchCount: number }
  }
}

export function effortSummary(effort: TaskEffort): TaskEffortSummary {
  const { observedStepRoutes, assessments, mismatches, ...routes } = effort.taskEffortBasis.routes
  return {
    ...effort,
    taskEffortBasis: {
      ...effort.taskEffortBasis,
      routes: {
        ...routes,
        observedStepRouteCount: observedStepRoutes.length,
        assessmentCount: assessments.length,
        mismatchCount: mismatches.length,
      },
    },
  }
}

/** The stored row of one task: its effort summary as JSON and the columns a list reads. */
export type EffortRow = {
  busy: number
  uncached_input: number | null
  output: number | null
  reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  sessions: number
  known_sessions: number
  market_value: string | null
  market_status: string | null
  price_index: string | null
  effort: string
  /** The effort's identity: its JSON without the per-read index time, hashed (SHA-256). */
  effort_key: string
}

function effortRow(busy: boolean, effort: TaskEffort): EffortRow {
  const summary = effortSummary(effort)
  const measured = effort.tokenUsage.measuredSubtotal
  const market = effort.marketEquivalentCost
  return {
    busy: Number(busy),
    uncached_input: measured.uncachedInput,
    output: measured.output,
    reasoning: measured.reasoning,
    cache_read: measured.cacheRead,
    cache_write: measured.cacheWrite,
    sessions: effort.tokenUsage.totalSessions,
    known_sessions: effort.tokenUsage.knownSessions,
    // A missing price is NULL, never a zero: the panel omits it.
    market_value:
      market?.valueUSD === null || market?.valueUSD === undefined ? null : String(market.valueUSD),
    market_status: market?.status ?? null,
    price_index: market?.currentIndex?.indexID ?? null,
    effort: JSON.stringify(summary),
    effort_key: effortKey(summary),
  }
}

/** A task's row, or undefined when the task is gone or not this project's. */
export type TaskEffortCompute = (
  taskID: string,
  signal: AbortSignal,
) => Promise<EffortRow | undefined>

/**
 * A project's stored session reader: `host_session_state` as the trajectory host's read returns a
 * session, its context status the stored transcript's read state; null for a session not stored.
 */
export function storedSessionOf(repository: TaskRepository, project: string, projectID: string) {
  const session = repository.read((db) =>
    db.query<EffortSessionRow, [string, string]>(
      `SELECT ${SESSION_COLUMNS} FROM host_session_state
       WHERE project_directory=? AND session_id=?`,
    ),
  )
  return (sessionID: string) => {
    const row = repository.read(() => session.get(project, sessionID))
    if (!row) return null
    const transcript = repository.read((db) => storedTranscriptSession(db, project, sessionID))
    return trajectorySessionOf(row, projectID, transcript?.state ?? "not-read")
  }
}

/** The task's whole effort from stored facts on a read-only connection, valued by `provider`. */
async function storedTaskEffort(
  path: string,
  project: string,
  projectID: string,
  taskID: string,
  provider: TaskValuationProvider,
  signal: AbortSignal,
) {
  const connection = openReadOnlyTrajectoryStore(path, project)
  try {
    const { repository } = connection.store
    return await inspectTaskEffort(
      connection.store,
      projectID,
      taskID,
      storedSessionOf(repository, project, projectID),
      {
        taskValuationProvider: provider,
        signal,
        transcriptOf: (sessionID, below) => {
          const stored = repository.read((db) => storedTranscriptSession(db, project, sessionID))
          return stored
            ? {
                messageCount: stored.messageCount,
                routes: transcriptRoutes((run) => repository.read(run), project, sessionID, below),
              }
            : undefined
        },
      },
    )
  } finally {
    connection.close()
  }
}

/** Compute one task's row on the calling thread, valued by `provider`. */
export async function computeTaskEffort(
  path: string,
  project: string,
  projectID: string,
  taskID: string,
  provider: TaskValuationProvider,
  signal: AbortSignal,
): Promise<EffortRow | undefined> {
  const result = await storedTaskEffort(path, project, projectID, taskID, provider, signal)
  return result ? effortRow(result.busy, result.effort) : undefined
}

/**
 * The task's whole effort, per-call route lists included, composed from the stored rows on the
 * calling thread (the effort worker's detail read): what the stored summary leaves out.
 */
export async function computeTaskEffortDetail(
  path: string,
  project: string,
  projectID: string,
  taskID: string,
  provider: TaskValuationProvider,
  signal: AbortSignal,
): Promise<TaskEffort | undefined> {
  return (await storedTaskEffort(path, project, projectID, taskID, provider, signal))?.effort
}

/**
 * The Models task valuation over the configured cached price sources, as
 * `createModelsTaskValuationProvider` builds it, with the OpenCode-owned inputs (source order,
 * OpenRouter access) read on the main thread and passed in: the evidence is read here, from
 * SQLite, so the provider runs on any thread.
 */
export function storedPriceProvider(
  path: string,
  project: string,
  inputs: PriceInputs,
): TaskValuationProvider {
  return createTaskValuationReader(async (routes, signal) => {
    signal.throwIfAborted()
    const store = new ModelEvidenceReadStore(path, project)
    try {
      const sources = store.readComparisonSources()
      signal.throwIfAborted()
      const { index, settings } = priceIndexFromSources({ ...inputs, sources, routes })
      return { index, freshness: currentPriceIndexFreshness(index, sources), settings, sources }
    } finally {
      store.close()
    }
  })
}
