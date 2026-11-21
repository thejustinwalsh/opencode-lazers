import { createMemo, createRoot, mapArray, type Accessor } from "solid-js"
import type { Columns } from "../streams/frame.ts"
import { createStream, type GuiStream, type StreamsTransport } from "../streams/gui.ts"
import { liveHistoryRef } from "../streams/sources/live-history-ref.ts"
import { radarFlowRefs } from "../streams/sources/radar-flow-ref.ts"
import { radarRefs, type RadarScope } from "../streams/sources/radar-ref.ts"
import { assembleLive, type RadarLive, type StreamRow } from "./live-view.ts"

/**
 * The Monitor's reads, all streams over stored rows: no live read, no response cap, no event
 * replay. A stream refreshes when its rows change; nothing here polls.
 *
 * ```
 * radar.sessions (40) ─┬─ per session: radar.nativeCalls (18)
 * radar.assignments (40)┼─ per session: radar.steps (18)
 *                       └─ per worker:  liveHistory toolsOnly (18)
 * radar.transcripts (every session listed) ─► which sessions' phases are still being read
 * radar.scheduler (1), radar.workload (1)
 *                         └─────────────► assembleLive ─► RadarLive
 * ```
 *
 * Window basis: the old read drew at most 32 sessions; 40 is those plus 8 of slop. A worker whose
 * session is outside that window (older than 40 newer sessions) is read by its own session
 * stream, so no running worker is dropped. Calls and steps: the old read kept 17 progress rows per
 * session; a lane of 9 shown plus 9 of slop is 18. Monitor shows current calls and the latest
 * finished one; Flow counts the last two minutes.
 */
const SESSIONS_WINDOW = 40
const CALLS_WINDOW = 18
const STEPS_WINDOW = 18

export type RadarMonitorData = {
  key: string
  live?: RadarLive
  loading: boolean
  stale: boolean
  error: string
  /** Raw text of the last failed read; cleared by the next good frame. */
  readError?: string
  /** Epoch ms the rows were last assembled. */
  asOf?: number
  connection: "connecting" | "connected" | "reconnecting" | "disconnected"
  selectedSessionID: string | null
}

export type MonitorSource = {
  key: string
  transport: StreamsTransport
  projectDirectory: string
  scope: RadarScope & { kind: "session" | "project" }
  includeUnmanagedSessions: boolean
  online: () => boolean
}

const asRow = (row: unknown) => row as StreamRow
const rowsOf = <C extends Columns>(stream: GuiStream<C> | undefined) =>
  (stream?.items() ?? []).map(asRow) as readonly StreamRow[]

type SessionStreams = {
  sessionID: string
  calls?: GuiStream<typeof liveHistoryRef.columns>
  native: GuiStream<typeof radarRefs.nativeCalls.columns>
  steps: GuiStream<typeof radarFlowRefs.steps.columns>
  /** A worker outside the sessions window: its own session row. */
  own?: GuiStream<typeof radarRefs.sessions.columns>
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

/** The Monitor's streams for one source; the caller disposes them with its owner. */
function createMonitorStreams(source: MonitorSource): Accessor<RadarMonitorData> {
  const base = { projectDirectory: source.projectDirectory, scope: source.scope }
  const sessions = createStream(source.transport, radarRefs.sessions, () => ({
    filter: base,
    order: "recent",
    window: SESSIONS_WINDOW,
  }))
  const assignments = createStream(source.transport, radarRefs.assignments, () => ({
    filter: base,
    order: "recent",
    window: SESSIONS_WINDOW,
  }))
  const scheduler = createStream(source.transport, radarRefs.scheduler, () => ({
    filter: base,
    order: "key",
    window: 1,
  }))
  const workload = createStream(source.transport, radarRefs.workload, () => ({
    filter: base,
    order: "key",
    window: 1,
  }))

  const attempts = createMemo(
    () =>
      new Map(
        assignments.items().map((row) => {
          const value = asRow(row)
          return [String(value.session_id), String(value.id)] as const
        }),
      ),
  )
  const windowed = createMemo(
    () => new Set(sessions.items().map((row) => String(asRow(row).session_id))),
  )
  /** Every session to read calls for: the window's, then workers outside it. `id:attempt` keys. */
  const keys = createMemo(
    () => {
      const ids = [...windowed()]
      for (const id of attempts().keys()) if (!windowed().has(id)) ids.push(id)
      return ids.map((id) => `${id}\u0000${attempts().get(id) ?? ""}`)
    },
    [],
    { equals: sameList },
  )
  const perSession = createMemo(
    mapArray(keys, (key) => {
      const [sessionID, attemptID] = key.split("\u0000") as [string, string]
      const one = { ...base, sessionID }
      const streams: SessionStreams = {
        sessionID,
        native: createStream(source.transport, radarRefs.nativeCalls, () => ({
          filter: one,
          order: "recent",
          window: CALLS_WINDOW,
        })),
        // Every shown session's model steps are stored (Architect and unmanaged ones too).
        steps: createStream(source.transport, radarFlowRefs.steps, () => ({
          filter: one,
          order: "recent",
          window: STEPS_WINDOW,
        })),
      }
      if (attemptID) {
        streams.calls = createStream(source.transport, liveHistoryRef, () => ({
          filter: { ...one, attemptID, toolsOnly: true },
          order: "recent",
          window: CALLS_WINDOW,
        }))
        if (!windowed().has(sessionID))
          streams.own = createStream(source.transport, radarRefs.sessions, () => ({
            filter: one,
            order: "recent",
            window: SESSIONS_WINDOW,
          }))
      }
      return streams
    }),
  )
  /** Every session the Monitor reads: their stored transcript read state says what is final. */
  const listed = createMemo(
    () =>
      keys()
        .map((key) => key.split("\u0000")[0]!)
        .toSorted(),
    [],
    {
      equals: sameList,
    },
  )
  const transcripts = createStream(source.transport, radarFlowRefs.transcripts, () => ({
    filter: { ...base, sessionIDs: listed() },
    order: "key",
    window: Math.max(1, listed().length),
  }))

  const streams = () => [
    sessions,
    assignments,
    scheduler,
    workload,
    transcripts,
    ...perSession().flatMap((item) => [item.native, item.calls, item.steps, item.own]),
  ]

  return createMemo((): RadarMonitorData => {
    const online = source.online()
    const failure = streams()
      .find((stream) => stream?.error())
      ?.error()
    const loaded = sessions.loaded() && assignments.loaded()
    const connection = online ? "connected" : "disconnected"
    if (!loaded)
      return {
        key: source.key,
        loading: true,
        stale: !online,
        error: failure ? `Live observation is unavailable. ${failure.message}` : "",
        ...(failure ? { readError: failure.message } : {}),
        connection,
        selectedSessionID: null,
      }
    const read = new Map(
      transcripts.items().map((row) => {
        const value = asRow(row)
        return [String(value.session_id), String(value.read_state)] as const
      }),
    )
    // Not read in full yet, or the transcripts stream itself has not answered: still loading.
    const phasesLoading = new Set(
      listed().filter((id) => !transcripts.loaded() || (read.get(id) ?? "not-read") === "not-read"),
    )
    const calls = new Map<string, readonly StreamRow[]>()
    const nativeCalls = new Map<string, readonly StreamRow[]>()
    const steps = new Map<string, readonly StreamRow[]>()
    const extra: StreamRow[] = []
    for (const item of perSession()) {
      nativeCalls.set(item.sessionID, rowsOf(item.native))
      if (item.calls) calls.set(item.sessionID, rowsOf(item.calls))
      steps.set(item.sessionID, rowsOf(item.steps))
      const own = rowsOf(item.own).find((row) => row.session_id === item.sessionID)
      if (own) extra.push(own)
    }
    const now = Date.now()
    return {
      key: source.key,
      live: assembleLive({
        scope: source.scope,
        projectDirectory: source.projectDirectory,
        now,
        includeUnmanagedSessions: source.includeUnmanagedSessions,
        sessions: [...sessions.items().map(asRow), ...extra],
        assignments: assignments.items().map(asRow),
        ...(scheduler.items()[0] ? { scheduler: asRow(scheduler.items()[0]) } : {}),
        ...(workload.items()[0] ? { workload: asRow(workload.items()[0]) } : {}),
        calls,
        nativeCalls,
        steps,
        phasesLoading,
      }),
      asOf: now,
      loading: false,
      stale: !online,
      error: failure ? `Refresh failed; showing the last rows. ${failure.message}` : "",
      ...(failure ? { readError: failure.message } : {}),
      connection,
      selectedSessionID: null,
    }
  })
}

/** Open the Monitor's streams under their own owner; `dispose` closes every one. */
export function openMonitorStreams(source: MonitorSource) {
  return createRoot((dispose) => ({ data: createMonitorStreams(source), dispose }))
}
