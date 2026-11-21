import type { TaskState } from "../../../../src/runner/schema.ts"
import { T0 } from "../story.ts"

/**
 * Pure answers for the Trajectory panel: a compact description of one task's recorded work at one
 * moment, expanded into the rows of the four `trajectory.*` stream sources (and `tasks.schedule`)
 * the real panel reads. No browser or Solid code, so the build script can validate it.
 *
 * All times are seconds after the work began; the work began six minutes before the story's
 * wall-clock origin, so every recorded time is in the story's past.
 */
export interface DemoCall {
  /** Stable name; `markID` turns it into the id of its mark on the timeline. */
  key: string
  attempt: 1 | 2
  tool: "Read" | "Grep" | "Edit" | "Bash"
  at: number
  /** Duration in seconds. */
  s: number
  status: "completed" | "error"
  /** File the call read or edited. */
  path?: string
  command?: string
  /** What the call printed. */
  result?: string
}
export interface DemoCheck {
  id: "tests" | "typecheck"
  attempt: 1 | 2
  start: number
  /** Null while the check is still running. */
  end: number | null
  result: "passed" | "failed" | "unknown"
  command: string
  exit?: number
  stdout?: string
  stderr?: string
}
export interface DemoAttempt {
  number: 1 | 2
  state: "failed" | "running" | "verifying" | "accepted"
  start: number
  end: number | null
  /** When the worker stopped editing and verification began. */
  workEnd: number | null
  model: { providerID: string; id: string; variant?: string }
}
export interface DemoOtherTask {
  n: number
  title: string
  state: TaskState
  plan: string
  /** Whether this session created it; the session scope lists only these. */
  session: boolean
}
export interface TrajectoryData {
  /** Change counter: the producer's event sequence. */
  version: number
  /** The task whose trajectory the story opens. */
  task: { n: number; title: string; objective: string; state: TaskState; plan: string }
  attempts: DemoAttempt[]
  calls: DemoCall[]
  checks: DemoCheck[]
  others: DemoOtherTask[]
}

export const PROJECT = { canonical: "/workspace/lazers-demo", id: "demo-project" }
const OWNER_SESSION = "ses-demo"
const SEC = 1000
const WORK_START = T0 - 360 * SEC
export const when = (seconds: number) => WORK_START + Math.round(seconds * SEC)
export const sessionOf = (attempt: number) => `ses-worker-${attempt}`
export const callID = (call: Pick<DemoCall, "key">) => `call-${call.key}`

/** The id of a call's mark on the timeline (`data-mark-id`), for the story's selectors. */
export const markID = (attempt: 1 | 2, key: string) => `${sessionOf(attempt)}:tool:call-${key}`
/** RFC 4122 v4-shaped ids, stable per kind and number. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
export const taskID = (n: number) => uid(1, n)
export const attemptID = (number: number) => uid(2, number)
const planTitles = (data: TrajectoryData) => [
  ...new Set([data.task.plan, ...data.others.map((task) => task.plan)]),
]
export const planID = (data: TrajectoryData, title: string) =>
  uid(3, planTitles(data).indexOf(title) + 1)
const ref = (n: number) => `LZ-${n}`

export function transitions(data: TrajectoryData) {
  const list: {
    at: number
    attempt: 1 | 2 | null
    event: string
    from: TaskState | null
    to: TaskState
    reason: string | null
  }[] = [{ at: 1, attempt: null, event: "QUEUED", from: null, to: "queued", reason: null }]
  for (const attempt of data.attempts) {
    list.push({
      at: attempt.start,
      attempt: attempt.number,
      event: "START",
      from: attempt.number === 1 ? "ready" : "failed",
      to: "running",
      reason: null,
    })
    if (attempt.workEnd !== null && attempt.state !== "failed")
      list.push({
        at: attempt.workEnd,
        attempt: attempt.number,
        event: "VERIFY",
        from: "running",
        to: "verifying",
        reason: null,
      })
    if (attempt.state === "failed" && attempt.end !== null)
      list.push({
        at: attempt.end,
        attempt: attempt.number,
        event: "FAIL",
        from: "running",
        to: "failed",
        reason: "The tests check failed",
      })
    if (attempt.state === "accepted" && attempt.end !== null)
      list.push({
        at: attempt.end,
        attempt: attempt.number,
        event: "ACCEPT",
        from: "verifying",
        to: "accepted",
        reason: null,
      })
  }
  return list
}
