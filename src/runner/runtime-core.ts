import type { ProgressRecorder } from "../progress/recorder.ts"
import type { RunnerHost } from "./host.ts"
import type { RunnerStore } from "./store.ts"

/**
 * What every module split out of `TaskRuntime` reads from the coordinator. `host` is the
 * takeover-aware host, never the one the constructor received.
 */
export type RuntimeCore = {
  readonly store: RunnerStore
  readonly host: RunnerHost
  readonly projectID: string
  readonly owner: string
  readonly directory: string
  readonly dataDirectory: string
  readonly now: () => number
  readonly progress: ProgressRecorder
}

/** Asks the coordinator for another pass over the plans; modules never touch `tickRequested`. */
export type RetickRequest = () => void
