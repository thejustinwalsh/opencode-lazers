import type {
  ObservationChange,
  ObservationScope,
  SnapshotResponse,
} from "../observability/contract.ts"
import { ObservationSyncState } from "../observability/state.ts"
import type { RadarTransport } from "./transport.ts"

export type RadarPanelData = {
  key: string
  snapshot?: SnapshotResponse
  loading: boolean
  stale: boolean
  error: string
}

const blank = (key = ""): RadarPanelData => ({
  key,
  loading: true,
  stale: true,
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
  private poll?: ReturnType<typeof setInterval>
  private readonly snapshotRuns = new Map<number, { pending: boolean }>()

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

  connect(key: string, projectID: string, scope: ObservationScope, transport: RadarTransport) {
    this.close()
    this.transport = transport
    this.scope = scope
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
    if (!this.current(epoch, transport, signal) || !this.scope) return
    const pending = this.snapshotRuns.get(generation)
    if (pending) {
      pending.pending = true
      return
    }
    const run = { pending: false }
    this.snapshotRuns.set(generation, run)
    do {
      run.pending = false
      if (!transport.online()) {
        if (this.current(epoch, transport, signal) && generation === this.sync.generation) {
          this.sync.stale = true
          this.update({
            loading: !this.data.snapshot,
            stale: true,
            error: this.data.snapshot
              ? "Server disconnected; showing the last observation."
              : "Server disconnected; observations are unavailable.",
          })
        }
        break
      }
      try {
        const snapshot = await transport.snapshot(this.scope, signal)
        if (!this.current(epoch, transport, signal) || generation !== this.sync.generation) break
        if (snapshot.projectID !== this.sync.projectID) {
          this.sync.stale = true
          this.update({
            loading: false,
            stale: true,
            error: "The observation belongs to another project.",
          })
          break
        }
        const responseScopeMatches =
          snapshot.scope.kind === this.scope.kind &&
          (this.scope.kind === "project" ||
            (snapshot.scope.kind === "session" &&
              snapshot.scope.sessionID === this.scope.sessionID))
        if (!responseScopeMatches) {
          this.sync.stale = true
          this.update({
            loading: false,
            stale: true,
            error: "The observation belongs to another scope.",
          })
          break
        }
        if (!this.sync.acceptSnapshot(generation, snapshot)) {
          if (run.pending) continue
          break
        }
        this.update({ snapshot, loading: false, stale: false, error: "" })
      } catch (error) {
        if (!this.current(epoch, transport, signal) || generation !== this.sync.generation) break
        this.sync.stale = true
        this.update({
          loading: false,
          stale: true,
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
            error: contiguous ? "" : "Observation gap; refreshing the snapshot.",
          })
          void this.refresh(epoch, generation, transport, signal)
        }
        if (signal.aborted) return
        throw new Error("Observation update stream closed")
      } catch (error) {
        if (!this.current(epoch, transport, signal)) return
        this.sync.stale = true
        this.update({
          loading: !this.data.snapshot,
          stale: true,
          error: transport.online()
            ? `Update stream disconnected; resynchronizing. ${String(error)}`
            : "Server disconnected; showing the last observation.",
        })
        await this.waitForReconnect(signal)
        if (signal.aborted || !this.current(epoch, transport, signal)) return
        generation = this.sync.reconnect()
        void this.refresh(epoch, generation, transport, signal)
      }
    }
  }

  close() {
    this.epoch++
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
