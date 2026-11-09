import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { Worker } from "node:worker_threads"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { createRoot } from "solid-js"
import { clampSplit, splitFromPointer } from "./layout.ts"
import { createRadarLayoutService } from "./layout-main.ts"
import { createStableRadarLayout, RadarLayoutCoordinator } from "./layout-state.ts"
import { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"

const services: ReturnType<typeof createRadarLayoutService>[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})
function layoutService(source: string, options?: { eval: boolean }) {
  const service = createRadarLayoutService(source, options)
  services.push(service)
  return service
}

function layoutInput(key: string): RadarLayoutInput {
  return {
    key,
    scopeKey: key,
    groups: [{ id: "runtime", label: "Runtime", width: 100, height: 20 }],
    nodes: [{ id: "component", group: "runtime", width: 140, height: 80 }],
    edges: [],
  }
}

function resultFor(input: RadarLayoutInput): RadarLayoutResult {
  return {
    key: input.key,
    width: 220,
    height: 140,
    groups: [{ id: "runtime", x: 0, y: 0, width: 220, height: 140 }],
    nodes: [{ id: "component", x: 30, y: 40, width: 140, height: 80 }],
    edges: [],
    elapsedMs: 1,
    workerThreadId: 1,
  }
}

function workerPath() {
  const packaged = fileURLToPath(new URL("../../dist/radar-layout-worker.cjs", import.meta.url))
  return existsSync(packaged)
    ? packaged
    : fileURLToPath(new URL("./elk-worker.cjs", import.meta.url))
}

test("F-S14-1 layout failures retain readable messages without object coercion", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const state = createStableRadarLayout(() => layoutInput("failure"), {
        layout: async () => {
          throw { data: { message: "Reconnect layout service" } }
        },
      })
      setTimeout(() => {
        try {
          expect(state.error()).toBe("Reconnect layout service")
          expect(state.error()).not.toContain("[object Object]")
          resolve()
        } catch (error) {
          reject(error)
        } finally {
          dispose()
        }
      }, 0)
    })
  })
})

test("Radar split uses live wrapped-header geometry and explicit percentage bounds", () => {
  for (const headerHeight of [40, 84, 126]) {
    const rootTop = 24
    const rootHeight = 620
    const separator = 6
    const usable = rootHeight - headerHeight - separator
    const pointer = rootTop + headerHeight + usable * 0.55
    expect(splitFromPointer(55, rootTop, rootHeight, headerHeight, separator, pointer)).toBeCloseTo(
      55,
    )
  }
  expect(clampSplit(55)).toBe(55)
  expect(splitFromPointer(55, 0, 70, 90, 6, 40)).toBe(55)
})

test("multiple pointer moves, short panels, and boundary keys stay in range", () => {
  const moves = [100, 190, 330, 270, 25]
  const values = moves.map((pointer) => splitFromPointer(55, 12, 400, 88, 6, pointer))
  expect(values[0]).toBe(20)
  expect(values[2]).toBeGreaterThan(values[1]!)
  expect(values[3]).toBeLessThan(values[2]!)
  expect(values.at(-1)).toBe(20)
  expect(clampSplit(100)).toBe(80)
  expect(clampSplit(-1)).toBe(20)
})

test("ELK places grouped nodes and typed edges in a separate native worker thread", async () => {
  const service = layoutService(workerPath())
  const input = {
    key: "layout-test",
    scopeKey: "project",
    groups: [
      { id: "runtime", label: "LAZERS runtime", width: 140, height: 20 },
      { id: "sessions", label: "Native sessions", width: 120, height: 20 },
    ],
    nodes: [
      { id: "component:runner", group: "runtime", width: 180, height: 82 },
      { id: "component:worker", group: "runtime", width: 180, height: 82 },
      { id: "session:architect", group: "sessions", width: 200, height: 82 },
    ],
    edges: [
      {
        id: "dispatch",
        source: "component:runner",
        target: "session:architect",
        label: "dispatch",
        labelWidth: 62,
        labelHeight: 16,
      },
      {
        id: "outcome",
        source: "session:architect",
        target: "component:worker",
        label: "outcome",
        labelWidth: 58,
        labelHeight: 16,
      },
    ],
  } as const

  const first = await service.layout(input, new AbortController().signal)
  const second = await service.layout(
    { ...input, key: "different-key" },
    new AbortController().signal,
  )
  expect(second.workerThreadId).toBe(first.workerThreadId)
  expect(first.workerThreadId).toBeGreaterThan(0)
  expect(first.width).toBeGreaterThan(0)
  expect(first.height).toBeGreaterThan(0)
  expect(first.groups).toHaveLength(2)
  expect(first.nodes).toHaveLength(3)
  expect(first.edges.map((edge) => edge.id).sort()).toEqual(["dispatch", "outcome"])
  expect(first.nodes.map(({ id, x, y }) => [id, x, y])).toEqual(
    second.nodes.map(({ id, x, y }) => [id, x, y]),
  )
  expect(first.edges.map(({ id, path }) => [id, path])).toEqual(
    second.edges.map(({ id, path }) => [id, path]),
  )
})

test("IPC accepts large ELK graph and group extents while retaining individual measurement bounds", async () => {
  const input: RadarLayoutInput = {
    key: "many-sessions",
    scopeKey: "project",
    groups: [{ id: "sessions", label: "Native sessions", width: 140, height: 20 }],
    nodes: Array.from({ length: 30 }, (_, index) => ({
      id: `session:${index}`,
      group: "sessions",
      width: 240,
      height: 90,
    })),
    edges: [],
  }
  const service = layoutService(workerPath())
  const result = await service.layout(input, new AbortController().signal)
  expect(result.height).toBeGreaterThan(2000)
  expect(result.groups[0]!.height).toBeGreaterThan(2000)
  expect(Schema.decodeUnknownSync(RadarLayoutResult)(result).nodes).toHaveLength(30)
  expect(() =>
    Schema.decodeUnknownSync(RadarLayoutInput)({
      ...input,
      nodes: [{ ...input.nodes[0]!, height: 2001 }],
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(RadarLayoutResult)({ ...result, height: Number.POSITIVE_INFINITY }),
  ).toThrow()
})

test("an aborted ELK request rejects instead of publishing obsolete layout", async () => {
  const service = layoutService(workerPath())
  const controller = new AbortController()
  controller.abort(new Error("scope changed"))
  await expect(
    service.layout(
      {
        key: "cancelled-layout",
        scopeKey: "session:old",
        groups: [{ id: "runtime", label: "Runtime", width: 80, height: 20 }],
        nodes: [{ id: "component", group: "runtime", width: 120, height: 80 }],
        edges: [],
      },
      controller.signal,
    ),
  ).rejects.toThrow("scope changed")
})

test("unchanged measured topology makes zero extra layout calls and preserves coordinates", async () => {
  const calls: RadarLayoutInput[] = []
  const coordinator = new RadarLayoutCoordinator()
  const controller = new AbortController()
  const client = {
    layout: async (input: RadarLayoutInput) => {
      calls.push(input)
      return resultFor(input)
    },
  }
  const input = layoutInput("same-geometry")
  const initial = await coordinator.layout(input, client, controller.signal)
  for (let index = 0; index < 5; index++)
    expect(await coordinator.layout({ ...input }, client, controller.signal)).toBe(initial)
  expect(initial?.nodes).toEqual(resultFor(input).nodes)
  expect(calls).toHaveLength(1)
})

test("late scope layout responses cannot overwrite the newest geometry", async () => {
  const pending = new Map<string, (value: RadarLayoutResult) => void>()
  const calls: string[] = []
  const coordinator = new RadarLayoutCoordinator()
  const client = {
    layout: (input: RadarLayoutInput) => {
      calls.push(input.key)
      return new Promise<RadarLayoutResult>((resolve) => pending.set(input.key, resolve))
    },
  }
  const oldController = new AbortController()
  const newController = new AbortController()
  const old = coordinator.layout(layoutInput("old-scope"), client, oldController.signal)
  const next = coordinator.layout(layoutInput("new-scope"), client, newController.signal)
  oldController.abort()
  pending.get("new-scope")!(resultFor(layoutInput("new-scope")))
  expect(await next).toEqual(resultFor(layoutInput("new-scope")))
  pending.get("old-scope")!(resultFor(layoutInput("old-scope")))
  expect(await old).toBeUndefined()
  expect(calls).toEqual(["old-scope", "new-scope"])
})

test("F-S14-9 an idle worker exit is reported once and the next request recovers", async () => {
  let created: Worker | undefined
  const capture: Parameters<typeof process.on<"worker">>[1] = (worker) => {
    created = worker
  }
  process.once("worker", capture)
  const service = layoutService(workerPath())
  try {
    const first = await service.layout(layoutInput("first"), new AbortController().signal)
    await created!.terminate()
    await expect(
      service.layout(layoutInput("after-exit"), new AbortController().signal),
    ).rejects.toThrow("ELK worker exited")
    const recovered = await service.layout(layoutInput("recovered"), new AbortController().signal)
    expect(recovered.workerThreadId).toBeGreaterThan(0)
    expect(recovered.workerThreadId).not.toBe(first.workerThreadId)
    await service.dispose()
    await expect(
      service.layout(layoutInput("disposed"), new AbortController().signal),
    ).rejects.toThrow("disposed")
  } finally {
    process.off("worker", capture)
  }
})
