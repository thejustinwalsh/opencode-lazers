import { expect, test } from "bun:test"
import type { RadarLive } from "./live-view.ts"
import { layoutMap } from "./map-layout.ts"
import { createRadarMap, mapFacts, relatedNodes, MAP_ITEMS_PER_GROUP } from "./map-model.ts"
import type { LiveSession } from "./monitor-model.ts"

const TASK = "5f0c2a1e-7b3d-4c8e-9a1f-0d2b3c4e5f60"

function session(sessionID: string, change: Partial<LiveSession> = {}): LiveSession {
  return {
    id: `session:${sessionID}`,
    sessionID,
    projectID: "project",
    classification: "managed",
    isViewSession: false,
    isCurrentArchitect: null,
    availability: "available",
    freshness: "current",
    agent: "lazers-implementor",
    state: "busy",
    assignment: {
      planID: TASK,
      taskID: TASK,
      attemptID: TASK,
      state: "running",
      startedAt: 1_000,
      taskReference: `LZ-${sessionID.length}${sessionID}`,
    },
    selectedRouteID: null,
    configuredRouteID: null,
    observedRouteID: null,
    routeCoverage: { selected: "unavailable", configured: "unavailable", observed: "not-observed" },
    updatedAt: 1_000,
    observedAt: 1_000,
    ...change,
  } as LiveSession
}

function live(sessions: LiveSession[], workload?: RadarLive["workload"]): RadarLive {
  return {
    sessions,
    scope: { kind: "project" },
    scheduler: { status: "scheduled", participants: 2 },
    ...(workload ? { workload } : {}),
  } as unknown as RadarLive
}

const architect = session("arch", {
  isCurrentArchitect: true,
  state: "idle",
  assignment: null,
  updatedAt: 1_000,
})

test("the tree runs you, Architect, groups, then concrete workers", () => {
  const map = createRadarMap(
    live(
      [
        architect,
        session("a"),
        session("b", { assignment: { ...session("b").assignment!, state: "verifying" } }),
      ],
      { queued: 6, needsYou: 1, failed: 1 },
    ),
    1_000 + 29 * 60_000,
  )
  expect(map.nodes.map((node) => node.id)).toEqual([
    "you",
    "architect",
    "group:runtime",
    "session:a",
    "group:checks",
    "session:b",
    "group:queue",
    "item:needs-you",
    "item:failed",
  ])
  expect(map.nodeByID.get("architect")?.sub).toBe("idle 29m")
  expect(map.nodeByID.get("group:runtime")?.sub).toBe("1 running")
  expect(map.nodeByID.get("group:queue")?.sub).toBe("6 queued")
  expect(map.nodeByID.get("item:failed")?.tone).toBe("failed")
  expect(map.nodeByID.get("session:a")?.parent).toBe("group:runtime")
})

test("running work colours the path above it; nothing else is active", () => {
  const map = createRadarMap(live([architect, session("a")]), 2_000)
  const tone = (id: string) => map.nodeByID.get(id)?.tone
  expect(["you", "architect", "group:runtime", "session:a"].map(tone)).toEqual([
    "active",
    "active",
    "active",
    "active",
  ])
  expect(map.edges.every((edge) => edge.tone === "active")).toBe(true)
  const idle = createRadarMap(live([architect]), 2_000)
  expect(idle.nodes.map((node) => node.id)).toEqual(["you", "architect"])
  expect(idle.edges.every((edge) => edge.tone === "weak")).toBe(true)
})

test("failed and needs-you tones stay on their own node and edge; omitted data omits nodes", () => {
  const map = createRadarMap(
    live([architect, session("a")], { queued: 3, needsYou: 1, failed: 1 }),
    2_000,
  )
  const tone = (id: string) => map.nodeByID.get(id)?.tone
  expect(tone("item:failed")).toBe("failed")
  expect(tone("item:needs-you")).toBe("attention")
  expect(["you", "architect", "group:queue"].map(tone)).toEqual(["active", "active", "weak"])
  const edgeTone = (to: string) => map.edges.find((edge) => edge.to === to)?.tone
  expect(edgeTone("item:failed")).toBe("failed")
  expect(edgeTone("item:needs-you")).toBe("attention")
  expect(edgeTone("group:queue")).toBe("weak")
  expect(edgeTone("group:runtime")).toBe("active")
  expect(map.edges.filter((edge) => edge.tone === "failed").length).toBe(1)
  const lone = createRadarMap(live([session("a")], { queued: 0, needsYou: 0, failed: 2 }), 2_000)
  // No Architect in the read: groups hang from You.
  expect(lone.nodeByID.get("group:runtime")?.parent).toBe("you")
  const text = JSON.stringify(map.nodes.concat(lone.nodes))
  expect(text).not.toMatch(/nknown|navailable|undefined/)
  expect(createRadarMap(live([]), 1).nodes.map((node) => node.id)).toEqual(["you"])
})

test("items beyond the cap collapse into +N more", () => {
  const sessions = Array.from({ length: MAP_ITEMS_PER_GROUP + 3 }, (_, index) =>
    session(`w${index}`),
  )
  const map = createRadarMap(live([architect, ...sessions]), 2_000)
  expect(map.nodes.filter((node) => node.kind === "session").length).toBe(MAP_ITEMS_PER_GROUP)
  expect(map.nodeByID.get("more:group:runtime")?.title).toBe("+3 more")
})

test("selection keeps ancestors and descendants; the rest dims", () => {
  const map = createRadarMap(
    live([
      architect,
      session("a"),
      session("b", { assignment: { ...session("b").assignment!, state: "verifying" } }),
    ]),
    2_000,
  )
  const related = relatedNodes(map, "session:a")!
  expect([...related].toSorted()).toEqual(
    ["architect", "group:runtime", "session:a", "you"].toSorted(),
  )
  expect(related.has("session:b")).toBe(false)
  expect(relatedNodes(map, null)).toBeUndefined()
})

test("system nodes list only recorded facts", () => {
  const response = live([architect, session("a")], { queued: 2, needsYou: 0, failed: 0 })
  const map = createRadarMap(response, 2_000)
  expect(mapFacts(response, map.nodeByID.get("group:runtime")!)).toEqual([
    { label: "Scheduler", value: "scheduled" },
    { label: "Participants", value: "2" },
  ])
  expect(mapFacts(response, map.nodeByID.get("group:queue")!)).toEqual([
    { label: "Queued", value: "2" },
  ])
})

test("the layout fills the panel width with no horizontal overflow at 360 and 500", () => {
  const map = createRadarMap(
    live([architect, session("a"), session("b")], { queued: 1, needsYou: 0, failed: 1 }),
    2_000,
  )
  for (const width of [360, 500]) {
    const layout = layoutMap(map, width)
    expect(layout.width).toBe(width)
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(width)
    }
    expect(layout.edges.length).toBe(map.edges.length)
  }
})

test("Map lists only the sessions the shared idle filter shows", () => {
  const response = live([architect, session("a"), session("b")], {
    queued: 2,
    needsYou: 0,
    failed: 0,
  })
  const map = createRadarMap(response, 2_000, new Set(["arch", "a"]))
  expect(map.nodes.filter((node) => node.kind === "session").map((node) => node.id)).toEqual([
    "session:a",
  ])
  // Group counts come from what is shown here; the queue count comes from the workload.
  expect(map.nodeByID.get("group:queue")?.sub).toBe("2 queued")
  expect(createRadarMap(response, 2_000, new Set()).nodes.map((node) => node.id)).toEqual([
    "you",
    "group:queue",
  ])
})

test("a running Architect is blue and so is the edge from You", () => {
  const busyArchitect = { ...architect, state: "busy" as const }
  const map = createRadarMap(live([busyArchitect]), 2_000)
  expect(map.nodeByID.get("architect")).toMatchObject({ tone: "active", running: true })
  expect(map.edges.find((edge) => edge.to === "architect")?.tone).toBe("active")
  expect(map.nodeByID.get("you")?.tone).toBe("active")
})

test("workers are siblings on a rail with a tick each, not a chain", () => {
  const map = createRadarMap(live([architect, session("a"), session("b"), session("c")]), 2_000)
  const layout = layoutMap(map, 500)
  const items = layout.nodes.filter((node) => node.kind === "session")
  const group = layout.nodes.find((node) => node.id === "group:runtime")!
  // Items sit indented under the group, one per row, all joined to the same vertical rail.
  expect(items.every((item) => item.x > group.x)).toBe(true)
  const rail = (d: string) => d.match(/^M([\d.]+) /)?.[1]
  const ticks = layout.edges.filter((edge) => edge.from === "group:runtime")
  expect(new Set(ticks.map((edge) => rail(edge.d))).size).toBe(1)
  for (const edge of ticks) expect(edge.d).toMatch(/V\d+H[\d.]+$/)
})
