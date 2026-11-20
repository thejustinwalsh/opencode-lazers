import { expect, test } from "bun:test"
import { handleCommand } from "../src/commands"
import { Clock } from "../src/engine"

test("aa3c498c-1: a settled frame still seeks, and ignores play and pause", () => {
  const seen: string[] = []
  const settled = { seek: (chapter: string) => seen.push(`seek:${chapter}`) }
  handleCommand({ demo: true, type: "play" }, settled)
  handleCommand({ demo: true, type: "pause" }, settled)
  handleCommand({ demo: true, type: "seek", chapter: "review" }, settled)
  expect(seen).toEqual(["seek:review"])
})

test("aa3c498c-2: a paused clock schedules no frames and resumes parked loops on play", async () => {
  const requested: number[] = []
  const g = globalThis as unknown as Record<string, unknown>
  const saved = [g.requestAnimationFrame, g.cancelAnimationFrame]
  let id = 0
  g.requestAnimationFrame = (callback: (now: number) => void) => {
    requested.push(++id)
    setTimeout(() => callback(performance.now()), 0)
    return id
  }
  g.cancelAnimationFrame = () => {}
  try {
    const clock = new Clock()
    let resumed = false
    const waiting = clock.nextFrame().then(() => (resumed = true))
    await Bun.sleep(20)
    expect(requested).toEqual([])
    expect(resumed).toBe(false)
    clock.play()
    await waiting
    expect(resumed).toBe(true)
    clock.pause()
  } finally {
    ;[g.requestAnimationFrame, g.cancelAnimationFrame] = saved
  }
})
