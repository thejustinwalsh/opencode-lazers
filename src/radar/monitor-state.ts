import { panelErrorMessage } from "../panel-error.ts"
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
  /** Raw text of the last failed read or dropped link; cleared by the next good read. */
  readError?: string
  /** Epoch ms the kept `live` snapshot was last confirmed current. */
  asOf?: number
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

type HistoryCoverage = LiveHistoryResponse["coverage"]
type HistoryItem = LiveHistoryResponse["items"][number]

const JOURNAL_RANK: Record<HistoryCoverage["journal"], number> = {
  available: 0,
  "legacy-or-unavailable": 1,
  unavailable: 2,
}
/** Bounded re-seeks when the producer rejects a cursor because the journal moved. */
const HISTORY_RESTARTS = 2

function lowestSequence(items: readonly HistoryItem[]) {
  return items.reduce((lowest, item) => Math.min(lowest, item.sequence), Infinity)
}

function highestSequence(items: readonly HistoryItem[]) {
  return items.reduce((highest, item) => Math.max(highest, item.sequence), -Infinity)
}

/**
 * When a row was read: the producer's observation revision, then the client's issue order
 * for reads at the same or an unknown revision. Arrival order is not freshness.
 */
type HistoryFreshness = { revision: number | null; ticket: number }

function fresher(left: HistoryFreshness, right: HistoryFreshness) {
  return left.revision !== null && right.revision !== null && left.revision !== right.revision
    ? left.revision > right.revision
    : left.ticket > right.ticket
}

/** Coverage describes every loaded page: more pages follow the tail cursor, cuts stay visible. */
function mergeHistoryCoverage(
  previous: HistoryCoverage,
  incoming: HistoryCoverage,
  nextCursor: string | null,
): HistoryCoverage {
  return {
    ...incoming,
    hasMore: nextCursor !== null,
    payloadTruncated: previous.payloadTruncated || incoming.payloadTruncated,
    journal:
      JOURNAL_RANK[previous.journal] > JOURNAL_RANK[incoming.journal]
        ? previous.journal
        : incoming.journal,
  }
}

/** A fresh first page continues loaded history only when it reaches the newest loaded item. */
function headJoins(previous: LiveHistoryResponse, head: LiveHistoryResponse) {
  return (
    previous.attemptID === head.attemptID &&
    head.nextCursor !== null &&
    head.items.length > 0 &&
    previous.items.length > 0 &&
    lowestSequence(head.items) <= highestSequence(previous.items)
  )
}

function historyRestartRequired(error: unknown) {
  if (typeof error !== "object" || error === null || !("data" in error)) return false
  const data = error.data
  return (
    typeof data === "object" &&
    data !== null &&
    "reason" in data &&
    data.reason === "changed-during-read"
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

/**
 * Live event synchronization with selected history split into two owners: the head re-reads
 * the newest page on live updates and merges by sequence; the tail owns the older-page cursor.
 * A head refresh never cancels or rewinds the tail.
 */
export class RadarMonitorState {
  data = blank()
  private epoch = 0
  private controller = new AbortController()
  private headRead?: AbortController
  private headPending = false
  private headError = ""
  private tailRead?: AbortController
  private tailError = ""
  /** Cursor chain within one selection baseline; a non-contiguous head starts a new chain. */
  private historyChain = 0
  /** Freshness of each loaded row, keyed by journal sequence, for the current selection. */
  private itemFreshness = new Map<number, HistoryFreshness>()
  private readTicket = 0
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
    storedSessionID: string | null = null,
  ) {
    const preferredSessionID =
      this.selectionPreference?.projectID === projectID &&
      this.selectionPreference.anchorSessionID === scope.sessionID
        ? this.selectionPreference.sessionID
        : storedSessionID
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
        if (changedAssignment || changedSelection) this.resetHistory()
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
          ...(changedAssignment || changedSelection
            ? { history: undefined, historyLoading: Boolean(selectedSessionID), historyError: "" }
            : {}),
        })
        if (selectedSessionID && (changedAssignment || changedSelection || selectedHistory))
          this.requestHistoryHead(selectedSessionID)
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
    this.resetHistory()
    this.update({
      selectedSessionID: sessionID,
      history: undefined,
      historyLoading: Boolean(sessionID),
      historyError: "",
    })
    if (sessionID) this.requestHistoryHead(sessionID)
  }

  /** Invalidates both history owners for a new selection, assignment, scope or disposal. */
  private resetHistory() {
    this.historyEpoch++
    this.headRead?.abort()
    this.headRead = undefined
    this.headPending = false
    this.headError = ""
    this.tailRead?.abort()
    this.tailRead = undefined
    this.tailError = ""
    this.itemFreshness = new Map()
  }

  /**
   * Merges one read into the loaded rows by journal sequence. A newer read updates a row in
   * place; a row from an older read never replaces one from a newer read, whatever the arrival
   * order. `replace` keeps only the incoming rows, still preferring newer loaded copies.
   */
  private mergeRead(
    existing: readonly HistoryItem[],
    incoming: readonly HistoryItem[],
    freshness: HistoryFreshness,
    replace = false,
  ) {
    const loaded = new Map(existing.map((item) => [item.sequence, item]))
    const rows = replace ? new Map<number, HistoryItem>() : new Map(loaded)
    const known = replace ? new Map<number, HistoryFreshness>() : new Map(this.itemFreshness)
    for (const item of incoming) {
      const kept = loaded.get(item.sequence)
      const recorded = this.itemFreshness.get(item.sequence)
      if (kept && recorded && fresher(recorded, freshness)) {
        rows.set(item.sequence, kept)
        known.set(item.sequence, recorded)
      } else {
        rows.set(item.sequence, item)
        known.set(item.sequence, freshness)
      }
    }
    this.itemFreshness = known
    return [...rows.values()].toSorted((left, right) => right.sequence - left.sequence)
  }

  private publishHistory(change: Partial<RadarMonitorData> = {}) {
    const history = "history" in change ? change.history : this.data.history
    this.update({
      ...change,
      // Background head refreshes are silent once history is shown; only first and older pages load.
      historyLoading: (!history && Boolean(this.headRead)) || Boolean(this.tailRead),
      historyError: this.tailError || this.headError,
    })
  }

  /** Coalesces live head refreshes so a slow read is followed by one more, never starved. */
  private requestHistoryHead(sessionID: string) {
    if (this.headRead) this.headPending = true
    else void this.loadHistoryHead(sessionID)
  }

  private async loadHistoryHead(sessionID: string) {
    const transport = this.transport
    const scope = this.scope
    const parentSignal = this.controller.signal
    if (!transport || !scope || parentSignal.aborted) return
    const controller = new AbortController()
    this.headRead = controller
    this.headPending = false
    const epoch = this.epoch
    const baseline = this.historyEpoch
    const abort = () => controller.abort()
    parentSignal.addEventListener("abort", abort, { once: true })
    const current = () =>
      this.epoch === epoch &&
      this.historyEpoch === baseline &&
      this.headRead === controller &&
      this.data.selectedSessionID === sessionID &&
      !controller.signal.aborted
    if (!this.data.history) {
      this.headError = ""
      this.publishHistory()
    }
    try {
      const ticket = ++this.readTicket
      const response = await transport.liveHistory(scope, sessionID, undefined, controller.signal)
      if (!current()) return
      if (!historyMatches(response, this.projectID, scope) || response.sessionID !== sessionID)
        throw new Error("Selected history belongs to another project, scope, or session.")
      const previous = this.data.history
      const freshness = { revision: response.runnerRevision, ticket }
      this.headRead = undefined
      this.headError = ""
      if (previous && headJoins(previous, response)) {
        this.publishHistory({
          history: {
            ...response,
            items: this.mergeRead(previous.items, response.items, freshness),
            nextCursor: previous.nextCursor,
            coverage: mergeHistoryCoverage(
              previous.coverage,
              response.coverage,
              previous.nextCursor,
            ),
          },
        })
      } else {
        // Complete, first or non-contiguous: the fresh page is the honest new baseline.
        this.historyChain++
        this.tailRead?.abort()
        this.tailRead = undefined
        this.tailError = ""
        this.publishHistory({
          history: {
            ...response,
            items: this.mergeRead(previous?.items ?? [], response.items, freshness, true),
          },
        })
      }
    } catch (error) {
      if (!current()) return
      this.headRead = undefined
      this.headError = panelErrorMessage(error)
      this.publishHistory()
    } finally {
      parentSignal.removeEventListener("abort", abort)
      if (this.headRead === controller) this.headRead = undefined
      if (
        this.headPending &&
        !this.headRead &&
        this.epoch === epoch &&
        this.historyEpoch === baseline &&
        this.data.selectedSessionID === sessionID
      )
        void this.loadHistoryHead(sessionID)
    }
  }

  loadMoreHistory() {
    const sessionID = this.data.selectedSessionID
    const history = this.data.history
    if (sessionID && history?.nextCursor && !this.tailRead)
      void this.loadHistoryTail(sessionID, history, history.nextCursor)
  }

  /**
   * Reads the next older page. A cursor rejected because the journal moved restarts from a
   * fresh first page and follows it past the oldest loaded item, keeping loaded rows visible.
   */
  private async loadHistoryTail(sessionID: string, from: LiveHistoryResponse, cursor: string) {
    const transport = this.transport
    const scope = this.scope
    const parentSignal = this.controller.signal
    if (!transport || !scope || parentSignal.aborted) return
    const controller = new AbortController()
    this.tailRead = controller
    const epoch = this.epoch
    const baseline = this.historyEpoch
    const chain = this.historyChain
    const abort = () => controller.abort()
    parentSignal.addEventListener("abort", abort, { once: true })
    const current = () =>
      this.epoch === epoch &&
      this.historyEpoch === baseline &&
      this.historyChain === chain &&
      this.tailRead === controller &&
      this.data.selectedSessionID === sessionID &&
      !controller.signal.aborted
    const floor = lowestSequence(from.items)
    this.tailError = ""
    this.publishHistory()
    try {
      const pages: { page: LiveHistoryResponse; freshness: HistoryFreshness }[] = []
      let next: string | undefined = cursor
      let restarts = 0
      for (;;) {
        let page: LiveHistoryResponse
        const ticket = ++this.readTicket
        try {
          page = await transport.liveHistory(scope, sessionID, next, controller.signal)
        } catch (error) {
          if (!current() || !historyRestartRequired(error) || restarts >= HISTORY_RESTARTS)
            throw error
          restarts++
          pages.length = 0
          next = undefined
          continue
        }
        if (!current()) return
        if (!historyMatches(page, this.projectID, scope) || page.sessionID !== sessionID)
          throw new Error("Selected history belongs to another project, scope, or session.")
        if (page.attemptID !== from.attemptID)
          throw new Error("Selected history moved to another attempt; refresh to restart.")
        const lowest = lowestSequence(page.items)
        const previous = pages.at(-1)?.page
        if (page.nextCursor !== null && previous && lowest >= lowestSequence(previous.items))
          throw new Error("The next history page did not advance.")
        if (page.nextCursor !== null && page.items.length === 0)
          throw new Error("The next history page did not advance.")
        pages.push({ page, freshness: { revision: page.runnerRevision, ticket } })
        if (page.nextCursor === null || lowest < floor) break
        next = page.nextCursor
      }
      const loaded = this.data.history
      if (!loaded || loaded.nextCursor !== cursor) return
      const nextCursor = pages.at(-1)!.page.nextCursor
      let items = loaded.items
      let coverage = loaded.coverage
      for (const { page, freshness } of pages) {
        items = this.mergeRead(items, page.items, freshness)
        coverage = mergeHistoryCoverage(coverage, page.coverage, nextCursor)
      }
      this.tailRead = undefined
      this.publishHistory({ history: { ...loaded, items, nextCursor, coverage } })
    } catch (error) {
      if (!current()) return
      this.tailRead = undefined
      this.tailError = panelErrorMessage(error)
      this.publishHistory()
    } finally {
      parentSignal.removeEventListener("abort", abort)
      if (this.tailRead === controller) {
        this.tailRead = undefined
        if (this.epoch === epoch && this.historyEpoch === baseline) this.publishHistory()
      }
    }
  }

  refreshNow() {
    if (this.transport && !this.controller.signal.aborted)
      void this.refresh(this.epoch, this.transport, this.controller.signal)
  }

  close() {
    this.epoch++
    this.controller.abort()
    this.resetHistory()
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
