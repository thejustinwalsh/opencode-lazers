import { expect, test } from "bun:test"
import { attemptLane, modelText, taskStats } from "./stats.ts"

const HOUR = 3_600_000
const attempt = {
  state: "running",
  startedAt: 1_000_000,
  toolCount: 17,
  model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
  summary: { lastActivityAt: 1_000_000 + 48 * 60_000, ticks: [{ at: 1_060_000 }], files: 5 },
}
const values = (stats: ReturnType<typeof taskStats>) =>
  Object.fromEntries(stats.map((stat) => [stat.label, stat.value]))

test("stats are real values: age, runtime, calls with files, model", () => {
  expect(
    values(taskStats({ createdAt: 0, now: 44 * HOUR, attempt: { ...attempt, state: "failed" } })),
  ).toEqual({ Age: "1d 20h", Runtime: "48m", Calls: "17 · 5 files", Model: "gpt-6-luna · max" })
  expect(values(taskStats({ createdAt: 0, now: 1_000_000 + 5 * 60_000, attempt })).Runtime).toBe(
    "5m",
  )
})

test("what cannot be sourced is omitted, never labelled", () => {
  expect(values(taskStats({ createdAt: 0, now: HOUR }))).toEqual({
    Age: "1h",
    Runtime: undefined,
    Calls: undefined,
    Model: undefined,
  })
  const bare = { state: "failed", startedAt: 5, toolCount: 0 }
  expect(values(taskStats({ createdAt: 0, now: HOUR, attempt: bare }))).toEqual({
    Age: "1h",
    Runtime: undefined,
    Calls: "0",
    Model: undefined,
  })
  expect(modelText({ providerID: "p", id: "m" })).toBe("m")
  expect(modelText(undefined)).toBeUndefined()
})

test("the lane is relative to the attempt and absent without ticks", () => {
  const lane = attemptLane(attempt, 1_000_000 + 10 * 60_000)!
  expect(lane.ticks).toEqual([{ at: 60_000 }])
  expect(lane.durationMs).toBe(10 * 60_000)
  expect(lane.live).toBe(true)
  const done = attemptLane({ ...attempt, state: "accepted" }, 9e12)!
  expect(done.durationMs).toBe(48 * 60_000)
  expect(done.live).toBe(false)
  expect(attemptLane({ ...attempt, summary: { ticks: [] } }, 0)).toBeUndefined()
  expect(attemptLane(undefined, 0)).toBeUndefined()
})

test("a held attempt still recorded as running stops its runtime at the last activity", () => {
  const held = taskStats({ createdAt: 0, now: 44 * HOUR, attempt, working: false })
  expect(values(held).Age).toBe("1d 20h")
  expect(values(held).Runtime).toBe("48m")
  expect(values(taskStats({ createdAt: 0, now: 44 * HOUR, attempt, working: true })).Runtime).toBe(
    "1d 19h",
  )
  // The lane still spans to now, so the quiet stretch collapses to an idle span before "now".
  expect(attemptLane(attempt, 44 * HOUR)!.durationMs).toBe(44 * HOUR - attempt.startedAt)
})
