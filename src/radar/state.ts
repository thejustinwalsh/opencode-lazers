import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "../observability/contract.ts"
import { ObservationSyncState } from "../observability/state.ts"
import type { RadarTransport } from "./transport.ts"

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
  private poll?: ReturnType<typeof setInterval>
  private readonly snapshotRuns = new Map<number, { pending: boolean; retries: number }>()

  constructor(
    private readonly changed: (data: RadarPanelData) => void,
    private readonly waitForReconnect: (signal: AbortSignal) => Promise<void> = delay,
  ) {}

  private update(change: Partial<RadarPanelData>) {
    this.data = { ...this.data, ...change }
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
    this.data = blank(key)
    this.update({})
    void this.watch(epoch, generation, projectID, transport, signal)
    void this.refresh(epoch, generation, transport, signal)
    this.poll = setInterval(() => {
      if (!signal.aborted) void this.refresh(epoch, this.sync.generation, transport, signal)
    }, 3_000)
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
            ? String(radarResult.reason)
            : radar && !scopeMatches(radar)
              ? radar.projectID !== this.sync.projectID
                ? "The operational observation belongs to another project."
                : "The operational observation belongs to another scope."
              : ""
        const snapshotError =
          snapshotResult.status === "rejected"
            ? String(snapshotResult.reason)
            : snapshot && !scopeMatches(snapshot)
              ? snapshot.projectID !== this.sync.projectID
                ? "The lifecycle observation belongs to another project."
                : "The lifecycle observation belongs to another scope."
              : ""

        if (radar && snapshot && !radarError && !snapshotError) {
          if (JSON.stringify(radar.boundary) !== JSON.stringify(snapshot.boundary)) {
            this.sync.stale = true
            if (run.retries < 3) run.pending = true
            this.update({
              loading: false,
              stale: true,
              resynchronizing: true,
              error:
                "Operational and lifecycle observations changed while reading; resynchronizing.",
              snapshotError: "",
            })
            if (run.pending) continue
            break
          }
        }

        let acceptedRadar = false
        let acceptedSnapshot = false
        if (radar && !radarError) {
          acceptedRadar = this.sync.acceptRadar(generation, radar)
          if (!acceptedRadar && radar.boundary.eventSequence < (this.sync.eventSequence ?? 0))
            run.pending = true
        }
        if (snapshot && !snapshotError) {
          acceptedSnapshot = this.sync.acceptSnapshot(generation, snapshot)
          if (!acceptedSnapshot && snapshot.boundary.eventSequence < (this.sync.eventSequence ?? 0))
            run.pending = true
        }
        if (acceptedRadar || acceptedSnapshot) {
          run.retries = 0
          this.update({
            ...(acceptedRadar ? { radar } : {}),
            ...(acceptedSnapshot ? { snapshot } : {}),
            loading: false,
            stale: !acceptedRadar,
            resynchronizing: !acceptedRadar,
            error: radarError,
            snapshotError,
          })
        } else {
          this.sync.stale = true
          this.update({
            loading: false,
            stale: true,
            resynchronizing: true,
            error: radarError || "Operational observation is not current.",
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
            ? `Refresh failed; showing the last observation. ${String(error)}`
            : `Observation is unavailable. ${String(error)}`,
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
          this.update({
            stale: true,
            resynchronizing: this.data.resynchronizing || !contiguous,
            error: contiguous ? "" : "Observation gap; refreshing the snapshot.",
          })
          void this.refresh(epoch, generation, transport, signal)
        }
        if (signal.aborted) return
        throw new Error("Observation update stream closed")
      } catch (error) {
        if (!this.current(epoch, transport, signal)) return
        this.reconnecting = true
        generation = this.sync.reconnect()
        this.update({
          loading: !this.data.radar,
          stale: true,
          resynchronizing: true,
          error: transport.online()
            ? `Update stream disconnected; resynchronizing. ${String(error)}`
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
    this.controller.abort()
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
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
