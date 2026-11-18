import { panelErrorMessage } from "../panel-error.ts"
import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "../observability/contract.ts"
import { ObservationSyncState } from "../observability/state.ts"
import { createKept } from "./kept.ts"
import type { RadarTransport } from "./transport.ts"

const kept = createKept<{ radar?: RadarResponse; snapshot?: SnapshotResponse }>()

export type RadarPanelData = {
  key: string
  radar?: RadarResponse
  snapshot?: SnapshotResponse
  loading: boolean
  stale: boolean
  /** Gaps/reconnects need a quiet pulse baseline; ordinary refreshes do not. */
  resynchronizing: boolean
  error: string
  snapshotError?: string
}

const blank = (key = ""): RadarPanelData => ({
  key,
  loading: true,
  stale: true,
  resynchronizing: true,
  error: "",
})

function sameBoundary(left: SnapshotResponse["boundary"], right: SnapshotResponse["boundary"]) {
  return (
    left.repositoryVersion === right.repositoryVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.nativeRevision === right.nativeRevision &&
    left.eventSequence === right.eventSequence &&
    left.transitionSequence === right.transitionSequence
  )
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, 1_000)
    signal.addEventListener("abort", done, { once: true })
  })
}

/** Scope-keyed read-only snapshot and event synchronization for the native panel. */
export class RadarPanelState {
  data = blank()
  private readonly sync = new ObservationSyncState()
  private epoch = 0
  private controller = new AbortController()
  private transport?: RadarTransport
  private scope?: ObservationScope
  private includeUnmanagedSessions = false
  private reconnecting = false
  /** Keep gap/reconnect catch-up quiet until Radar has crossed its recovery fence. */
  private recoveryFence?: number
  private recoveryBaselinePending = false
  private readonly snapshotRuns = new Map<number, { pending: boolean; retries: number }>()

  constructor(
    private readonly changed: (data: RadarPanelData) => void,
    private readonly waitForReconnect: (signal: AbortSignal) => Promise<void> = delay,
  ) {}

  private update(change: Partial<RadarPanelData>) {
    this.data = { ...this.data, ...change }
    if (this.data.radar || this.data.snapshot)
      kept.set(this.data.key, {
        ...(this.data.radar ? { radar: this.data.radar } : {}),
        ...(this.data.snapshot ? { snapshot: this.data.snapshot } : {}),
      })
    this.changed(this.data)
  }

  private current(epoch: number, transport: RadarTransport, signal: AbortSignal) {
    return this.epoch === epoch && this.transport === transport && !signal.aborted
  }

  connect(
    key: string,
    projectID: string,
    scope: ObservationScope,
    transport: RadarTransport,
    includeUnmanagedSessions = false,
  ) {
    this.close()
    this.transport = transport
    this.scope = scope
    this.includeUnmanagedSessions = includeUnmanagedSessions
    this.controller = new AbortController()
    const epoch = this.epoch
    const generation = this.sync.connect(projectID, scope)
    const signal = this.controller.signal
    const previous = kept.get(key)
    // Content shown before stays; the refresh below replaces it in place.
    this.data = previous ? { ...blank(key), ...previous, loading: false } : blank(key)
    this.update({})
    void this.watch(epoch, generation, projectID, transport, signal)
    void this.refresh(epoch, generation, transport, signal)
  }

  async refresh(epoch: number, generation: number, transport: RadarTransport, signal: AbortSignal) {
    if (!this.current(epoch, transport, signal) || !this.scope || this.reconnecting) return
    const pending = this.snapshotRuns.get(generation)
    if (pending) {
      pending.pending = true
      return
    }
    const run = { pending: false, retries: 0 }
    this.snapshotRuns.set(generation, run)
    do {
      run.pending = false
      run.retries++
      if (!transport.online()) {
        if (this.current(epoch, transport, signal) && generation === this.sync.generation) {
          this.sync.stale = true
          this.update({
            loading: !this.data.radar,
            stale: true,
            resynchronizing: true,
            error: this.data.radar
              ? "Server disconnected; showing the last observation."
              : "Server disconnected; observations are unavailable.",
          })
        }
        break
      }
      try {
        const scope = this.scope!
        const [radarResult, snapshotResult] = await Promise.allSettled([
          transport.radar(this.scope, this.includeUnmanagedSessions, signal),
          transport.snapshot(this.scope, signal),
        ])
        if (!this.current(epoch, transport, signal) || generation !== this.sync.generation) break

        const radar = radarResult.status === "fulfilled" ? radarResult.value : undefined
        const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : undefined
        const scopeMatches = (value: RadarResponse | SnapshotResponse) =>
          value.projectID === this.sync.projectID &&
          value.scope.kind === scope.kind &&
          (scope.kind === "project" ||
            (value.scope.kind === "session" && value.scope.sessionID === scope.sessionID))
        const radarError =
          radarResult.status === "rejected"
            ? panelErrorMessage(radarResult.reason)
            : radar && !scopeMatches(radar)
              ? radar.projectID !== this.sync.projectID
                ? "The operational observation belongs to another project."
                : "The operational observation belongs to another scope."
              : ""
        const snapshotError =
          snapshotResult.status === "rejected"
            ? panelErrorMessage(snapshotResult.reason)
            : snapshot && !scopeMatches(snapshot)
              ? snapshot.projectID !== this.sync.projectID
                ? "The lifecycle observation belongs to another project."
                : "The lifecycle observation belongs to another scope."
              : ""

        let acceptedRadar = false
        let acceptedSnapshot = false
        if (radar && !radarError) {
          acceptedRadar = this.sync.acceptRadar(generation, radar)
        }
        if (snapshot && !snapshotError) {
          acceptedSnapshot = this.sync.acceptSnapshot(generation, snapshot)
        }

        const displayedRadar = acceptedRadar ? radar : this.data.radar
        const displayedSnapshot = acceptedSnapshot ? snapshot : this.data.snapshot
        const boundariesDiffer = Boolean(
          displayedRadar &&
          displayedSnapshot &&
          !sameBoundary(displayedRadar.boundary, displayedSnapshot.boundary),
        )
        const liveSequence = this.sync.eventSequence
        if (this.recoveryFence !== undefined)
          this.recoveryBaselinePending = Boolean(
            displayedRadar &&
            displayedSnapshot &&
            !boundariesDiffer &&
            displayedRadar.boundary.eventSequence >= this.recoveryFence &&
            displayedRadar.boundary.eventSequence >=
              (liveSequence ?? displayedRadar.boundary.eventSequence),
          )
        const behindLiveChanges = Boolean(
          liveSequence !== undefined &&
          ((displayedRadar && displayedRadar.boundary.eventSequence < liveSequence) ||
            (displayedSnapshot && displayedSnapshot.boundary.eventSequence < liveSequence)),
        )
        const needsResynchronization = boundariesDiffer || behindLiveChanges
        if (needsResynchronization && run.retries < 3) run.pending = true
        if (run.retries >= 3) run.pending = false
        const freshnessError = boundariesDiffer
          ? "Operational and lifecycle observations have different read boundaries; refreshing."
          : behindLiveChanges
            ? "Observation reads lag behind live changes; refreshing."
            : ""

        if (acceptedRadar || acceptedSnapshot) {
          if (!needsResynchronization) run.retries = 0
          this.sync.stale = !acceptedRadar || needsResynchronization
          this.update({
            ...(acceptedRadar ? { radar } : {}),
            ...(acceptedSnapshot ? { snapshot } : {}),
            loading: false,
            stale: !acceptedRadar || needsResynchronization,
            resynchronizing: !acceptedRadar || this.recoveryFence !== undefined,
            error: radarError || freshnessError,
            snapshotError,
          })
        } else {
          this.sync.stale = true
          this.update({
            loading: false,
            stale: true,
            resynchronizing: true,
            error: radarError || freshnessError || "Operational observation is not current.",
            snapshotError,
          })
          if (!run.pending) break
          if (run.retries >= 3) {
            run.pending = false
            break
          }
        }
      } catch (error) {
        if (!this.current(epoch, transport, signal) || generation !== this.sync.generation) break
        this.sync.stale = true
        this.update({
          loading: false,
          stale: true,
          resynchronizing: true,
          error: this.data.snapshot
            ? `Refresh failed; showing the last observation. ${panelErrorMessage(error)}`
            : `Observation is unavailable. ${panelErrorMessage(error)}`,
        })
      }
    } while (
      run.pending &&
      this.current(epoch, transport, signal) &&
      generation === this.sync.generation
    )
    if (this.snapshotRuns.get(generation) === run) this.snapshotRuns.delete(generation)
  }

  private async watch(
    epoch: number,
    firstGeneration: number,
    projectID: string,
    transport: RadarTransport,
    signal: AbortSignal,
  ) {
    let generation = firstGeneration
    while (this.current(epoch, transport, signal)) {
      try {
        for await (const change of transport.changes(signal)) {
          if (!this.current(epoch, transport, signal)) return
          const previous = this.sync.eventSequence
          const contiguous = this.sync.acceptChange(generation, projectID, change)
          if (this.sync.eventSequence === previous) continue
          const releasedBaseline = contiguous && this.recoveryBaselinePending
          if (!contiguous) {
            this.recoveryFence = change.sequence
            this.recoveryBaselinePending = false
          } else if (releasedBaseline) {
            this.recoveryFence = undefined
            this.recoveryBaselinePending = false
          }
          const resynchronizing =
            !contiguous ||
            this.recoveryFence !== undefined ||
            (this.data.resynchronizing && !releasedBaseline)
          this.update({
            stale: true,
            resynchronizing,
            error: contiguous ? "" : "Observation gap; refreshing the snapshot.",
          })
          void this.refresh(epoch, generation, transport, signal)
        }
        if (signal.aborted) return
        throw new Error("Observation update stream closed")
      } catch (error) {
        if (!this.current(epoch, transport, signal)) return
        this.reconnecting = true
        this.recoveryFence = 0
        this.recoveryBaselinePending = false
        generation = this.sync.reconnect()
        this.update({
          loading: !this.data.radar,
          stale: true,
          resynchronizing: true,
          error: transport.online()
            ? `Update stream disconnected; resynchronizing. ${panelErrorMessage(error)}`
            : "Server disconnected; showing the last observation.",
        })
        await this.waitForReconnect(signal)
        if (signal.aborted || !this.current(epoch, transport, signal)) return
        this.reconnecting = false
        this.update({ stale: true, resynchronizing: true })
        void this.refresh(epoch, generation, transport, signal)
      }
    }
  }

  close() {
    this.epoch++
    this.reconnecting = false
    this.recoveryFence = undefined
    this.recoveryBaselinePending = false
    this.controller.abort()
    this.transport = undefined
    this.scope = undefined
    this.data = blank()
    this.changed(this.data)
  }

  refreshNow() {
    const transport = this.transport
    if (transport && !this.controller.signal.aborted)
      void this.refresh(this.epoch, this.sync.generation, transport, this.controller.signal)
  }
}

export type RadarChange = ObservationChange
