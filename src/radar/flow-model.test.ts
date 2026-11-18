import { expect, test } from "bun:test"
import type { LiveRadarResponse } from "../observability/contract.ts"
import { layoutFlow } from "./flow-layout.ts"
import {
  FEED_CAP,
  abbreviateRole,
  createFlowModel,
  edgeHeat,
  edgeOpacity,
  edgeWidth,
  feedWhen,
  filterFeed,
  flowRelated,
  quietSentences,
  toolDestination,
} from "./flow-model.ts"
import type { LiveCall, LiveFlow, LiveSession } from "./monitor-model.ts"

const NOW = 1_000_000
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
      taskReference: sessionID.toUpperCase(),
    },
    selectedRouteID: null,
    configuredRouteID: null,
    observedRouteID: null,
    routeCoverage: { selected: "unavailable", configured: "unavailable", observed: "not-observed" },
    updatedAt: NOW - 29 * 60_000,
    observedAt: NOW,
    ...change,
  } as LiveSession
}

function call(sessionID: string, id: string, change: Partial<LiveCall>): LiveCall {
  return {
    id,
    sessionID,
    attemptID: TASK,
    messageID: "m",
    callID: id,
    tool: "read",
    status: "succeeded",
    execution: "executed",
    inputAt: NOW - 10_000,
    calledAt: NOW - 10_000,
    completedAt: NOW - 9_000,
    observedAt: NOW - 9_000,
    sourceProgressSequence: 1,
    sourceEventID: null,
    sourceEventType: null,
    result: null,
    error: null,
    payloadAvailable: false,
    ...change,
  } as LiveCall
}

function live(parts: {
  sessions: LiveSession[]
  calls?: LiveCall[]
  flow?: LiveFlow[]
  routes?: LiveRadarResponse["routes"]
  workload?: LiveRadarResponse["workload"]
}): LiveRadarResponse {
  return {
    sessions: parts.sessions,
    calls: parts.calls ?? [],
    flow: parts.flow ?? [],
    routes: parts.routes ?? [],
    scheduler: { status: "scheduled", participants: 1 },
    ...(parts.workload ? { workload: parts.workload } : {}),
  } as unknown as LiveRadarResponse
}

const architect = session("arch", {
  isCurrentArchitect: true,
  state: "idle",
  assignment: null,
  agent: "architect",
})
const route = (id: string, modelID: string, variant: string | null = null) => ({
  id,
  providerID: "openai",
  modelID,
  variant,
  source: "step-event" as const,
  sessionID: "lz-1",
  attemptID: null,
  messageID: null,
  eventID: null,
  observedAt: NOW - 5_000,
})
const request = (id: string, sessionID: string, messageID: string, routeID: string, at: number) =>
  ({
    id,
    kind: "model-request",
    source: "native-event",
    sessionID,
    messageID,
    routeID,
    status: "request-started",
    startedAt: at,
    observedAt: at,
  }) as unknown as LiveFlow
const response = (
  id: string,
  sessionID: string,
  messageID: string,
  routeID: string,
  at: number,
  usage?: { input: number | null; output: number | null },
) =>
  ({
    id,
    kind: "model-response",
    source: "native-event",
    sessionID,
    messageID,
    routeID,
    status: "request-ended",
    startedAt: null,
    observedAt: at,
    ...(usage ? { usage } : {}),
  }) as unknown as LiveFlow

const busy = () =>
  live({
    sessions: [architect, session("lz-1"), session("lz-2")],
    calls: [
      call("lz-1", "c1", {
        tool: "bash",
        status: "running",
        completedAt: null,
        inputAt: NOW - 3_000,
      }),
      call("lz-1", "c2", {
        tool: "edit",
        fileTargets: { coverage: "observed", operation: "edit", paths: ["src/a.ts"] },
      }),
      call("lz-1", "c3", { tool: "grep", completedAt: NOW - 70_000, inputAt: NOW - 71_000 }),
      call("lz-2", "c4", {
        tool: "bash",
        status: "failed",
        error: "exit 1",
        inputAt: NOW - 30_000,
        completedAt: NOW - 29_000,
      }),
      call("lz-2", "old", { tool: "read", completedAt: NOW - 400_000, inputAt: NOW - 401_000 }),
    ],
    routes: [route("r1", "gpt-6-luna", "max"), route("r2", "kimi-k3.1-pro")],
    flow: [
      request("q1", "lz-1", "m1", "r1", NOW - 20_000),
      response("p1", "lz-1", "m1", "r1", NOW - 18_000, { input: 41_000, output: 620 }),
      request("q2", "lz-2", "m2", "r1", NOW - 2_000),
    ],
    workload: { queued: 6, needsYou: 0, failed: 0 },
  })

test("destinations come from observed activity only and group by kind", () => {
  const model = createFlowModel(busy(), NOW)
  expect(model.destinations.map((dest) => [dest.kind, dest.name, dest.count])).toEqual([
    ["model", "gpt-6-luna", 2],
    ["local", "Shell", 2],
    ["local", "Files", 1],
    ["service", "Search", 1],
  ])
  // The 400 s old read is outside the window, so no extra Files flow; nothing unused is listed.
  expect(model.destinations.some((dest) => dest.name === "Checks")).toBe(false)
  expect(model.flows).toBe(model.feed.length)
  expect(model.quiet).toBe(false)
})

test("tools map to destinations, verifiers to Checks, questions to You", () => {
  expect(toolDestination("bash", false, false).name).toBe("Shell")
  expect(toolDestination("bash", true, false).name).toBe("Checks")
  expect(toolDestination("check", false, false).name).toBe("Checks")
  expect(toolDestination("webfetch", false, false).name).toBe("Search")
  expect(toolDestination("question", false, false).name).toBe("You")
  expect(toolDestination("git_worktree", false, false).name).toBe("Git · worktrees")
  expect(toolDestination("mystery", false, true).name).toBe("Files")
  expect(toolDestination("mystery", false, false).name).toBe("Other tools")
})

test("the feed is newest first with running calls on top, windowed, capped and honest", () => {
  const model = createFlowModel(busy(), NOW)
  expect(model.feed.filter((row) => row.live).map((row) => row.id)).toEqual(["q2", "c1"])
  expect(model.feed[0]).toMatchObject({ live: true, destName: "gpt-6-luna", sessionID: "lz-2" })
  const detail = Object.fromEntries(model.feed.map((row) => [row.id, row.detail]))
  expect(detail.c2).toBe("edit src/a.ts")
  expect(detail.c4).toBe("exit 1")
  expect(model.feed.find((row) => row.id === "c4")?.failed).toBe(true)
  expect(model.feed.some((row) => row.id === "old")).toBe(false)
  expect(model.feed.find((row) => row.id === "q1")?.detail).toBe("request · 41k in · 620 out")
  expect(model.feed.find((row) => row.id === "q2")?.live).toBe(true)
  const text = JSON.stringify(model)
  expect(text).not.toMatch(/nknown|navailable/)

  const many = live({
    sessions: [session("lz-1")],
    calls: Array.from({ length: FEED_CAP + 40 }, (_, index) =>
      call("lz-1", `x${index}`, { completedAt: NOW - 1_000 - index, inputAt: NOW - 2_000 }),
    ),
  })
  expect(createFlowModel(many, NOW).feed.length).toBe(FEED_CAP)
  expect(feedWhen(model.feed[0]!, NOW)).toBe("live")
  expect(feedWhen({ ...model.feed[1]!, live: false, at: NOW - 24_000 }, NOW)).toBe("24s")
  expect(feedWhen({ ...model.feed[1]!, live: false, at: NOW - 61_000 }, NOW)).toBe("1m")
})

test("edge heat is 1 while running then decays to 0 over 120 s; width and opacity follow", () => {
  expect(edgeHeat(true, NOW - 500_000, NOW)).toBe(1)
  expect(edgeHeat(false, NOW - 60_000, NOW)).toBeCloseTo(0.5)
  expect(edgeHeat(false, NOW - 120_000, NOW)).toBe(0)
  expect(edgeHeat(false, NOW - 999_999, NOW)).toBe(0)
  expect(edgeWidth(1)).toBeCloseTo(1.18)
  expect(edgeWidth(50)).toBeCloseTo(0.9 + 9 * 0.28)
  expect(edgeOpacity(0)).toBeCloseTo(0.18)
  expect(edgeOpacity(1)).toBeCloseTo(0.8)
  const model = createFlowModel(busy(), NOW)
  const shell = model.edges.find((edge) => edge.sessionID === "lz-1" && edge.destID === "shell")!
  expect(shell).toMatchObject({ running: true, heat: 1 })
  const search = model.edges.find((edge) => edge.destID === "search")!
  expect(search.heat).toBeCloseTo(1 - 70_000 / 120_000)
})

test("selection keeps connected sessions, destinations and feed rows; the rest dims", () => {
  const model = createFlowModel(busy(), NOW)
  const bySession = flowRelated(model, { kind: "session", id: "lz-2" })!
  expect([...bySession.destinations].toSorted()).toEqual(["model:gpt-6-luna", "shell"])
  expect(bySession.sessions.has("lz-1")).toBe(false)
  const byDest = flowRelated(model, { kind: "destination", id: "shell" })!
  expect([...byDest.sessions].toSorted()).toEqual(["lz-1", "lz-2"])
  expect(flowRelated(model, null)).toBeUndefined()
  expect(
    filterFeed(model, { kind: "session", id: "lz-2" }).every((row) => row.sessionID === "lz-2"),
  ).toBe(true)
  expect(filterFeed(model, { kind: "destination", id: "files" }).map((row) => row.id)).toEqual([
    "c2",
  ])
})

test("model cards list active models first and omit figures the read does not carry", () => {
  const model = createFlowModel(busy(), NOW)
  const luna = model.models.find((card) => card.name === "gpt-6-luna")!
  expect(luna).toMatchObject({
    active: true,
    calls: 2,
    inputTokens: 41_000,
    outputTokens: 620,
    effort: "max",
  })
  expect(luna.rate).toBe(Math.round(41_620 / 2))
  expect(luna.shares.map((share) => share.calls).toSorted()).toEqual([1, 1])
  const kimi = model.models.find((card) => card.name === "kimi-k3.1-pro")!
  expect(kimi).toMatchObject({
    active: false,
    calls: 0,
    inputTokens: null,
    outputTokens: null,
    rate: null,
  })
  expect(model.models[0]!.name).toBe("gpt-6-luna")
})

test("a quiet read says so, with clauses only where data exists", () => {
  const response = live({ sessions: [architect], workload: { queued: 6, needsYou: 0, failed: 0 } })
  const model = createFlowModel(response, NOW)
  expect(model.quiet).toBe(true)
  expect(model.destinations).toEqual([])
  expect(quietSentences(response)).toEqual({
    line: "No session has called a model or a tool in the last two minutes.",
    state: "Architect is idle · 6 tasks are queued.",
  })
  expect(quietSentences(live({ sessions: [session("lz-1")] })).state).toBe("")
})

test("sessions keep the Monitor grouping: Architect first, workers indented under it", () => {
  const model = createFlowModel(busy(), NOW)
  expect(model.sessions.map((item) => [item.sessionID, item.depth, item.parent])).toEqual([
    ["arch", 0, null],
    ["lz-1", 1, "arch"],
    ["lz-2", 1, "arch"],
  ])
  expect(model.sessions[0]!.doing).toBe("idle 29m")
  expect(model.sessions[1]!.doing).toBe("▸ bash")
  expect(model.sessions[2]!.doingFailed).toBe(true)
})

test("layout fits 360 and 500 px with no node beyond the width; narrow abbreviates", () => {
  const model = createFlowModel(busy(), NOW)
  for (const width of [360, 500]) {
    const layout = layoutFlow(model, width)
    expect(layout.width).toBe(width)
    expect(layout.narrow).toBe(width <= 420)
    for (const session of layout.sessions)
      expect(session.x + layout.frame.width).toBeLessThan(width)
    for (const dest of layout.destinations) expect(dest.x).toBeLessThanOrEqual(width)
    for (const edge of layout.edges) {
      expect(edge.x0).toBeLessThan(edge.x1)
      expect(edge.x1).toBeLessThanOrEqual(width)
    }
    expect(layout.frame.x + layout.frame.width).toBeLessThanOrEqual(width)
  }
  expect(abbreviateRole("Implementer")).toBe("Impl.")
  expect(abbreviateRole("Verifier")).toBe("Veri.")
  expect(abbreviateRole("Architect")).toBe("Architect")
})

test("the mockup fixture yields every destination, the failed worker and the waiting worker", async () => {
  const { mockupFlowLive } = await import("../../test/radar/flow-fixture.ts")
  const model = createFlowModel(mockupFlowLive(NOW), NOW)
  expect(model.destinations.map((dest) => dest.name).toSorted()).toEqual(
    [
      "Checks",
      "Files",
      "Git · worktrees",
      "Search",
      "Shell",
      "You",
      "gpt-6-luna",
      "gpt-6.1-sol",
      "kimi-k3.1-pro",
      "qwen3.8-flash",
    ].toSorted(),
  )
  const byName = Object.fromEntries(model.sessions.map((item) => [item.ref || item.role, item]))
  expect(byName["LZ-118"]!.doingFailed).toBe(true)
  expect(byName["LZ-135"]!.waiting).toBe(true)
  expect(byName["Architect"]!.doing).toBe("idle 29m")
  expect(model.models.map((card) => card.name)[0]).toBe("gpt-6-luna")
})
