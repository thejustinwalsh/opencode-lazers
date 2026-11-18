import { expect, test } from "bun:test"
import type { LiveRadarResponse } from "../observability/contract.ts"
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

function live(
  sessions: LiveSession[],
  workload?: LiveRadarResponse["workload"],
): LiveRadarResponse {
  return {
    sessions,
    scheduler: { status: "scheduled", participants: 2 },
    ...(workload ? { workload } : {}),
  } as unknown as LiveRadarResponse
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

test("a failed item turns its path red and omitted data omits nodes, never 'unknown'", () => {
  const map = createRadarMap(live([session("a")], { queued: 0, needsYou: 0, failed: 2 }), 2_000)
  // No Architect in the read: groups hang from You.
  expect(map.nodeByID.get("group:runtime")?.parent).toBe("you")
  expect(map.nodeByID.get("you")?.tone).toBe("failed")
  const text = JSON.stringify(map.nodes)
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
