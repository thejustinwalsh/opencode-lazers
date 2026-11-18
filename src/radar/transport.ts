import { RadarLocationNotLoadedError } from "./project.ts"
import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "../observability/contract.ts"

type RPCOptions = { location: { directory: string }; signal: AbortSignal }

export type RadarRPC = {
  snapshot(input: { scope: ObservationScope }, options: RPCOptions): Promise<SnapshotResponse>
  radar(
    input: { scope: ObservationScope; includeUnmanagedSessions: boolean },
    options: RPCOptions,
  ): Promise<RadarResponse>
  events: {
    subscribe(
      name: "changed",
      options: { signal: AbortSignal },
    ): AsyncIterable<{ location?: { directory: string }; data: ObservationChange }>
  }
}

export type RadarTransport = {
  snapshot(scope: ObservationScope, signal: AbortSignal): Promise<SnapshotResponse>
  radar(
    scope: ObservationScope,
    includeUnmanagedSessions: boolean,
    signal: AbortSignal,
  ): Promise<RadarResponse>
  changes(signal: AbortSignal): AsyncIterable<ObservationChange>
  online(): boolean
}

/** Keep OpenCode's RPC/location details at the panel boundary. */
export function createRadarTransport(
  rpc: () => RadarRPC,
  directory: string,
  online: () => boolean,
  initialProjectID?: string,
  /** Location-scoped calls boot an unloaded location; skip them unless it is loaded. */
  locationLoaded: () => Promise<boolean> = async () => true,
): RadarTransport {
  const requireLoaded = async () => {
    if (!(await locationLoaded())) throw new RadarLocationNotLoadedError(directory)
  }
  let projectID = initialProjectID
  let resolveProjectID!: (value: string) => void
  const projectIDReady = new Promise<string>((resolve) => {
    resolveProjectID = resolve
  })
  if (projectID) resolveProjectID(projectID)
  const rememberProjectID = (value: string) => {
    if (projectID) return
    projectID = value
    resolveProjectID(value)
  }
  const waitForProjectID = (signal: AbortSignal) =>
    new Promise<string | undefined>((resolve) => {
      if (projectID) return resolve(projectID)
      if (signal.aborted) return resolve(undefined)
      const aborted = () => resolve(undefined)
      signal.addEventListener("abort", aborted, { once: true })
      void projectIDReady.then((value) => {
        signal.removeEventListener("abort", aborted)
        resolve(value)
      })
    })

  return {
    snapshot: async (scope, signal) => {
      await requireLoaded()
      const response = await rpc().snapshot({ scope }, { location: { directory }, signal })
      rememberProjectID(response.projectID)
      return response
    },
    radar: async (scope, includeUnmanagedSessions, signal) => {
      await requireLoaded()
      const response = await rpc().radar(
        { scope, includeUnmanagedSessions },
        { location: { directory }, signal },
      )
      rememberProjectID(response.projectID)
      return response
    },
    changes: (signal) =>
      (async function* () {
        for await (const event of rpc().events.subscribe("changed", { signal })) {
          if (signal.aborted) return
          const expectedProjectID = projectID ?? (await waitForProjectID(signal))
          if (signal.aborted) return
          // The canonical publisher may be attached to a different loaded worktree.
          if (expectedProjectID && event.data.projectID === expectedProjectID) yield event.data
        }
      })(),
    online,
  }
}
