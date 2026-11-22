import { Streams } from "../../../../src/streams/contract.ts"
import { radarStreams } from "./radar-streams.ts"
import type { Read } from "../adapter.ts"
import { T0 } from "../story.ts"

/**
 * Pure answers for the Radar panel: a compact description of the world at one moment, expanded
 * into the stream frames (`radar-streams.ts`) the real panel reads. No browser or Solid code, so the build script can validate it.
 * Times are story milliseconds: 0 is the story's start and the demo's `Date.now()` is `T0 + clock`.
 */
export interface DemoCall {
  /** Native tool name: read, edit, bash, grep... */
  tool: string
  /** One redacted line of what the call ran: its command, file or pattern. */
  detail?: string
  /** File the call read or edited. */
  path?: string
  op?: "read" | "edit" | "patch"
  /** Story ms the call started. */
  at: number
  /** How long it ran; absent while it is still running. */
  ms?: number
  /** Error text of a failed call. */
  failed?: string
}
export interface DemoModel {
  providerID: string
  id: string
  variant?: string
}
export interface DemoWorker {
  /** Reference number: 204 is LZ-204. */
  n: number
  title: string
  state: "preparing" | "running" | "verifying"
  /** Story ms the attempt started; negative when it began before the story. */
  startedAt: number
  model: DemoModel
  /** The calls the live read lists, oldest first. */
  calls: DemoCall[]
  /** Tool calls the attempt has made in all; at least `calls.length`. */
  toolCount: number
  files?: number
  /** Why the task is held: the worker is waiting rather than running. */
  held?: string
  /** An open worker concern with the rule's recommended action. */
  concern?: {
    line: string
    action?: "acknowledge" | "steer" | "takeover" | "cancel"
    because?: string
  }
}
export interface DemoTaskRef {
  n: number
  title: string
}
export interface RadarData {
  /** Observation revision: every step that changes what a service would answer raises it. */
  rev: number
  architect: { busy: boolean; model: DemoModel; calls: DemoCall[]; updatedAt: number }
  workers: DemoWorker[]
  /** Recorded task counts behind the project summary and the Map's Queue group. */
  needsYou: DemoTaskRef[]
  failed: DemoTaskRef[]
  queued: DemoTaskRef[]
}

export const PROJECT = { canonical: "/workspace/lazers-demo", id: "demo-project" }
/** The session the panel is open beside: the Architect's. */
const ARCHITECT = "ses-demo"
/** RFC 4122 v4-shaped ids, stable per kind and number. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const taskID = (n: number) => uid(1, n)
const attemptID = (n: number) => uid(2, n)
const ref = (n: number) => `LZ-${n}`
const workerSession = (n: number) => `ses-worker-${n}`
const abs = (at: number) => T0 + at

/** The open streams of the mounted panel, told to re-read when the story moves. */
let streams: ReturnType<typeof radarStreams> | undefined

export function rpc(data: () => RadarData) {
  streams = radarStreams(data, {
    project: PROJECT.canonical,
    architect: ARCHITECT,
    taskID,
    attemptID,
    ref,
    workerSession,
    abs,
  })
  return { [Streams.id]: streams } as unknown as Record<
    string,
    Record<string, (input: never) => unknown>
  >
}

/** Every distinct read this data answers, with the contract schema that must accept it. */
export function reads(_data: RadarData): Read[] {
  return []
}

/**
 * What the service publishes after a change: the `changed` event of every open stream, so each
 * re-reads its window over the moved data.
 */
export function radarChanged(emit: (type: string, data: unknown) => void, _data: RadarData) {
  for (const event of streams?.changes() ?? []) emit(`rpc.${Streams.id}.changed`, event)
}
