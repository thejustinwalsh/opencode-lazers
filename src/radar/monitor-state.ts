import type {
  LiveHistoryResponse,
  LiveRadarResponse,
  ObservationChange,
  ObservationScope,
} from "../observability/contract.ts"
import type { RadarMonitorTransport } from "./monitor-transport.ts"

export type RadarMonitorData = {
  key: string
  live?: LiveRadarResponse
  loading: boolean
  stale: boolean
  resynchronizing: boolean
  error: string
  connection: "connecting" | "connected" | "reconnecting" | "disconnected"
  selectedSessionID: string | null
  history?: LiveHistoryResponse
  historyLoading: boolean
  historyError: string
}

const blank = (key = ""): RadarMonitorData => ({
  key,
  loading: true,
  stale: true,
  resynchronizing: true,
  error: "",
  connection: "connecting",
  selectedSessionID: null,
  historyLoading: false,
  historyError: "",
})

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Turn native/RPC error envelopes into concise, non-coercive user-facing text. */
export function radarErrorMessage(value: unknown): string {
  const error = object(value)
  const data = object(error?.data)
  const nested = object(error?.error)
  const candidates = [
    error?.message,
    data?.message,
    data?.reason,
    nested?.message,
    typeof value === "string" ? value : undefined,
  ]
  const message = candidates.find((candidate) => typeof candidate === "string" && candidate.trim())
  if (typeof message !== "string") return "The live observation failed without a readable error."
  const recovery = data?.recovery
  let safe = ""
  for (const character of message) {
    const code = character.codePointAt(0)!
    safe += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character
  }
  safe = safe.trim().slice(0, 320)
  return typeof recovery === "string" ? `${safe} Recovery: ${recovery}.` : safe
}

function scopeMatches(live: LiveRadarResponse, scope: ObservationScope) {
  return (
    live.scope.kind === scope.kind &&
    (scope.kind === "project" ||
      (live.scope.kind === "session" && live.scope.sessionID === scope.sessionID))
  )
}

function historyMatches(history: LiveHistoryResponse, projectID: string, scope: ObservationScope) {
  return (
    history.projectID === projectID &&
    history.scope.kind === scope.kind &&
    (scope.kind === "project" ||
      (history.scope.kind === "session" && history.scope.sessionID === scope.sessionID))
  )
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, 1_000)
    signal.addEventListener("abort", done, { once: true })
  })
}

/** Live event synchronization with an independent, cancellable selected-history cursor. */
export class RadarMonitorState {
  data = blank()
  private epoch = 0
  private controller = new AbortController()
  private historyController?: AbortController
  private transport?: RadarMonitorTransport
  private scope?: ObservationScope
  private projectID = ""
  private includeUnmanagedSessions = false
  private latestEventSequence?: number
  private lastEventSequence?: number
  private lastSeenSequence?: number
  private selectionPreference?: {
    projectID: string
    anchorSessionID: string
    sessionID: string
  }
  private validateSelectionOnNextLiveRead = false
  private refreshPending = false
  private refreshRunning = false
  private historyEpoch = 0

  constructor(private readonly changed: (data: RadarMonitorData) => void) {}

  private update(change: Partial<RadarMonitorData>) {
    this.data = { ...this.data, ...change }
    this.changed(this.data)
  }

  private current(epoch: number, transport: RadarMonitorTransport, signal: AbortSignal) {
    return this.epoch === epoch && this.transport === transport && !signal.aborted
  }

  connect(
    key: string,
    projectID: string,
    scope: ObservationScope,
    transport: RadarMonitorTransport,
    includeUnmanagedSessions: boolean,
  ) {
    const preferredSessionID =
      this.selectionPreference?.projectID === projectID &&
      this.selectionPreference.anchorSessionID === scope.sessionID
        ? this.selectionPreference.sessionID
        : null
    this.close()
    this.validateSelectionOnNextLiveRead = Boolean(preferredSessionID)
    this.transport = transport
    this.projectID = projectID
    this.scope = scope
    this.includeUnmanagedSessions = includeUnmanagedSessions
    this.controller = new AbortController()
    const epoch = this.epoch
    const signal = this.controller.signal
    this.data = { ...blank(key), selectedSessionID: preferredSessionID }
    this.update({})
    void this.watch(epoch, transport, signal)
    void this.refresh(epoch, transport, signal)
  }

  private async refresh(epoch: number, transport: RadarMonitorTransport, signal: AbortSignal) {
    if (!this.current(epoch, transport, signal) || !this.scope) return
    if (this.refreshRunning) {
      this.refreshPending = true
      return
    }
    this.refreshRunning = true
    let catchupReads = 0
    do {
      this.refreshPending = false
      if (!transport.online()) {
        if (this.current(epoch, transport, signal))
          this.update({
            loading: !this.data.live,
            stale: true,
            resynchronizing: true,
            connection: "disconnected",
            error: this.data.live
              ? "Server disconnected; showing the last live observation."
              : "Server disconnected; live observation is unavailable.",
          })
        break
      }
      try {
        const scope = this.scope
        const response = await transport.liveRadar(scope, this.includeUnmanagedSessions, signal)
        if (!this.current(epoch, transport, signal)) break
        if (response.projectID !== this.projectID || !scopeMatches(response, scope))
          throw new Error("The live observation belongs to another project or scope.")

        const priorEpoch = this.data.live?.streamEpoch
        const epochChanged = priorEpoch !== undefined && priorEpoch !== response.streamEpoch
        const latestSequence = this.latestEventSequence
        const behindEvents =
          latestSequence !== undefined && response.boundary.eventSequence < latestSequence
        const recovering = epochChanged || (this.data.resynchronizing && behindEvents)
        const shouldRefresh = behindEvents && !this.refreshPending
        const currentConnection = transport.online() ? "connected" : "disconnected"
        const priorSelectedSessionID = this.data.selectedSessionID
        const preferredSessionStillReturned = priorSelectedSessionID
          ? response.sessions.some((session) => session.sessionID === priorSelectedSessionID)
          : false
        const preservePreferredSession =
          priorSelectedSessionID &&
          (preferredSessionStillReturned ||
            !this.validateSelectionOnNextLiveRead ||
            response.sessions.length === 0)
        const selectedSessionID = preservePreferredSession
          ? priorSelectedSessionID
          : response.sessions.some((session) => session.sessionID === scope.sessionID)
            ? scope.sessionID
            : (response.sessions[0]?.sessionID ?? null)
        this.validateSelectionOnNextLiveRead = false
        if (selectedSessionID) {
          this.selectionPreference = {
            projectID: this.projectID,
            anchorSessionID: scope.sessionID,
            sessionID: selectedSessionID,
          }
        }
        const selectedHistory = this.data.history
        const assignment = selectedSessionID
          ? response.sessions.find((session) => session.sessionID === selectedSessionID)?.assignment
          : undefined
        const changedSelection = selectedSessionID !== priorSelectedSessionID
        const changedAssignment = Boolean(
          selectedSessionID &&
          selectedHistory &&
          assignment &&
          selectedHistory.attemptID !== assignment.attemptID,
        )
        if (changedAssignment || changedSelection) {
          this.historyEpoch++
          this.historyController?.abort()
          this.historyController = undefined
        }
        const stale =
          currentConnection !== "connected" ||
          response.freshness.runner !== "current" ||
          response.freshness.nativeEvents !== "connected" ||
          recovering
        this.lastEventSequence = response.boundary.eventSequence
        this.lastSeenSequence = Math.max(
          this.lastSeenSequence ?? response.boundary.eventSequence,
          response.boundary.eventSequence,
        )
        this.latestEventSequence = Math.max(
          this.latestEventSequence ?? response.boundary.eventSequence,
          response.boundary.eventSequence,
        )
        this.update({
          live: response,
          loading: false,
          stale,
          resynchronizing: recovering,
          connection: currentConnection,
          error:
            response.freshness.runner === "unavailable"
              ? "Runner observation is unavailable; session activity is incomplete."
              : response.freshness.nativeEvents !== "connected"
                ? "Native event coverage is unavailable; activity may be incomplete."
                : recovering && behindEvents
                  ? "A live event arrived during refresh; synchronizing again."
                  : epochChanged
                    ? "The event stream reset; synchronizing a new baseline."
                    : "",
          ...(changedAssignment || changedSelection
            ? { history: undefined, historyLoading: true, historyError: "" }
            : {}),
        })
        if ((changedAssignment || changedSelection) && selectedSessionID)
          void this.loadHistory(selectedSessionID, undefined)
        else if (selectedSessionID && selectedHistory)
          void this.loadHistory(selectedSessionID, undefined, true)
        if (shouldRefresh && catchupReads < 2) {
          catchupReads++
          this.refreshPending = true
        }
      } catch (error) {
        if (!this.current(epoch, transport, signal)) break
        this.update({
          loading: false,
          stale: true,
          resynchronizing: true,
          connection: transport.online() ? "connected" : "disconnected",
          error: this.data.live
            ? `Live refresh failed; showing the last observation. ${radarErrorMessage(error)}`
            : `Live observation is unavailable. ${radarErrorMessage(error)}`,
        })
      }
    } while (this.refreshPending && this.current(epoch, transport, signal))
    if (this.epoch === epoch) this.refreshRunning = false
  }

  private async watch(epoch: number, transport: RadarMonitorTransport, signal: AbortSignal) {
    while (this.current(epoch, transport, signal)) {
      try {
        for await (const change of transport.changes(signal)) {
          if (!this.current(epoch, transport, signal)) return
          this.receiveChange(change)
          if (change.sequence > (this.lastEventSequence ?? -1))
            void this.refresh(epoch, transport, signal)
        }
        if (signal.aborted) return
        throw new Error("The live update stream closed.")
      } catch (error) {
        if (!this.current(epoch, transport, signal)) return
        this.update({
          loading: !this.data.live,
          stale: true,
          resynchronizing: true,
          connection: transport.online() ? "reconnecting" : "disconnected",
          error: transport.online()
            ? `Live updates disconnected; reconnecting. ${radarErrorMessage(error)}`
            : "Server disconnected; showing the last live observation.",
        })
        await delay(signal)
        if (!this.current(epoch, transport, signal)) return
        void this.refresh(epoch, transport, signal)
      }
    }
  }

  private receiveChange(change: ObservationChange) {
    this.latestEventSequence = Math.max(this.latestEventSequence ?? 0, change.sequence)
    const previous = this.lastSeenSequence ?? this.lastEventSequence
    const gap =
      change.resnapshotRequired ||
      (previous !== undefined && change.sequence > previous && change.sequence !== previous + 1)
    if (change.sequence <= (previous ?? -1)) return
    this.lastSeenSequence = change.sequence
    this.update({
      stale: this.data.stale || gap,
      resynchronizing: this.data.resynchronizing || gap,
      connection: "connected",
      error: gap ? "Live event gap detected; synchronizing a fresh observation." : this.data.error,
    })
  }

  selectSession(sessionID: string | null) {
    if (this.data.selectedSessionID === sessionID) return
    this.selectionPreference =
      sessionID && this.scope
        ? { projectID: this.projectID, anchorSessionID: this.scope.sessionID, sessionID }
        : undefined
    this.historyEpoch++
    this.historyController?.abort()
    this.historyController = undefined
    this.update({
      selectedSessionID: sessionID,
      history: undefined,
      historyLoading: Boolean(sessionID),
      historyError: "",
    })
    if (sessionID) void this.loadHistory(sessionID, undefined)
  }

  private async loadHistory(sessionID: string, cursor?: string, preservePages = false) {
    const transport = this.transport
    const scope = this.scope
    const parentSignal = this.controller.signal
    if (!transport || !scope || parentSignal.aborted) return
    this.historyController?.abort()
    const controller = new AbortController()
    this.historyController = controller
    const epoch = this.epoch
    const historyEpoch = ++this.historyEpoch
    const abort = () => controller.abort()
    parentSignal.addEventListener("abort", abort, { once: true })
    this.update({ historyLoading: true, historyError: "" })
    try {
      const response = await transport.liveHistory(scope, sessionID, cursor, controller.signal)
      if (
        this.epoch !== epoch ||
        this.historyEpoch !== historyEpoch ||
        this.data.selectedSessionID !== sessionID ||
        controller.signal.aborted
      )
        return
      if (!historyMatches(response, this.projectID, scope) || response.sessionID !== sessionID)
        throw new Error("Selected history belongs to another project, scope, or session.")
      const previous = cursor || preservePages ? this.data.history : undefined
      const items = previous
        ? [
            ...previous.items,
            ...response.items.filter(
              (item) => !previous.items.some((existing) => existing.sequence === item.sequence),
            ),
          ].toSorted((left, right) => right.sequence - left.sequence)
        : response.items
      this.update({
        history: { ...response, items },
        historyLoading: false,
        historyError: "",
      })
    } catch (error) {
      if (this.epoch === epoch && this.historyEpoch === historyEpoch && !controller.signal.aborted)
        this.update({ historyLoading: false, historyError: radarErrorMessage(error) })
    } finally {
      parentSignal.removeEventListener("abort", abort)
    }
  }

  loadMoreHistory() {
    const sessionID = this.data.selectedSessionID
    const cursor = this.data.history?.nextCursor
    if (sessionID && cursor && !this.data.historyLoading) void this.loadHistory(sessionID, cursor)
  }

  refreshNow() {
    if (this.transport && !this.controller.signal.aborted)
      void this.refresh(this.epoch, this.transport, this.controller.signal)
  }

  close() {
    this.epoch++
    this.historyEpoch++
    this.controller.abort()
    this.historyController?.abort()
    this.historyController = undefined
    this.transport = undefined
    this.scope = undefined
    this.projectID = ""
    this.latestEventSequence = undefined
    this.lastEventSequence = undefined
    this.lastSeenSequence = undefined
    this.refreshPending = false
    this.refreshRunning = false
    this.validateSelectionOnNextLiveRead = false
    this.data = blank()
    this.changed(this.data)
  }
}
