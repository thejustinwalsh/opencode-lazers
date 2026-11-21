import type { Database } from "bun:sqlite"
import type { HostMessage, HostMessageClient } from "../../core/host-messages.ts"
import { HOST_MESSAGE_PAGE_SIZE } from "../../core/host-messages.ts"
import { hostPage } from "../../core/host-page.ts"
import { joinNativeEvents } from "../../core/event-hub.ts"
import { databaseChanges } from "../../database-events.ts"
import { messageSliceEvents, object, type MessageContext } from "../../trajectory/message-events.ts"
import { privacyStats, safeText } from "../../trajectory/privacy.ts"
import type { TaskEffort } from "../../trajectory/read.ts"
import { HINT_EVENT_TYPES } from "../../transcript-meta/fold.ts"
import { dateMillis } from "../../transcript-meta/step.ts"
import {
  defineHostSource,
  hostRuntime,
  type HostPager,
  type HostPageRequest,
  type HostPageResult,
} from "../host-source.ts"
import { authorizeTask } from "./trajectory.ts"
import {
  TRAJECTORY_SOURCES,
  trajectoryEffortColumns,
  trajectoryEffortDetail,
  trajectoryTranscriptColumns,
  type TrajectoryEffortFilter,
  type TrajectoryTranscriptFilter,
} from "./trajectory-ref.ts"

/**
 * The Trajectory panel's host-backed sources (`../host-source.ts`).
 *
 * ```
 * trajectory.transcript  message.list (OpenCode) ─ cursor pages ─► privacy filter ─► rows
 *                        nothing is stored; the window's edges are host cursors
 * trajectory.effort      trajectory_task_effort (the stored summary row)
 *                        + at window 1 the composed full effort from the effort worker
 * ```
 *
 * The host's view of the world arrives through a per-project runtime the core binds
 * (`bindHostRuntime`, `src/core/core.ts`). Host sources are opened only on the main thread, so the
 * reader worker never needs them.
 */
export type TrajectoryHostRuntime = {
  messages: HostMessageClient
  /** The native event context (`joinNativeEvents`); without it the database hint is the only one. */
  events?: Parameters<typeof joinNativeEvents>[0]
  databasePath: string
  /** A point read on the project's repository. */
  read<T>(run: (db: Database) => T): T
  /** The task's whole effort composed in the effort worker. */
  effortDetail(taskID: string, signal: AbortSignal): Promise<TaskEffort | undefined>
  /** Queue the task's effort for recomputation now (a reader opened it). */
  touchEffort(taskID: string): void
}

const runtimeOf = (projectDirectory: string) => {
  const runtime = hostRuntime(projectDirectory) as TrajectoryHostRuntime | undefined
  if (!runtime) throw new Error("The host is unavailable for this project")
  return runtime
}

// ---------------------------------------------------------------------------------------------
// trajectory.transcript
// ---------------------------------------------------------------------------------------------

/** The old read's events for one message, as rows in `trajectoryTranscriptColumns` order. */
export function messageRows(message: HostMessage, position = 0): unknown[][] {
  const raw = message as unknown as Record<string, unknown>
  const messageID = typeof raw.id === "string" ? raw.id : `unknown-${position}`
  const stats = privacyStats()
  const events: Record<string, unknown>[] = []
  const ctx: MessageContext = {
    stats,
    base: (id, at, kind) => ({ id: safeText(id, stats, 256), at, kind }),
    add: (event) => events.push(event),
  }
  messageSliceEvents(ctx, {
    message: raw,
    messageID,
    createdAt: dateMillis(object(raw.time)?.created),
  })
  return events.map((event, ordinal) => {
    const { id, at, kind, text, command, status, tool, ...rest } = event
    return [
      id,
      ordinal,
      messageID,
      kind,
      typeof at === "number" ? at : null,
      typeof text === "string" ? text : typeof command === "string" ? command : "",
      typeof status === "string" ? status : null,
      typeof tool === "string" ? tool : null,
      Object.keys(rest).length > 0 ? rest : null,
    ]
  })
}

/**
 * A boundary in the session's message list: read the page of {@link HOST_MESSAGE_PAGE_SIZE}
 * messages at host cursor `c` (`null`: the start), skip `i` messages, then `k` events of the next
 * message. The host's page cursors are the only addresses (it cannot seek by message id):
 * `next` continues after a page's last message and `previous` precedes its first, whichever
 * cursor the page was read through, so a position is exact without holding any message.
 */
type Position = { c: string | null; i: number; k: number }
const encode = (p: Position) => JSON.stringify([p.c, p.i, p.k])
const decode = (text: string): Position => {
  const [c, i, k] = JSON.parse(text) as [string | null, number, number]
  return { c, i, k }
}
const HEAD: Position = { c: null, i: 0, k: 0 }
const atHead = (p: Position) => p.c === null && p.i === 0 && p.k === 0

type Chunk = { rows: unknown[][]; start: Position; end: Position; before: boolean; after: boolean }

function messagePager(
  filter: TrajectoryTranscriptFilter,
  runtime: TrajectoryHostRuntime,
): HostPager {
  const sessionID = filter.sessionID
  const list = async (c: string | null, signal: AbortSignal) => {
    signal.throwIfAborted()
    const page = await runtime.messages.message.list({
      sessionID: sessionID as never,
      limit: HOST_MESSAGE_PAGE_SIZE,
      ...hostPage("asc", c ?? undefined),
    })
    signal.throwIfAborted()
    return {
      messages: page.data,
      next: page.cursor.next ?? null,
      previous: page.cursor.previous ?? null,
    }
  }

  /** Up to `need` rows after `from`. */
  const forward = async (from: Position, need: number, signal: AbortSignal): Promise<Chunk> => {
    const rows: unknown[][] = []
    let { c, i, k } = from
    for (;;) {
      const page = await list(c, signal)
      let at = i
      let skip = k
      while (at < page.messages.length) {
        const events = messageRows(page.messages[at]!, at).slice(skip)
        const room = need - rows.length
        if (events.length > room) {
          rows.push(...events.slice(0, room))
          const end = { c, i: at, k: skip + room }
          return { rows, start: from, end, before: !atHead(from), after: true }
        }
        rows.push(...events)
        skip = 0
        at++
        if (rows.length >= need) break
      }
      const rest = page.messages.slice(at).some((m) => messageRows(m).length > 0)
      const more = rest || page.next !== null
      if (at >= page.messages.length && page.next !== null && page.next !== c) {
        if (rows.length >= need)
          return {
            rows,
            start: from,
            end: { c: page.next, i: 0, k: 0 },
            before: !atHead(from),
            after: true,
          }
        c = page.next
        i = 0
        k = 0
        continue
      }
      return { rows, start: from, end: { c, i: at, k: 0 }, before: !atHead(from), after: more }
    }
  }

  /** Up to `need` rows before `from`, oldest first. */
  const backward = async (from: Position, need: number, signal: AbortSignal): Promise<Chunk> => {
    const reversed: unknown[][][] = []
    let taken = 0
    let { c, i, k } = from
    let page = await list(c, signal)
    for (;;) {
      for (let at = Math.min(k > 0 ? i : i - 1, page.messages.length - 1); at >= 0; at--) {
        const events = messageRows(page.messages[at]!, at)
        const slice = events.slice(0, at === i ? k : events.length)
        const room = need - taken
        if (slice.length > room) {
          reversed.push(slice.slice(slice.length - room))
          const start = { c, i: at, k: slice.length - room }
          return { rows: reversed.reverse().flat(), start, end: from, before: true, after: true }
        }
        reversed.push(slice)
        taken += slice.length
        if (taken >= need) {
          const before = at > 0 || page.previous !== null
          const start = before ? { c, i: at, k: 0 } : HEAD
          return { rows: reversed.reverse().flat(), start, end: from, before, after: true }
        }
      }
      if (page.previous === null || page.previous === c)
        return {
          rows: reversed.reverse().flat(),
          start: { c, i: 0, k: 0 },
          end: from,
          before: false,
          after: true,
        }
      c = page.previous
      page = await list(c, signal)
      i = page.messages.length
      k = 0
    }
  }

  /** The boundary after the last message, found from the fold's stored cursor (else the start). */
  const tailPosition = async (signal: AbortSignal): Promise<Position> => {
    let c =
      runtime.read(
        (db) =>
          db
            .query<{ cursor: string | null }, [string, string]>(
              "SELECT cursor FROM transcript_sessions WHERE project_directory=? AND session_id=?",
            )
            .get(filter.projectDirectory, sessionID)?.cursor,
      ) ?? null
    for (;;) {
      const page = await list(c, signal)
      if (page.next === null || page.next === c) return { c, i: page.messages.length, k: 0 }
      c = page.next
    }
  }

  /** The boundary just before the event `id`, scanning the list from its start. */
  const keyPosition = async (id: unknown, signal: AbortSignal): Promise<Position> => {
    let c: string | null = null
    for (;;) {
      const page = await list(c, signal)
      for (const [at, message] of page.messages.entries()) {
        const k = messageRows(message, at).findIndex((row) => row[0] === id)
        if (k >= 0) return { c, i: at, k }
      }
      if (page.next === null || page.next === c)
        throw new Error(`The transcript has no row ${String(id)}`)
      c = page.next
    }
  }

  const done = (chunk: Chunk): HostPageResult => ({
    rows: chunk.rows,
    start: encode(chunk.start),
    end: encode(chunk.end),
    before: chunk.before,
    after: chunk.after,
  })

  return {
    async page({ from, direction, limit, signal }: HostPageRequest) {
      if (from === "tail") {
        const end = await tailPosition(signal)
        return done({ ...(await backward(end, limit, signal)), after: false })
      }
      const origin: Position =
        from === "head"
          ? HEAD
          : "position" in from
            ? decode(from.position)
            : await keyPosition(from.key[0], signal)
      if (direction === "before") {
        if (from === "head")
          return done({ rows: [], start: origin, end: origin, before: false, after: true })
        return done(await backward(origin, limit, signal))
      }
      return done(await forward(origin, limit, signal))
    },
    watch(notify) {
      const offs = [
        runtime.events
          ? joinNativeEvents(runtime.events, HINT_EVENT_TYPES, {
              event: (event) => {
                const id = object(object(event)?.data)?.sessionID
                if (id === sessionID) notify()
              },
            })
          : undefined,
        databaseChanges.subscribeTables(runtime.databasePath, (tables) => {
          if (tables.has("transcript_steps")) notify()
        }),
      ]
      return () => {
        for (const off of offs) off?.()
      }
    },
  }
}

export const trajectoryTranscriptSource = defineHostSource({
  name: TRAJECTORY_SOURCES.transcript,
  key: ["id"],
  columns: trajectoryTranscriptColumns,
  async authorize(input: TrajectoryTranscriptFilter, context) {
    const filter = await authorizeTask(input, context)
    const owned = context.read?.((db) =>
      db
        .query(
          "SELECT 1 FROM runner_attempts WHERE project_directory=? AND task_id=? AND session_id=?",
        )
        .get(filter.projectDirectory, filter.taskID, filter.sessionID),
    )
    if (!owned) throw new Error("Trajectory scope is unavailable")
    return filter
  },
  open: (filter: TrajectoryTranscriptFilter, runtime: TrajectoryHostRuntime) =>
    messagePager(filter, runtime),
})

// ---------------------------------------------------------------------------------------------
// trajectory.effort
// ---------------------------------------------------------------------------------------------

const EFFORT_COLUMNS = Object.keys(trajectoryEffortColumns).join(",")
const EFFORT_TABLE = "trajectory_task_effort"

type EffortRow = Record<string, unknown> & { busy: number }

function effortPager(
  filter: TrajectoryEffortFilter,
  runtime: TrajectoryHostRuntime,
  window: number,
): HostPager {
  return {
    async page({ signal }) {
      const stored = runtime.read((db) =>
        db
          .query<EffortRow, [string, string]>(
            `SELECT ${EFFORT_COLUMNS} FROM ${EFFORT_TABLE} WHERE project_directory=? AND task_id=?`,
          )
          .get(filter.projectDirectory, filter.taskID),
      )
      // The fold has not written the row yet: the window is empty, never a placeholder.
      if (!stored) return { rows: [], start: "0", end: "0", before: false, after: false }
      const cells = Object.keys(trajectoryEffortColumns).map((name) =>
        name === "busy" ? stored.busy === 1 : (stored[name] ?? null),
      )
      if (window === 1) {
        const effort = await runtime.effortDetail(filter.taskID, signal)
        cells.push(effort ?? null)
      }
      return { rows: [cells], start: "0", end: "1", before: false, after: false }
    },
    watch(notify) {
      return databaseChanges.subscribeTables(runtime.databasePath, (tables) => {
        if (tables.has(EFFORT_TABLE)) notify()
      })
    },
  }
}

export const trajectoryEffortSource = defineHostSource({
  name: TRAJECTORY_SOURCES.effort,
  key: ["id"],
  columns: trajectoryEffortColumns,
  detail: trajectoryEffortDetail,
  async authorize(input: TrajectoryEffortFilter, context) {
    const filter = await authorizeTask(input, context)
    // A reader opened the task: have the fold recompute it against current prices.
    runtimeOf(context.projectDirectory).touchEffort(filter.taskID)
    return filter
  },
  open: (filter: TrajectoryEffortFilter, runtime: TrajectoryHostRuntime, { window }) =>
    effortPager(filter, runtime, window),
})
