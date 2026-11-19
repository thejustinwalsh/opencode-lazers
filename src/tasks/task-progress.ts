import type { LabelTone } from "../details/tone.ts"

/** The five stages the Tasks pane draws, in order. */
export const PROGRESS_STEPS = ["Queued", "Working", "Checks", "Review", "Integrated"] as const

export type TaskProgressInput = {
  /**
   * The task node's recorded lifecycle state (`taskMachine`): queued, ready, running, verifying,
   * accepted, blocked, failed, exhausted, cancelled or incorporated. A task that is not planned
   * yet is `submitted`.
   */
  state: string
  /** The plan's state (`planMachine`), when planned. */
  planState?: string
  /** The task is held (waiting, paused or needs the person) without leaving its stage. */
  held?: boolean
  /** The latest attempt's state (`attemptMachine`), when one exists. */
  attemptState?: string
  /** The recorded reason, used only to tell a failed check from a failed worker. */
  reason?: string | null
}

export type TaskProgress = {
  /** Index into `PROGRESS_STEPS` of the current stage. */
  current: number
  tone: LabelTone
}

const QUEUED = 0
const WORKING = 1
const CHECKS = 2
const REVIEW = 3
const INTEGRATED = 4

/** The stage an interrupted lifecycle (blocked, failed, cancelled) last reached. */
function reached(input: TaskProgressInput): number {
  switch (input.attemptState) {
    case "verifying":
      return CHECKS
    case "accepted":
      return REVIEW
    case "running":
    case "preparing":
    case "failed":
    case "exhausted":
    case "cancelled":
      return input.reason && /verification|check/i.test(input.reason) ? CHECKS : WORKING
    default:
      return input.attemptState ? WORKING : QUEUED
  }
}

/**
 * Maps the task and plan lifecycle to the five-stage progress. Every `taskMachine` state is
 * covered: queued/ready/submitted are Queued, running is Working, verifying is Checks, accepted
 * is Review (awaiting integration or cleanup) and incorporated is Integrated. Blocked, failed and
 * exhausted stay at the stage the latest attempt reached, in the warning or critical tone;
 * cancelled stays there in the neutral tone; a hold leaves the stage and turns it warning.
 */
export function taskProgress(input: TaskProgressInput): TaskProgress {
  const held = input.held === true
  const integrated = input.planState === "integrated"
  switch (input.state) {
    case "incorporated":
      return { current: INTEGRATED, tone: "success" }
    case "accepted":
      if (integrated) return { current: INTEGRATED, tone: "success" }
      return {
        current: REVIEW,
        tone: held || input.planState === "cleanup-blocked" ? "warning" : "interactive",
      }
    case "verifying":
      return { current: CHECKS, tone: held ? "warning" : "interactive" }
    case "running":
      return { current: WORKING, tone: held ? "warning" : "interactive" }
    case "blocked":
      return { current: reached(input), tone: "warning" }
    case "failed":
    case "exhausted":
      return { current: reached(input), tone: "critical" }
    case "cancelled":
      return { current: reached(input), tone: "neutral" }
    default:
      // queued, ready, submitted, and any state this version does not know.
      return { current: QUEUED, tone: held ? "warning" : "interactive" }
  }
}
