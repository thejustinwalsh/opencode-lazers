import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { createPulseLoop } from "./pulse-loop.ts"
import type { PulseHost } from "./pulse-loop.ts"
import { PULSE_SPEED } from "./pulse-pool.ts"
import type { WireInput } from "./pulse-pool.ts"

/** A host whose clock and frames the test drives; nothing real is scheduled. */
function fakeHost() {
  const state = {
    time: 0,
    hidden: false,
    reduced: false,
    next: 1,
    pending: new Map<number, (t: number) => void>(),
    requests: 0,
  }
  const host: PulseHost = {
    requestFrame: (callback) => {
      state.requests++
      const handle = state.next++
      state.pending.set(handle, callback)
      return handle
    },
    cancelFrame: (handle) => void state.pending.delete(handle),
    now: () => state.time,
    visible: () => !state.hidden,
    reducedMotion: () => state.reduced,
  }
  /** Runs one frame at `dt` after the last one, if one is scheduled. */
  const frame = (dt: number) => {
    state.time += dt
    const entry = [...state.pending][0]
    if (!entry) return false
    state.pending.delete(entry[0])
    entry[1](state.time)
    return true
  }
  return { state, host, frame }
}

const wire = (change: Partial<WireInput> = {}): WireInput => ({
  id: "a",
  x0: 0,
  y0: 10,
  x1: 300,
  y1: 10,
  mx: 150,
  running: true,
  ...change,
})

function layer() {
  const window = new Window()
  const div = window.document.createElement("div")
  window.document.body.append(div)
  return div as unknown as Element
}
const dots = (element: Element) =>
  [...element.querySelectorAll(".lazers-radar-flow-dot")] as HTMLElement[]
const x = (dot: HTMLElement) =>
  Number(/translate3d\(([-\d.]+)px/.exec(dot.style.transform ?? "")?.[1])

test("one frame loop draws pulses that move steadily, and a live update does not move them", () => {
  const { host, frame, state } = fakeHost()
  const target = layer()
  const loop = createPulseLoop(target, host)
  loop.update([wire()])
  expect(state.pending.size).toBe(1)
  for (let i = 0; i < 90; i++) frame(16)
  expect(dots(target).filter((dot) => x(dot) > -10).length).toBeGreaterThan(0)
  const before = loop.pool.fractions("a")
  expect(before.length).toBeGreaterThan(0)
  // A re-render, a data update and a layout change land between frames: nothing resets, and a
  // pulse keeps its fraction of the new, longer wire.
  loop.update([wire()])
  loop.update([wire({ dim: true })])
  loop.update([wire({ x1: 400, mx: 200 })])
  expect(loop.pool.fractions("a")).toEqual(before)
  expect(state.pending.size).toBe(1)
  frame(16)
  const after = loop.pool.fractions("a")
  const step = (PULSE_SPEED * 16) / 1000 / 400
  before.forEach((value, index) => {
    expect(after[index]! - value).toBeGreaterThan(0)
    expect(after[index]! - value).toBeLessThan(step * 1.5)
  })
  expect(loop.stats.frames).toBe(91)
  loop.dispose()
})

test("the loop stops when nothing is left to move, when hidden and under reduced motion", () => {
  const { host, frame, state } = fakeHost()
  const target = layer()
  const loop = createPulseLoop(target, host)
  loop.update([wire()])
  for (let i = 0; i < 20; i++) frame(100)
  loop.update([wire({ running: false })])
  // In-flight pulses finish, then the loop stops asking for frames.
  let guard = 0
  while (state.pending.size > 0 && guard++ < 1_000) frame(100)
  expect(state.pending.size).toBe(0)
  expect(loop.pool.size).toBe(0)
  expect(loop.running).toBe(false)

  // Hidden: no frames are requested and none run; coming back resumes without a jump.
  loop.update([wire()])
  for (let i = 0; i < 40; i++) frame(100)
  const requests = state.requests
  state.hidden = true
  loop.wake()
  expect(state.pending.size).toBe(0)
  loop.update([wire()])
  expect(state.requests).toBe(requests)
  state.time += 120_000
  state.hidden = false
  loop.wake()
  expect(state.pending.size).toBe(1)
  loop.dispose()
  expect(state.pending.size).toBe(0)

  // Reduced motion: updates never start the loop.
  const still = fakeHost()
  still.state.reduced = true
  const stillLoop = createPulseLoop(layer(), still.host)
  stillLoop.update([wire()])
  expect(still.state.requests).toBe(0)
  stillLoop.dispose()
})

test("frame cost: ten seconds at 60 fps over eight running wires", () => {
  const { host, frame } = fakeHost()
  const target = layer()
  const loop = createPulseLoop(target, host)
  loop.update(
    Array.from({ length: 8 }, (_, index) =>
      wire({ id: `w${index}`, x1: 200 + index * 40, y1: index * 30 }),
    ),
  )
  const costs: number[] = []
  for (let i = 0; i < 600; i++) {
    const started = performance.now()
    frame(1000 / 60)
    costs.push(performance.now() - started)
  }
  costs.sort((a, b) => a - b)
  const p = (q: number) => costs[Math.floor(costs.length * q)]!
  console.info("PULSE-FRAME-COST", { frames: 600, p50: p(0.5), p95: p(0.95), max: costs.at(-1) })
  expect(loop.pool.size).toBeGreaterThan(8)
  // 16.7 ms is the frame budget; the loop's own work should be a small fraction of it.
  expect(p(0.95)).toBeLessThan(4)
  loop.dispose()
})

test("frames are capped: positions stay time-based while draws and style writes are skipped", () => {
  const { host, frame } = fakeHost()
  const capped = { ...host, minFrameMs: 33 }
  const target = layer()
  const loop = createPulseLoop(target, capped)
  loop.update([wire()])
  for (let i = 0; i < 120; i++) frame(16)
  // 120 frames of 16 ms is 1920 ms; a draw needs 33 ms, so every third 16 ms frame: 40, not 120.
  expect(loop.stats.frames).toBeLessThan(62)
  expect(loop.stats.frames).toBeGreaterThan(30)
  // Travel is by elapsed time, not by draw count: ~90 px/s over 1.9 s covers about 170 px.
  const lead = Math.max(...dots(target).map(x))
  expect(lead).toBeGreaterThan(100)
  loop.dispose()
})

test("a frame writes only transforms, and only for dots that moved", () => {
  const { host, frame } = fakeHost()
  const target = layer()
  const loop = createPulseLoop(target, host)
  loop.update([wire()])
  for (let i = 0; i < 40; i++) frame(16)
  const writes: string[] = []
  const observer = new (
    target.ownerDocument!.defaultView as unknown as { MutationObserver: typeof MutationObserver }
  ).MutationObserver((records) => {
    for (const record of records) writes.push(`${record.type}:${record.attributeName}`)
  })
  observer.observe(target, { attributes: true, childList: true, subtree: true })
  // Zero elapsed time: nothing moved, so nothing is written.
  frame(0)
  expect(writes).toEqual([])
  loop.dispose()
})
