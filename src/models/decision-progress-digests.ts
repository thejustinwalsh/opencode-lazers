import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { privacyStats } from "../trajectory/privacy.ts"
import { budgetFromEnv, sharedByteLru } from "./byte-lru.ts"
import {
  FACT_MALFORMED_PAYLOAD,
  FACT_UNREADABLE_EVENTS,
  FACT_UNREADABLE_SOURCES,
  projectDecisionProgressRow,
} from "./decision-progress-fact.ts"
import type { DecisionProgressSource } from "./decision-progress-fact.ts"
import {
  DECISION_PROGRESS_BATCH_SIZE,
  LIVE_ONE_SQL,
  LIVE_TAIL_SQL,
} from "./decision-progress-sql.ts"
import {
  DECISION_PROJECTION_TABLES as TABLES,
  decisionProjectionStats,
} from "./decision-projection-tables.ts"
import { digestSessionFacts } from "./valuation.ts"
import type { SessionFactDigest } from "./valuation.ts"

/**
 * The decision valuation of a project, read by session (design/data-handling.md, "Models
 * valuation by session"). A read learns which sessions' facts changed since it last looked from
 * the stored change clock, reads the facts of exactly those sessions through the session index,
 * and reduces each to a `SessionFactDigest`. Digests are kept in a byte-budgeted LRU keyed by
 * (database, project, epoch, session, stamp); a miss re-reads that one session, so eviction never
 * refuses work. Rows the fold has not reached (queued updates and deletes, rows above the
 * watermark, tasks entering or leaving) are read live and their sessions are keyed by the content
 * read, so the facts are the same however far the fold lags.
 */

/**
 * Budget of the digest cache. Measured on the seeded history of the valuation tests (4 000 facts
 * in 330 sessions): a digest retains about 0.85 KiB of heap per fact, memo included, so 96 MiB
 * holds roughly 115 000 facts, more than the largest project observed. Eviction drops the oldest
 * digests and a miss re-reads that one session, so a smaller budget costs reads, never results;
 * a project larger than the budget re-reads every session on every revision, as before.
 */
const DIGEST_BUDGET_MIB = 96
const digestCache = sharedByteLru<SessionFactDigest>(
  "models.decisionSessionDigest",
  budgetFromEnv("LAZERS_DECISION_DIGEST_MB", DIGEST_BUDGET_MIB),
)

type StampEntry = { epoch: string; clock: number; stamps: Map<string, number> }
const stampKey = Symbol.for("lazers.models.decisionSessionStamps.v1")
const host = globalThis as typeof globalThis & { [stampKey]?: Map<string, StampEntry> }
/** Per database and project, the clock this process last read and each session's stamp. */
const stampMaps = (host[stampKey] ??= new Map<string, StampEntry>())

export type DecisionDigestRead = {
  digests: Map<string, SessionFactDigest>
  factCount: number
  /** Stored or live rows excluded because their payload is not JSON, and lineage notes. */
  invalidCount: number
  unreadableSourceLineage: number
  unreadableEventLineage: number
  /** What changes when the retained facts change, in place of hashing every fact. */
  identity: unknown[]
}

type DigestState = {
  foldedSeq: number
  epoch: string
  clock: number
  tasksFoldedRowid: number
}

/**
 * The projection state of a project when its stored facts carry their session; null when the
 * projection is absent, being dropped, or not yet labelled (an older database, or the owner has
 * not upgraded the schema), which is when the caller reads every fact live.
 */
function readDigestState(db: Database, project: string): DigestState | null {
  const tables = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
       ('${TABLES.facts}','${TABLES.state}','${TABLES.dirty}','${TABLES.sessions}','${TABLES.taskDirty}')`,
    )
    .get()
  if (tables?.n !== 5) return null
  const has = (table: string, names: string[]) => {
    const columns = new Set(
      db
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((column) => column.name),
    )
    return names.every((name) => columns.has(name))
  }
  if (
    !has(TABLES.state, [
      "epoch",
      "session_clock",
      "sessions_ready",
      "dropping",
      "tasks_folded_rowid",
    ]) ||
    !has(TABLES.facts, ["session_id"])
  )
    return null
  const row = db
    .query<
      {
        folded_seq: number
        epoch: string
        session_clock: number
        sessions_ready: number
        dropping: number
        tasks_folded_rowid: number
      },
      [string]
    >(
      `SELECT folded_seq,epoch,session_clock,sessions_ready,dropping,tasks_folded_rowid
       FROM ${TABLES.state} WHERE project_directory=?`,
    )
    .get(project)
  if (!row || row.dropping || !row.sessions_ready || !row.epoch) return null
  return {
    foldedSeq: row.folded_seq,
    epoch: row.epoch,
    clock: row.session_clock,
    tasksFoldedRowid: row.tasks_folded_rowid,
  }
}

/** Sessions stamped after (changed, session_id); an empty id sorts before every session. */
const STAMPS_SQL = `
  SELECT session_id,changed FROM ${TABLES.sessions}
  WHERE project_directory=? AND (changed>? OR (changed=? AND session_id>?))
  ORDER BY changed,session_id LIMIT ?`

/** The stored facts of one session that the joins keep, in sequence order. */
const SESSION_FACTS_SQL = `
  SELECT f.seq,f.fact FROM ${TABLES.facts} f
  JOIN runner_plans p ON p.id=f.plan_id
  JOIN tasks t ON t.id=f.task_id AND t.project_directory=p.project_directory
  WHERE f.project_directory=? AND p.project_directory=? AND f.session_id=? AND f.seq>? AND f.seq<=?
  ORDER BY f.seq LIMIT ?`

const FLAGGED_SQL = `
  SELECT f.seq,f.flags FROM ${TABLES.facts} f
  JOIN runner_plans p ON p.id=f.plan_id
  JOIN tasks t ON t.id=f.task_id AND t.project_directory=p.project_directory
  WHERE f.project_directory=? AND p.project_directory=? AND f.flags<>0 AND f.seq>? AND f.seq<=?
  ORDER BY f.seq LIMIT ?`

type LiveFact = { seq: number; fact: Record<string, unknown>; text: string }

/** Read the project's facts as per-session digests; null when the projection cannot serve it. */
export function readDecisionDigests(
  db: Database,
  path: string,
  project: string,
  signal?: AbortSignal,
): DecisionDigestRead | null {
  const state = readDigestState(db, project)
  if (!state) return null
  const batch = DECISION_PROGRESS_BATCH_SIZE

  // 1. Which sessions changed since this process last looked.
  const mapKey = `${path}\u0000${project}`
  let entry = stampMaps.get(mapKey)
  if (!entry || entry.epoch !== state.epoch || entry.clock > state.clock) {
    entry = { epoch: state.epoch, clock: 0, stamps: new Map() }
    stampMaps.set(mapKey, entry)
  }
  if (entry.clock < state.clock) {
    // Every write of a stamp commits with the clock it advances, so what this read sees at or
    // below `entry.clock` is complete; only rows above it are new. The seed id is the first
    // string of its stamp, so `changed=clock` rows (already seen) are skipped by `changed>`.
    let afterChanged = entry.clock
    let afterSession = "\u{10ffff}"
    for (;;) {
      signal?.throwIfAborted()
      const page = db
        .query<{ session_id: string; changed: number }, [string, number, number, string, number]>(
          STAMPS_SQL,
        )
        .all(project, afterChanged, afterChanged, afterSession, batch)
      for (const row of page) {
        entry.stamps.set(row.session_id, row.changed)
        afterChanged = row.changed
        afterSession = row.session_id
      }
      if (page.length < batch) break
    }
    entry.clock = state.clock
  }

  // 2. Rows the fold has not reached, read live.
  const liveBySession = new Map<string, LiveFact[]>()
  const excluded = new Set<number>()
  const suspect = new Set<string>()
  const stats = privacyStats()
  let invalidCount = 0
  let unreadableSourceLineage = 0
  let unreadableEventLineage = 0
  let liveCount = 0
  let lastLiveSeq = 0
  const flagged = (flags: number) => {
    if (flags & FACT_MALFORMED_PAYLOAD) invalidCount++
    else {
      if (flags & FACT_UNREADABLE_SOURCES) unreadableSourceLineage++
      if (flags & FACT_UNREADABLE_EVENTS) unreadableEventLineage++
    }
  }
  const takeLive = (row: DecisionProgressSource) => {
    decisionProjectionStats.readSourceRows++
    const projected = projectDecisionProgressRow(row, stats)
    flagged(projected.flags)
    if (!projected.fact) return
    const session = row.session_id ?? ""
    const list = liveBySession.get(session)
    const live = { seq: row.seq, fact: projected.fact, text: JSON.stringify(projected.fact) }
    if (list) list.push(live)
    else liveBySession.set(session, [live])
    suspect.add(session)
    liveCount++
    lastLiveSeq = Math.max(lastLiveSeq, row.seq)
  }
  const dirtySeqs: number[] = []
  for (let after = 0; ;) {
    const page = db
      .query<{ seq: number }, [string, number, number]>(
        `SELECT seq FROM ${TABLES.dirty} WHERE project_directory=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(project, after, batch)
    for (const row of page) {
      after = row.seq
      dirtySeqs.push(row.seq)
    }
    if (page.length < batch) break
  }
  for (const seq of dirtySeqs) {
    excluded.add(seq)
    const stored = db
      .query<{ session_id: string | null }, [string, number]>(
        `SELECT session_id FROM ${TABLES.facts} WHERE project_directory=? AND seq=?`,
      )
      .get(project, seq)
    if (stored?.session_id != null) suspect.add(stored.session_id)
    const row = db
      .query<DecisionProgressSource, [number, string, string]>(LIVE_ONE_SQL)
      .get(seq, project, project)
    if (row) takeLive(row)
  }
  let afterSeq = state.foldedSeq
  for (;;) {
    signal?.throwIfAborted()
    const rows = db
      .query<DecisionProgressSource, [string, string, number, number]>(LIVE_TAIL_SQL)
      .all(project, project, afterSeq, batch)
    for (const row of rows) {
      afterSeq = row.seq
      takeLive(row)
    }
    if (rows.length < batch) break
  }
  // Tasks the fold has not folded yet decide which stored facts are visible.
  const unfoldedTasks = new Set<string>()
  for (const row of db
    .query<{ task_id: string }, [string]>(
      `SELECT task_id FROM ${TABLES.taskDirty} WHERE project_directory=?`,
    )
    .iterate(project))
    unfoldedTasks.add(row.task_id)
  for (const row of db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM tasks WHERE project_directory=? AND rowid>? ORDER BY rowid",
    )
    .iterate(project, state.tasksFoldedRowid))
    unfoldedTasks.add(row.id)
  const sessionsOfTask = db.query<{ session_id: string }, [string, string]>(
    `SELECT DISTINCT session_id FROM ${TABLES.facts}
     WHERE project_directory=? AND task_id=? AND session_id IS NOT NULL`,
  )
  for (const id of unfoldedTasks)
    for (const row of sessionsOfTask.iterate(project, id)) suspect.add(row.session_id)

  // 3. Notes: stored rows with a flag are rare, so they are listed through their own index.
  for (let after = 0; ;) {
    signal?.throwIfAborted()
    const rows = db
      .query<{ seq: number; flags: number }, [string, string, number, number, number]>(FLAGGED_SQL)
      .all(project, project, after, state.foldedSeq, batch)
    for (const row of rows) {
      after = row.seq
      if (!excluded.has(row.seq)) flagged(row.flags)
    }
    if (rows.length < batch) break
  }

  // 4. One digest per session, from the cache or from that session's facts.
  const sessions = new Set([...entry.stamps.keys(), ...liveBySession.keys()])
  const digests = new Map<string, SessionFactDigest>()
  let factCount = 0
  for (const session of sessions) {
    signal?.throwIfAborted()
    decisionProjectionStats.digestSessions++
    const base = `${path}\u0000${project}\u0000${state.epoch}\u0000${session}`
    const stampedKey = `${base}\u0000s${entry.stamps.get(session) ?? 0}`
    if (!suspect.has(session)) {
      const cached = digestCache.get(stampedKey)
      if (cached) {
        decisionProjectionStats.digestHits++
        if (cached.factCount) {
          digests.set(session, cached)
          factCount += cached.factCount
        }
        continue
      }
    }
    const facts: Array<{ seq: number; fact: Record<string, unknown> }> = []
    const content = createHash("sha256")
    for (let after = 0; ;) {
      signal?.throwIfAborted()
      const rows = db
        .query<
          { seq: number; fact: string | null },
          [string, string, string, number, number, number]
        >(SESSION_FACTS_SQL)
        .all(project, project, session, after, state.foldedSeq, batch)
      for (const row of rows) {
        after = row.seq
        if (row.fact === null || excluded.has(row.seq)) continue
        decisionProjectionStats.digestFactsRead++
        facts.push({ seq: row.seq, fact: JSON.parse(row.fact) as Record<string, unknown> })
        if (suspect.has(session)) content.update(`${row.seq}:${row.fact}\n`)
      }
      if (rows.length < batch) break
    }
    const live = liveBySession.get(session) ?? []
    for (const row of live) {
      facts.push({ seq: row.seq, fact: row.fact })
      content.update(`${row.seq}:${row.text}\n`)
    }
    if (live.length || excluded.size) facts.sort((left, right) => left.seq - right.seq)
    const key = suspect.has(session) ? `${base}\u0000c${content.digest("hex")}` : stampedKey
    const cached = suspect.has(session) ? digestCache.get(key) : undefined
    let digest: SessionFactDigest
    if (cached) {
      decisionProjectionStats.digestHits++
      digest = cached
    } else {
      decisionProjectionStats.digestBuilds++
      digest = digestSessionFacts(
        session,
        facts.map(({ seq, fact }) => ({ ord: seq, fact })),
        { shared: true },
      )
      digestCache.set(key, digest, digest.bytes)
    }
    if (digest.factCount) {
      digests.set(session, digest)
      factCount += digest.factCount
    }
  }
  return {
    digests,
    factCount,
    invalidCount,
    unreadableSourceLineage,
    unreadableEventLineage,
    identity: [state.epoch, state.clock, state.foldedSeq, liveCount, lastLiveSeq, excluded.size],
  }
}

/** Counters of the digest cache, for diagnostics and tests. */
export const decisionDigestCache = digestCache

/** Forget every digest and stamp, as a restart does: the next read reads each session once. */
export function resetDecisionDigestCache() {
  digestCache.clear()
  stampMaps.clear()
}
