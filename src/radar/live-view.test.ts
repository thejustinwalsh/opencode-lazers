import { expect, test } from "bun:test"
import recorded from "../../test/fixtures/panel-streams/radar-flow.json"
import { createFlowModel } from "./flow-model.ts"
import { assembleLive, type RadarLive, type StreamRow } from "./live-view.ts"
import { flowPhase, sessionActivity, sessionCallLines, sessionModel } from "./monitor-model.ts"

/**
 * Parity on a recorded fixture (`test/fixtures/panel-streams/radar-flow.json`, written by the old
 * `liveRadar` read over one worker's progress rows and, beside it, the stream rows of the same
 * steps and calls): model request, stream and response with usage, a failed step, a retried step,
 * and tool calls running, failed and finished. Flow and Monitor build the same phases and cards
 * from both.
 */
const SESSION = "ses-failed"
const NOW = 1_800_000_006_500
const oldLive: RadarLive = {
  ...(recorded.old as unknown as RadarLive),
  scope: { kind: "project" },
  observedAt: NOW,
}

function fromStreams(phasesLoading: string[] = []): RadarLive {
  const streams = recorded.streams
  return assembleLive({
    scope: recorded.scope as { kind: "project"; sessionID: string },
    projectDirectory: recorded.project,
    now: NOW,
    includeUnmanagedSessions: false,
    sessions: streams.sessions as StreamRow[],
    assignments: streams.assignments as StreamRow[],
    calls: new Map([[SESSION, streams.calls as StreamRow[]]]),
    nativeCalls: new Map([[SESSION, streams.nativeCalls as StreamRow[]]]),
    steps: new Map([[SESSION, streams.steps as StreamRow[]]]),
    phasesLoading: new Set(phasesLoading),
  })
}

/** Ids name rows of their read (hashes before, row keys now): compare everything else. */
const withoutIDs = <T extends object>(items: readonly T[]) =>
  items.map((item) => {
    const { id: _id, record: _record, ...rest } = item as T & { id?: unknown; record?: unknown }
    return rest
  })

test("parity: Flow's feed, edges, destinations and sessions equal the old read's", () => {
  const before = createFlowModel(oldLive, NOW)
  const after = createFlowModel(fromStreams(), NOW)
  expect(before.feed.length).toBeGreaterThan(0)
  expect(withoutIDs(after.feed)).toEqual(withoutIDs(before.feed))
  expect(after.edges).toEqual(before.edges)
  expect(after.destinations).toEqual(before.destinations)
  expect(after.sessions).toEqual(before.sessions)
  expect({ running: after.running, flows: after.flows, quiet: after.quiet }).toEqual({
    running: before.running,
    flows: before.flows,
    quiet: before.quiet,
  })
})

test("parity: model cards count the same requests and measured tokens", () => {
  // A card's `lastAt` also takes the session's selected route: the old read stamped that route
  // with the time of the read, the stored row with the host's own update time.
  const card = (live: RadarLive) =>
    createFlowModel(live, NOW).models.map(({ lastAt: _lastAt, ...rest }) => rest)
  const cards = card(fromStreams())
  expect(cards).toEqual(card(oldLive))
  expect(cards[0]).toMatchObject({ calls: 3, inputTokens: 2_100, outputTokens: 120 })
})

test("parity: Monitor's call lines, activity, phases and model equal the old read's", () => {
  const after = fromStreams()
  expect(withoutIDs(sessionCallLines(after, SESSION))).toEqual(
    withoutIDs(sessionCallLines(oldLive, SESSION)),
  )
  const session = (live: RadarLive) => live.sessions.find((item) => item.sessionID === SESSION)!
  expect(sessionActivity(after, session(after)).lastActivityAt).toBe(
    sessionActivity(oldLive, session(oldLive)).lastActivityAt,
  )
  expect(withoutIDs(sessionActivity(after, session(after)).lines)).toEqual(
    withoutIDs(sessionActivity(oldLive, session(oldLive)).lines),
  )
  const phases = (live: RadarLive) =>
    live.flow
      .filter((item) => item.sessionID === SESSION)
      .map((item) => ({ kind: item.kind, at: item.observedAt, ...flowPhase(item, live) }))
      .toSorted((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))
  expect(phases(after)).toEqual(phases(oldLive))
  expect(sessionModel(after, session(after))).toEqual(sessionModel(oldLive, session(oldLive)))
  const { id: _a, observedAt: _b, ...rest } = session(after)
  // The old row also carried its project id and route coverage; route ids name their read.
  const {
    id: _c,
    observedAt: _d,
    projectID: _p,
    routeCoverage: _r,
    ...was
  } = session(oldLive) as typeof rest & {
    id: string
    observedAt: number
    projectID: string
    routeCoverage: unknown
  }
  const routed = (item: typeof rest) => ({
    ...item,
    selectedRouteID: item.selectedRouteID !== null,
    configuredRouteID: item.configuredRouteID !== null,
    observedRouteID: item.observedRouteID !== null,
  })
  expect(routed(rest)).toEqual(routed(was))
})

test("a worker whose stored phases are not read yet is marked loading, never empty and final", () => {
  const live = fromStreams([SESSION])
  expect(live.sessions[0]?.phasesLoading).toBe(true)
  expect(fromStreams().sessions[0]?.phasesLoading).toBeUndefined()
})

/**
 * The same fixture's `shown` section: stream rows of an Architect, an unmanaged session and a
 * session still being read, now that every shown session's steps are stored.
 */
function shownLive(): RadarLive {
  const shown = recorded.shown
  const steps = shown.steps as Record<string, StreamRow[]>
  const read = new Map(shown.transcripts.map((row) => [row.session_id, row.read_state]))
  return assembleLive({
    scope: shown.scope as { kind: "project"; sessionID: string },
    projectDirectory: shown.project,
    now: NOW,
    includeUnmanagedSessions: true,
    sessions: shown.sessions as StreamRow[],
    assignments: [],
    calls: new Map(),
    nativeCalls: new Map(),
    steps: new Map(Object.entries(steps)),
    phasesLoading: new Set(
      shown.sessions
        .map((row) => row.session_id)
        .filter((id) => (read.get(id) ?? "not-read") === "not-read"),
    ),
  })
}

test("Architect and unmanaged sessions draw their stored model steps in Flow and Messages", () => {
  const live = shownLive()
  const model = createFlowModel(live, NOW)
  const feed = (sessionID: string) => model.feed.filter((row) => row.sessionID === sessionID)
  expect(feed("ses-arch").map((row) => [row.destName, row.detail, row.failed])).toEqual([
    ["gpt-6-sol", "request", true],
    ["gpt-6-sol", "request · 3.0k in · 90 out", false],
  ])
  expect(feed("ses-human").map((row) => row.destName)).toEqual(["kimi-k3"])
  expect(model.models.find((card) => card.id === "gpt-6-sol")).toMatchObject({
    calls: 2,
    inputTokens: 3_000,
    outputTokens: 90,
  })
  const messages = (sessionID: string) =>
    live.flow
      .filter((item) => item.sessionID === sessionID && item.kind !== "tool-phase")
      .map((item) => flowPhase(item, live).label)
  expect(messages("ses-arch")).toEqual([
    "Model request",
    "Streaming response",
    "Response received",
    "Model request",
    "Streaming response",
    "Model request failed",
  ])
  expect(messages("ses-human")).toEqual([
    "Model request",
    "Streaming response",
    "Response received",
  ])
})

test("a session whose stored steps are still being read is marked loading; read ones are final", () => {
  const live = shownLive()
  const loading = (id: string) => live.sessions.find((s) => s.sessionID === id)?.phasesLoading
  expect([loading("ses-arch"), loading("ses-human"), loading("ses-reading")]).toEqual([
    undefined,
    undefined,
    true,
  ])
})
