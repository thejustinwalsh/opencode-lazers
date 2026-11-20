import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { createPulseLoop } from "./pulse-loop.ts"
import type { PulseHost, PulseTiming } from "./pulse-loop.ts"
import { MAX_TOTAL, crossingMs, pulsesOn } from "./pulse-path.ts"
import type { WireInput } from "./pulse-path.ts"

type Fake = {
  points: readonly number[]
  timing: PulseTiming
  startedAt: number
  cancelled: boolean
  paused: boolean
  held: number
  done: boolean
  finish: () => void
}

/** A host whose clock and animations the test drives; there are no timers or frames to fake. */
function fakeHost() {
  const state = { time: 0, hidden: false, reduced: false, animations: [] as Fake[] }
  const elapsed = (fake: Fake) => (fake.paused ? fake.held : state.time - fake.startedAt)
  const endsAt = (fake: Fake) =>
    fake.startedAt + fake.timing.delayMs + fake.timing.durationMs * fake.timing.iterations
  const listeners = new Set<() => void>()
  const host: PulseHost = {
    visible: () => !state.hidden,
    reducedMotion: () => state.reduced,
    onReducedMotionChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    animate: (_dot, points, timing, finish) => {
      const fake: Fake = {
        points,
        timing: { ...timing },
        startedAt: state.time,
        cancelled: false,
        paused: false,
        held: 0,
        done: false,
        finish,
      }
      state.animations.push(fake)
      return {
        cancel: () => (fake.cancelled = true),
        pause: () => {
          if (fake.paused) return
          fake.held = elapsed(fake)
          fake.paused = true
        },
        play: () => {
          if (!fake.paused) return
          fake.paused = false
          fake.startedAt = state.time - fake.held
        },
        elapsed: () => elapsed(fake),
        setIterations: (iterations) => (fake.timing.iterations = iterations),
      }
    },
  }
  /** Moves the clock forward, ending finite animations in time order. */
  const advance = (ms: number) => {
    const target = state.time + ms
    for (;;) {
      let next: Fake | undefined
      for (const fake of state.animations)
        if (
          !fake.cancelled &&
          !fake.paused &&
          !fake.done &&
          Number.isFinite(endsAt(fake)) &&
          endsAt(fake) <= target &&
          (!next || endsAt(fake) < endsAt(next))
        )
          next = fake
      if (!next) break
      state.time = Math.max(state.time, endsAt(next))
      next.done = true
      next.finish()
    }
    state.time = target
  }
  const running = () => state.animations.filter((a) => !a.cancelled && !a.done)
  const preference = (reduced: boolean) => {
    state.reduced = reduced
    for (const listener of listeners) listener()
  }
  return { state, host, advance, running, preference, listeners }
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
  return { element: div as unknown as Element, window }
}

test("a running wire gets evenly staggered, repeating compositor animations along its whole length", () => {
  const { host, running } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update([wire()])
  const animations = running()
  const wanted = pulsesOn(300)
  expect(animations).toHaveLength(wanted)
  const period = crossingMs(300)
  animations.forEach((animation, k) => {
    expect(animation.timing.iterations).toBe(Number.POSITIVE_INFINITY)
    expect(animation.timing.durationMs).toBeCloseTo(period, 0)
    expect(animation.timing.delayMs).toBeCloseTo((k * period) / wanted, 0)
    // Source to destination.
    expect(animation.points[0]).toBe(0)
    expect(animation.points.at(-2)).toBeCloseTo(300, 0)
  })
  expect(loop.moving).toBe(wanted)
  loop.dispose()
  expect(running()).toHaveLength(0)
})

test("updates between and during crossings restart nothing and write nothing but dim", () => {
  const { host, advance, running, state } = fakeHost()
  const { element, window } = layer()
  const loop = createPulseLoop(element, host)
  loop.update([wire()])
  advance(7_000)
  const before = running()
  const created = state.animations.length
  const observer = new window.MutationObserver(() => {})
  observer.observe(element as never, { attributes: true, childList: true, subtree: true })
  loop.update([wire()])
  advance(3_000)
  loop.update([wire()])
  expect(state.animations).toHaveLength(created)
  expect(running()).toEqual(before)
  // `takeRecords` is the synchronous view of what the observer queued; its callback has not run.
  expect(observer.takeRecords()).toEqual([])
  loop.update([wire({ dim: true })])
  expect(element.querySelector("[data-dim]")?.getAttribute("data-dim")).toBe("true")
  // Positive control: the same instrumentation does see a real write.
  expect(observer.takeRecords().length).toBeGreaterThan(0)
  expect(state.animations).toHaveLength(created)
  observer.disconnect()
  loop.dispose()
})

test("a wire that stops lets each pulse finish its crossing; none starts, none is dropped", () => {
  const { host, advance, running, state } = fakeHost()
  const { element } = layer()
  const loop = createPulseLoop(element, host)
  loop.update([wire()])
  const period = crossingMs(300)
  advance(period * 1.5)
  const flying = running()
  loop.update([wire({ running: false })])
  expect(running()).toEqual(flying)
  for (const animation of flying) {
    expect(Number.isFinite(animation.timing.iterations)).toBe(true)
    expect(animation.cancelled).toBe(false)
  }
  advance(period * 2)
  expect(running()).toHaveLength(0)
  expect(loop.moving).toBe(0)
  // Running again before the last one lands brings the same pulses back, not new ones.
  loop.update([wire()])
  advance(period * 1.2)
  loop.update([wire({ running: false })])
  const created = state.animations.length
  loop.update([wire()])
  expect(state.animations.length).toBe(created)
  expect(running().every((a) => a.timing.iterations === Number.POSITIVE_INFINITY)).toBe(true)
  loop.dispose()
})

test("a pulse that has not started when its wire stops never will; a left wire winds down too", () => {
  const { host, running } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update([wire()])
  loop.update([wire({ running: false })])
  // Only the first, undelayed pulse had started (at time zero it is just beginning).
  expect(running().length).toBeLessThanOrEqual(1)
  loop.update([wire()])
  loop.update([])
  for (const animation of running()) expect(Number.isFinite(animation.timing.iterations)).toBe(true)
  loop.dispose()
})

test("a changed path re-creates each pulse at the same fraction of the new wire", () => {
  const { host, advance, running } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update([wire()])
  const period = crossingMs(300)
  advance(period * 0.4 + 1_000)
  const first = running()[0]!
  const phase = ((period * 0.4 + 1_000) / period) % 1
  loop.update([wire({ x1: 600, mx: 300 })])
  expect(first.cancelled).toBe(true)
  const next = running()[0]!
  const after = crossingMs(600)
  expect(next.timing.durationMs).toBeCloseTo(after, 0)
  expect(next.timing.delayMs).toBeCloseTo(-phase * after, 0)
  expect(running()).toHaveLength(pulsesOn(300))
  loop.dispose()
})

test("hidden views pause every animation and resume them where they were; reduced motion makes none", () => {
  const { host, advance, running, state } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update([wire()])
  advance(3_000)
  const moving = running()
  state.hidden = true
  loop.wake()
  expect(moving.every((a) => a.paused)).toBe(true)
  const created = state.animations.length
  // A wire that starts while hidden is paused from the start.
  loop.update([wire(), wire({ id: "b" })])
  const late = state.animations.slice(created)
  expect(late.length).toBeGreaterThan(0)
  expect(late.every((a) => a.paused)).toBe(true)
  advance(120_000)
  state.hidden = false
  loop.wake()
  expect(running().every((a) => !a.paused)).toBe(true)
  loop.dispose()

  const still = fakeHost()
  still.state.reduced = true
  const stillLoop = createPulseLoop(layer().element, still.host)
  stillLoop.update([wire()])
  expect(still.state.animations).toHaveLength(0)
  stillLoop.dispose()
})

test("the whole view is capped", () => {
  const { host, running } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update(
    Array.from({ length: 40 }, (_, index) =>
      wire({ id: `w${index}`, x1: 500, y1: index * 20, mx: 250 }),
    ),
  )
  expect(running().length).toBeLessThanOrEqual(MAX_TOTAL)
  expect(loop.moving).toBe(running().length)
  loop.dispose()
})

test("70a0f10e-1: a reduced-motion change stops every pulse at once and opting out restores them", () => {
  const { host, running, preference, listeners } = fakeHost()
  const loop = createPulseLoop(layer().element, host)
  loop.update([wire()])
  expect(running().length).toBeGreaterThan(0)
  preference(true)
  expect(running()).toHaveLength(0)
  expect(loop.moving).toBe(0)
  preference(false)
  expect(running().length).toBeGreaterThan(0)
  loop.dispose()
  expect(listeners.size).toBe(0)
})
