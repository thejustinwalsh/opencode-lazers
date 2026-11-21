import { panelErrorMessage } from "../panel-error.ts"
import type {
  LiveRadarResponse,
  ObservationChange,
  ObservationScope,
} from "../observability/contract.ts"
import { createKept } from "./kept.ts"
import type { RadarLive } from "./live-view.ts"
import type { RadarMonitorTransport } from "./monitor-transport.ts"

const kept = createKept<{ live: LiveRadarResponse; asOf: number | undefined }>()

export type RadarMonitorData = {
  key: string
  live?: RadarLive
  loading: boolean
  stale: boolean
  resynchronizing: boolean
  error: string
  /** Raw text of the last failed read or dropped link; cleared by the next good read. */
  readError?: string
  /** Epoch ms the kept `live` snapshot was last confirmed current. */
  asOf?: number
  connection: "connecting" | "connected" | "reconnecting" | "disconnected"
  selectedSessionID: string | null
}

const blank = (key = ""): RadarMonitorData => ({
  key,
  loading: true,
  stale: true,
  resynchronizing: true,
  error: "",
  connection: "connecting",
  selectedSessionID: null,
})

function scopeMatches(live: LiveRadarResponse, scope: ObservationScope) {
  return (
    live.scope.kind === scope.kind &&
    (scope.kind === "project" ||
      (live.scope.kind === "session" && live.scope.sessionID === scope.sessionID))
  )
}

/** Least time between the starts of two live reads. */
const MIN_READ_GAP_MS = 400

function pause(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener("abort", done, { once: true })
  })
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

/**
 * Live event synchronization: the live read follows the event stream. The selected worker's
 * history, attempt and the Map groups are not read here; the view opens them as streams
 * (`radar-streams.ts`).
 *
 * SEAM (Task 3): this class and its `liveRadar` read are what remains of the old monitor. They
 * carry the sessions (and the calls and flow derived from them), which move to
 * `radarRefs.sessions` (`radar.sessions` over `host_session_state`, Task 3, now built); then this
 * class, `kept.ts`, `monitor-transport.ts`, the `liveRadar` RPC and its 512 KB response cap are
 * deleted together.
 */
export class RadarMonitorState {
  data = blank()
  private epoch = 0
  private controller = new AbortController()
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
  private lastReadAt?: number

  constructor(private readonly changed: (data: RadarMonitorData) => void) {}

  private update(change: Partial<RadarMonitorData>) {
    this.data = { ...this.data, ...change }
    if (this.data.live)
      kept.set(this.data.key, { live: this.data.live as LiveRadarResponse, asOf: this.data.asOf })
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
    storedSessionID: string | null = null,
  ) {
    const preferredSessionID =
      this.selectionPreference?.projectID === projectID &&
      this.selectionPreference.anchorSessionID === scope.sessionID
        ? this.selectionPreference.sessionID
        : storedSessionID
    this.close()
    this.lastReadAt = undefined
    this.validateSelectionOnNextLiveRead = Boolean(preferredSessionID)
    this.transport = transport
    this.projectID = projectID
    this.scope = scope
    this.includeUnmanagedSessions = includeUnmanagedSessions
    this.controller = new AbortController()
    const epoch = this.epoch
    const signal = this.controller.signal
    const previous = kept.get(key)
    this.data = {
      ...blank(key),
      selectedSessionID: preferredSessionID,
      // Content shown before stays; the refresh below replaces it in place.
      ...(previous
        ? {
            live: previous.live,
            ...(previous.asOf !== undefined ? { asOf: previous.asOf } : {}),
            loading: false,
            connection: "connected" as const,
          }
        : {}),
    }
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
      // Reads start at most once per MIN_READ_GAP_MS. Events that arrive meanwhile coalesce into
      // the one read that follows, so a busy worker's event stream is a few reads a second, not
      // one per event. The first read after a quiet spell is immediate.
      const wait = (this.lastReadAt ?? -Infinity) + MIN_READ_GAP_MS - Date.now()
      if (wait > 0) {
        await pause(signal, wait)
        if (!this.current(epoch, transport, signal)) break
      }
      this.lastReadAt = Date.now()
      this.refreshPending = false
      if (!transport.online()) {
        if (this.current(epoch, transport, signal))
          this.update({
            loading: !this.data.live,
            stale: true,
            resynchronizing: true,
            connection: "disconnected",
            readError: "Server disconnected",
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

        const priorEpoch = (this.data.live as LiveRadarResponse | undefined)?.streamEpoch
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
          asOf: Date.now(),
          readError: "",
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
        })
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
          readError: panelErrorMessage(error),
          error: this.data.live
            ? `Live refresh failed; showing the last observation. ${panelErrorMessage(error)}`
            : `Live observation is unavailable. ${panelErrorMessage(error)}`,
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
          readError: transport.online() ? panelErrorMessage(error) : "Server disconnected",
          error: transport.online()
            ? `Live updates disconnected; reconnecting. ${panelErrorMessage(error)}`
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
    this.update({ selectedSessionID: sessionID })
  }

  refreshNow() {
    if (this.transport && !this.controller.signal.aborted)
      void this.refresh(this.epoch, this.transport, this.controller.signal)
  }

  close() {
    this.epoch++
    this.controller.abort()
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
