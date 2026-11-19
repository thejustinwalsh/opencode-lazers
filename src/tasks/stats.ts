import { callsText, durationText } from "../details/format.ts"
import type { AttemptModel, AttemptSummary } from "./attempt-summary.ts"

export type StatAttempt = {
  state: string
  startedAt: number
  toolCount: number
  model?: AttemptModel
  summary?: AttemptSummary
}

const LIVE = new Set(["preparing", "running", "verifying"])

/** `gpt-6-luna · max`: the model id and its effort. The provider is an identifier, not a stat. */
export function modelText(model: AttemptModel | undefined) {
  if (!model) return undefined
  return model.variant ? `${model.id} · ${model.variant}` : model.id
}

/**
 * Epoch ms the latest attempt's working time ends: now only while the worker is genuinely working,
 * else its last recorded progress. An attempt still recorded as running under a hold or after an
 * interruption (`working` false) stopped at its last activity, not now.
 */
export function attemptEnd(attempt: StatAttempt, now: number, working = true) {
  if (LIVE.has(attempt.state) && working) return now
  const last = attempt.summary?.lastActivityAt
  return last !== undefined && last >= attempt.startedAt ? last : undefined
}

/**
 * The first-screen stats. Each is real or absent: Age needs the task's creation time, the rest
 * need a latest attempt, and Runtime needs a known end.
 */
export function taskStats(input: {
  createdAt: number
  now: number
  attempt?: StatAttempt
  /** The task's state word is Running/Verifying; false for a held, waiting or interrupted task. */
  working?: boolean
}): Array<{ label: string; value?: string }> {
  const { attempt } = input
  const end = attempt ? attemptEnd(attempt, input.now, input.working ?? true) : undefined
  return [
    { label: "Age", value: durationText(Math.max(0, input.now - input.createdAt)) },
    {
      label: "Runtime",
      ...(attempt && end !== undefined
        ? { value: durationText(Math.max(0, end - attempt.startedAt)) }
        : {}),
    },
    {
      label: "Calls",
      ...(attempt ? { value: callsText(attempt.toolCount, attempt.summary?.files) } : {}),
    },
    { label: "Model", ...(modelText(attempt?.model) ? { value: modelText(attempt?.model)! } : {}) },
  ]
}

/** The lane's ticks relative to the attempt start, and its span; none when nothing can be drawn. */
export function attemptLane(attempt: StatAttempt | undefined, now: number) {
  if (!attempt?.summary?.ticks.length) return undefined
  const end = attemptEnd(attempt, now) // the lane spans to now while the attempt row is live
  const ticks = attempt.summary.ticks.map((tick) => ({
    at: Math.max(0, tick.at - attempt.startedAt),
    ...(tick.failed ? { failed: true } : {}),
  }))
  const span = Math.max(end !== undefined ? end - attempt.startedAt : 0, ticks.at(-1)!.at)
  return { ticks, durationMs: span, live: LIVE.has(attempt.state), end }
}
