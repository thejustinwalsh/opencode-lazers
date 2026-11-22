import { expect, test } from "bun:test"
import { defineHostSource, findHostSource, openHostStream, type HostPager } from "./host-source.ts"
import { findSource } from "./source.ts"

const columns = { id: "int", label: "text" } as const

/** A host list of ids 1..n; a position is the index of the boundary. */
function listPager(state: { ids: number[]; reads: number; watchers: Set<() => void> }): HostPager {
  const rowsOf = (from: number, to: number) =>
    state.ids.slice(from, to).map((id) => [id, `row ${id}`])
  return {
    async page({ from, direction, limit, signal }) {
      signal.throwIfAborted()
      state.reads++
      await Promise.resolve()
      const n = state.ids.length
      const at =
        from === "head"
          ? 0
          : from === "tail"
            ? n
            : "position" in from
              ? Number(from.position)
              : state.ids.indexOf(Number(from.key[0]))
      if (at < 0) throw new Error("no such row")
      const [lo, hi] =
        direction === "after" ? [at, Math.min(n, at + limit)] : [Math.max(0, at - limit), at]
      return {
        rows: rowsOf(lo, hi),
        start: String(lo),
        end: String(hi),
        before: lo > 0,
        after: hi < n,
      }
    },
    watch(notify) {
      state.watchers.add(notify)
      return () => void state.watchers.delete(notify)
    },
  }
}

const fresh = (n: number) => ({
  ids: Array.from({ length: n }, (_, i) => i + 1),
  reads: 0,
  watchers: new Set<() => void>(),
})
const source = (state: ReturnType<typeof fresh>) =>
  defineHostSource({
    name: "test.host-list",
    key: ["id"],
    columns,
    open: () => listPager(state),
  })
const ids = (stream: { items: readonly { id: unknown }[] }) => stream.items.map((row) => row.id)
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
const hint = (state: ReturnType<typeof fresh>) => state.watchers.forEach((notify) => notify())
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("condition not reached")
}

test("host sources register apart from SQL sources and can be told apart", () => {
  source(fresh(1))
  expect(findHostSource("test.host-list")?.kind).toBe("host")
  expect(findSource("test.host-list")).toBeUndefined()
})

test("head and tail anchors fill the window with before and after flags", async () => {
  const state = fresh(100)
  const def = source(state)
  const head = openHostStream(def, { filter: {}, window: 10, runtime: undefined as never })
  await head.ready()
  expect(ids(head)).toEqual(range(1, 10))
  expect([head.before, head.after]).toEqual([0, "more"])
  expect(head.bytes).toBeInstanceOf(Uint8Array)
  const tail = openHostStream(def, {
    filter: {},
    window: 10,
    anchor: "tail",
    runtime: undefined as never,
  })
  await tail.ready()
  expect(ids(tail)).toEqual(range(91, 100))
  expect([tail.before, tail.after]).toEqual(["more", 0])
  head.close()
  tail.close()
})

test("slide forward and back reads only the new edge and keeps the window exact", async () => {
  const state = fresh(100)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  const revision = stream.revision
  await stream.slide(3)
  expect(ids(stream)).toEqual(range(4, 13))
  expect(stream.revision).toBeGreaterThan(revision)
  await stream.slide(-2)
  expect(ids(stream)).toEqual(range(2, 11))
  await stream.slide(50) // beyond the overlap: skip, then a whole window
  expect(ids(stream)).toEqual(range(52, 61))
  await stream.slide(-100) // past the start: the head window
  expect(ids(stream)).toEqual(range(1, 10))
  expect(stream.before).toBe(0)
  await stream.slide(1000) // past the end: the last window
  expect(ids(stream)).toEqual(range(91, 100))
  expect(stream.after).toBe(0)
  await stream.slide(5) // at the end: nothing moves
  expect(ids(stream)).toEqual(range(91, 100))
  stream.close()
})

test("a slide holds no rows beyond the window and reads a small edge", async () => {
  const state = fresh(10_000)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  state.reads = 0
  await stream.slide(2)
  // One read for the two new rows and one to advance the start past the two dropped.
  expect(state.reads).toBe(2)
  expect(stream.items.length).toBe(10)
  stream.close()
})

test("seek to a key places it at the center or the start; a missing key rejects", async () => {
  const state = fresh(100)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  await stream.seek({ key: [50] })
  expect(ids(stream)).toEqual(range(45, 54))
  await stream.seek({ key: [50], place: "start" })
  expect(ids(stream)[0]).toBe(50)
  await stream.seek({ key: [99] })
  expect(ids(stream)).toEqual(range(91, 100))
  await expect(stream.seek({ key: [500] })).rejects.toThrow("no such row")
  await stream.seek("head")
  expect(ids(stream)).toEqual(range(1, 10))
  stream.close()
})

test("a hint after new rows updates the window; an unchanged window emits nothing", async () => {
  const state = fresh(5)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  let changes = 0
  stream.on("change", () => changes++)
  hint(state)
  await Bun.sleep(30)
  expect(changes).toBe(0)
  state.ids.push(6, 7)
  hint(state)
  await until(() => changes === 1)
  expect(ids(stream)).toEqual(range(1, 7))
  stream.close()
})

test("a tail stream follows new rows; a slid-away tail stream does not jump back", async () => {
  const state = fresh(30)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    anchor: "tail",
    runtime: undefined as never,
  })
  await stream.ready()
  state.ids.push(31, 32)
  hint(state)
  await until(() => ids(stream).at(-1) === 32)
  expect(ids(stream)).toEqual(range(23, 32))
  await stream.slide(-10)
  const held = ids(stream)
  state.ids.push(33)
  hint(state)
  await Bun.sleep(30)
  expect(ids(stream)).toEqual(held)
  stream.close()
})

test("late, duplicated, reordered and lost hints converge on the next one", async () => {
  const state = fresh(20)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  state.ids.push(21)
  // The change is hinted twice at once, then a second change is never hinted.
  hint(state)
  hint(state)
  state.ids.splice(0, 0, 0)
  await Bun.sleep(30)
  const afterFirst = ids(stream)
  state.ids.push(22)
  hint(state)
  await Bun.sleep(30)
  expect(ids(stream)).toEqual(state.ids.slice(0, 10))
  expect(afterFirst).toEqual(state.ids.slice(0, 10).filter((id) => id !== 22))
  stream.close()
})

test("a refresh during a slide waits its turn and does not corrupt the window", async () => {
  const state = fresh(100)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  const slides = [stream.slide(4), stream.slide(4), stream.slide(-3)]
  hint(state)
  hint(state)
  await Promise.all(slides)
  await Bun.sleep(30)
  // The refresh re-reads from the start the slides left: still ten consecutive rows.
  const now = ids(stream) as number[]
  expect(now).toHaveLength(10)
  expect(now[0]).toBe(6)
  expect(now.every((id, i) => id === now[0]! + i)).toBe(true)
  stream.close()
})

test("close stops watching and rejects later moves", async () => {
  const state = fresh(20)
  const stream = openHostStream(source(state), {
    filter: {},
    window: 10,
    runtime: undefined as never,
  })
  await stream.ready()
  expect(state.watchers.size).toBe(1)
  stream.close()
  expect(state.watchers.size).toBe(0)
  await expect(stream.slide(1)).rejects.toThrow("closed")
  expect(stream.bytes).toBeUndefined()
})
