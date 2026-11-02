import { expect, test } from "bun:test"
import { createRoot, createSignal, mapArray } from "solid-js"
import { fileURLToPath } from "node:url"
import { ObservationChangeTracker } from "../observability/changes.ts"
import type { RadarResponse } from "../observability/contract.ts"
import { createRadarLayoutService } from "./layout-main.ts"
import { measureRadarMap } from "./map-layout.ts"
import { createRadarMapModel } from "./map-model.ts"
import type { RadarMapModel } from "./map-model.ts"
import {
  createRadarOverview,
  radarOverviewConnectionForID,
  radarOverviewConnectionIDs,
} from "./map-overview.ts"
import { RadarLayoutCoordinator } from "./layout-state.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

function with35Sessions(radar: RadarResponse): RadarResponse {
  const base = radar.sessions[0]
  const task = radar.tasks[0]
  const planID = task?.planID ?? radar.plans[0]?.id
  if (!base || !task || !planID) throw new Error("Radar fixture needs a scoped session and task")

  const sessions: RadarResponse["sessions"] = Array.from({ length: 35 }, (_, index) => {
    const sessionID =
      index === 0 ? "ses-current-architect" : `ses-worker-${String(index).padStart(2, "0")}`
    const isArchitect = index === 0
    const hasAttempt = index >= 1 && index <= 3
    return {
      ...base,
      id: `session:${sessionID}`,
      sessionID,
      parentSessionID: null,
      classification: "managed",
      associations: hasAttempt ? ["attempt"] : [],
      availability: "available",
      freshness: "current",
      agent: isArchitect ? "architect" : "worker",
      state: index === 1 || index === 2 ? "busy" : "idle",
      currentRouteID: `route:${index}`,
      configuredRouteIDs: [],
      planIDs: isArchitect || hasAttempt ? [planID] : [],
      taskIDs: isArchitect || hasAttempt ? [task.id] : [],
      attemptIDs: hasAttempt ? [`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`] : [],
      updatedAt: 10_000 - index,
      observedAt: 10_000 - index,
    }
  })
  const routes: RadarResponse["routes"] = sessions.map((session, index) => ({
    id: `route:${index}`,
    providerID: "openai",
    modelID: `gpt-worker-${index}`,
    variant: "high",
    source: index === 0 ? "session-selection" : "attempt-policy",
    sessionID: session.sessionID,
    attemptID: null,
    messageID: null,
    eventID: null,
    observedAt: 10_000 - index,
  }))
  const attempts: RadarResponse["attempts"] = sessions.slice(1, 4).map((session, offset) => ({
    id: `00000000-0000-4000-8000-${String(offset + 1).padStart(12, "0")}`,
    planID,
    taskID: task.id,
    sessionID: session.sessionID,
    number: 1,
    state: offset === 2 ? "succeeded" : "running",
    startedAt: offset === 2 ? 20_000 : 1000 - offset,
    configuredRouteID: `route:${offset + 1}`,
  }))
  const assignment = radar.edges.find((edge) => edge.kind === "assignment")
  if (!assignment) throw new Error("Radar fixture needs an observed assignment record")
  const assignments: RadarResponse["edges"] = sessions.slice(1, 4).map((session, offset) => ({
    ...assignment,
    id: `assignment:overview-${offset}`,
    from: `task:${task.id}`,
    to: session.id,
    planID,
    taskID: task.id,
    attemptID: attempts[offset]!.id,
    agentID: "worker",
  }))
  const typedFlows: RadarResponse["edges"] = [
    {
      ...assignment,
      id: "prompt:overview-worker-01",
      kind: "prompt",
      from: "component:runner-runtime",
      to: sessions[1]!.id,
      taskID: null,
      attemptID: null,
      evidence: [],
    },
    {
      ...assignment,
      id: "outcome:overview-worker-02",
      kind: "outcome",
      from: sessions[2]!.id,
      to: "component:runner-runtime",
      taskID: null,
      attemptID: null,
      evidence: [],
    },
  ]
  return {
    ...radar,
    tasks: radar.tasks.map((item) => ({ ...item, state: "accepted" as const })),
    sessions,
    routes,
    attempts,
    edges: [...radar.edges, ...assignments, ...typedFlows],
  }
}

test("35-session overview stays compact at 330/450px and discloses every scoped identity", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(31)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "project" as const, sessionID: "ses-failed" }
    const [base, snapshot] = await Promise.all([
      reads.radar(
        { scope, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      ),
      Promise.resolve(reads.snapshot(scope, tracker)),
    ])
    const radar = with35Sessions(base)
    const model = createRadarMapModel(radar, snapshot)
    const overview = createRadarOverview(model, "ses-current-architect")
    const runtime = model.nodes.filter((node) => node.kind === "component")
    const sessionNodes = model.nodes.filter((node) => node.kind === "session")
    const expectedIDs = [
      "component:runner-runtime",
      "session:ses-current-architect",
      `task:${base.tasks[0]?.id}`,
      "session:ses-worker-01",
      "session:ses-worker-02",
    ]

    expect(overview.currentArchitectID).toBe("session:ses-current-architect")
    expect(overview.nodes.map((node) => node.id)).toEqual(expectedIDs)
    expect(overview.activeWorkerCount).toBe(2)
    expect(overview.visibleWorkerCount).toBe(2)
    expect(overview.workerSessions.map((node) => node.id)).toEqual([
      "session:ses-worker-01",
      "session:ses-worker-02",
    ])
    expect(overview.edges.filter((edge) => edge.kind === "assignment")).toHaveLength(2)
    expect(overview.edges.map((edge) => edge.kind)).toContain("prompt")
    expect(overview.edges.map((edge) => edge.kind)).toContain("outcome")
    expect(
      overview.edges.every(
        (edge) => expectedIDs.includes(edge.from) && expectedIDs.includes(edge.to),
      ),
    ).toBe(true)
    expect(overview.graphEdges).toEqual([])
    expect(overview.nodes.find((node) => node.id === "session:ses-current-architect")?.label).toBe(
      "Current Architect",
    )
    const worker = overview.nodes.find((node) => node.id === "session:ses-worker-01")!
    expect(worker.subtitle).toContain("openai/gpt-worker-1")
    expect(worker.subtitle).toContain("effort high")
    expect(worker.subtitle).toContain("attempt-policy")
    expect(worker.status).toContain("Task:")

    const counts = Object.fromEntries(overview.groups.map((group) => [group.id, group.count]))
    expect(counts.runtime).toBe(runtime.length)
    expect(counts.sessions).toBe(35)
    expect(counts.work).toBe(
      model.nodes.filter((node) => node.kind === "plan" || node.kind === "task").length,
    )
    expect(counts.routes).toBe(model.nodes.filter((node) => node.kind === "route").length)
    expect(overview.groups.find((group) => group.id === "routes")?.sourceCount).toBe(
      radar.routes.length,
    )
    expect(counts.tools).toBe(model.nodes.filter((node) => node.kind === "tool").length)
    expect(counts.relationships).toBe(model.edges.length)
    const disclosedIDs = overview.groups.flatMap((group) => group.entries.map((entry) => entry.id))
    expect(new Set(disclosedIDs).size).toBe(model.nodes.length + model.edges.length)
    expect([...disclosedIDs].sort()).toEqual(
      [...model.nodes.map((node) => node.id), ...model.edges.map((edge) => edge.id)].sort(),
    )
    const disclosedNodeSourceIDs = overview.groups
      .filter((group) => group.id !== "relationships")
      .flatMap((group) => group.entries.flatMap((entry) => entry.sourceIDs ?? []))
    const originalNodeIDs = model.nodes.flatMap((node) => {
      if (node.record.kind === "session") return [node.record.value.id, node.record.value.sessionID]
      if (node.record.kind === "route") return node.record.value.map((route) => route.id)
      return [node.record.value.id]
    })
    expect(originalNodeIDs.every((id) => disclosedNodeSourceIDs.includes(id))).toBe(true)
    const sourceIDs = overview.groups
      .find((group) => group.id === "relationships")!
      .entries.flatMap((entry) => entry.sourceIDs ?? [])
    const originalIDs = model.edges.flatMap((edge) => [
      ...edge.records.map((record) => record.id),
      ...edge.routeRecords.map((record) => record.id),
    ])
    expect(new Set(sourceIDs)).toEqual(
      new Set(
        model.edges.flatMap((edge) => [
          edge.id,
          ...edge.records.map((record) => record.id),
          ...edge.routeRecords.map((record) => record.id),
        ]),
      ),
    )
    expect(originalIDs.every((id) => sourceIDs.includes(id))).toBe(true)
    expect(sessionNodes.length).toBe(35)
    const visibleSessionIDs = new Set([
      ...overview.nodes.filter((node) => node.record.kind === "session").map((node) => node.id),
      ...overview.workerSessions
        .filter((node) => node.record.kind === "session" && node.record.value.state === "busy")
        .map((node) => node.id),
    ])
    expect(counts.sessions! - visibleSessionIDs.size).toBe(32)

    const measured = measureRadarMap(
      overviewModel(model, overview),
      "project:current",
      "host-12px",
      (text) => [...text].length * 7,
      "DOWN",
    )
    expect(measured.input.direction).toBe("DOWN")
    expect(measured.input.nodes).toHaveLength(5)
    expect(measured.input.nodes.length).toBeLessThan(model.nodes.length / 2)
    expect(measured.input.nodes.every((node) => node.width === 242)).toBe(true)
    const service = createRadarLayoutService(
      fileURLToPath(new URL("./elk-worker.cjs", import.meta.url)),
    )
    const result = await service.layout(measured.input, new AbortController().signal)
    for (const viewportWidth of [330, 450])
      expect(result.width).toBeLessThanOrEqual(viewportWidth - 20)
    expect(result.nodes.map((node) => node.id).sort()).toEqual([...expectedIDs].sort())
    expect(result.height).toBeLessThan(1000)

    const noCurrentEvidence = createRadarOverview(model, "ses-not-in-this-observation")
    expect(noCurrentEvidence.currentArchitectID).toBeNull()
  } finally {
    fixture.close()
  }
})

test("status-only session updates keep the compact layout request and coordinates stable", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(32)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "project" as const, sessionID: "ses-failed" }
    const radar = with35Sessions(
      await reads.radar(
        { scope, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      ),
    )
    const firstModel = createRadarMapModel(radar)
    const firstOverview = createRadarOverview(firstModel, "ses-current-architect")
    const changed = {
      ...radar,
      sessions: radar.sessions.map((session) => ({
        ...session,
        state: ["ses-worker-01", "ses-worker-02"].includes(session.sessionID)
          ? ("idle" as const)
          : session.state,
        updatedAt: (session.updatedAt ?? 0) + 1,
      })),
    }
    const nextModel = createRadarMapModel(changed)
    const nextOverview = createRadarOverview(nextModel, "ses-current-architect")
    const measure = (model: RadarMapModel, overview: ReturnType<typeof createRadarOverview>) =>
      measureRadarMap(
        overviewModel(model, overview),
        "project:current",
        "host-12px",
        (text) => [...text].length * 7,
        "DOWN",
      )
    const first = measure(firstModel, firstOverview)
    const next = measure(nextModel, nextOverview)
    expect(next.input.key).toBe(first.input.key)
    expect(next.input.nodes).toEqual(first.input.nodes)
    expect(next.input.edges).toEqual(first.input.edges)

    const calls: string[] = []
    const service = {
      layout: async (input: typeof first.input) => {
        calls.push(input.key)
        return {
          key: input.key,
          width: 320,
          height: 480,
          groups: input.groups.map((group, index) => ({
            id: group.id,
            x: 0,
            y: index * 160,
            width: 280,
            height: 140,
          })),
          nodes: input.nodes.map((node, index) => ({
            id: node.id,
            x: 16,
            y: index * 130,
            width: node.width,
            height: node.height,
          })),
          edges: [],
          elapsedMs: 1,
          workerThreadId: 1,
        }
      },
    }
    const coordinator = new RadarLayoutCoordinator()
    const controller = new AbortController()
    const positioned = await coordinator.layout(first.input, service, controller.signal)
    const unchanged = await coordinator.layout(next.input, service, controller.signal)
    expect(unchanged).toBe(positioned)
    expect(unchanged?.nodes).toEqual(positioned?.nodes)
    expect(calls).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("recorded connection keys retain a focused row and resolve refreshed edge records", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(33)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "project" as const, sessionID: "ses-failed" }
    const base = await reads.radar(
      { scope, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const radar = with35Sessions(base)
    const before = createRadarOverview(createRadarMapModel(radar), "ses-current-architect")
    const focusedID = before.edges.find((edge) => edge.kind === "prompt")?.id
    expect(focusedID).toBeDefined()
    const sourceID = radar.edges.find((edge) => edge.id === "prompt:overview-worker-01")!.id
    const refreshedRadar = {
      ...radar,
      edges: radar.edges.map((edge) =>
        edge.id === sourceID
          ? { ...edge, status: "Refreshed prompt evidence", observedAt: 30_000 }
          : edge,
      ),
    }
    const after = createRadarOverview(createRadarMapModel(refreshedRadar), "ses-current-architect")
    createRoot((dispose) => {
      const [connectionIDs, setConnectionIDs] = createSignal(
        radarOverviewConnectionIDs(before.edges),
      )
      const [currentEdges, setCurrentEdges] = createSignal(before.edges)
      // Solid's <For> uses mapArray; stable IDs preserve row/DOM identity.
      const rows = mapArray(connectionIDs, (id) => ({
        id,
        edge: () => radarOverviewConnectionForID(currentEdges(), id),
      }))
      const focusedRow = rows().find((row) => row.id === focusedID)
      expect(focusedRow).toBeDefined()

      setConnectionIDs(radarOverviewConnectionIDs(after.edges))
      setCurrentEdges(after.edges)

      expect(rows().find((row) => row.id === focusedID)).toBe(focusedRow)
      expect(focusedRow!.edge()).not.toBe(radarOverviewConnectionForID(before.edges, focusedID!))
      expect(focusedRow!.edge()?.status).toContain("Refreshed prompt evidence")
      dispose()
    })
  } finally {
    fixture.close()
  }
})

function overviewModel(model: RadarMapModel, overview: ReturnType<typeof createRadarOverview>) {
  return {
    ...model,
    nodes: overview.nodes,
    edges: overview.graphEdges,
    nodeByID: new Map(overview.nodes.map((node) => [node.id, node])),
    edgeByID: new Map(overview.graphEdges.map((edge) => [edge.id, edge])),
  }
}
