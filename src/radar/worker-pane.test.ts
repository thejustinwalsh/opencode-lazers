import { expect, test } from "bun:test"
import { monitorSegments } from "./monitor-model.ts"
import type { ActivityLine, LiveSession } from "./monitor-model.ts"
import { createRadarMap } from "./map-model.ts"
import {
  callTarget,
  idleText,
  lastCall,
  recentCalls,
  startedText,
  toolName,
  workerSignals,
  workerState,
  workerStats,
} from "./worker-pane.ts"
import type { WorkerAttempt } from "./worker-pane.ts"
import { isHeldWorker, taskRowFor } from "./worker-hold.ts"

const taskID = "8cb78231-c476-4c34-8792-0be761d64c87"
const session = {
  sessionID: "ses_1",
  availability: "available",
  state: "busy",
  freshness: "fresh",
  observedRouteID: null,
  configuredRouteID: null,
  selectedRouteID: null,
  assignment: { taskID, state: "running", attemptID: "a", startedAt: 1_000, attemptNumber: 1 },
} as unknown as LiveSession
const live = { routes: [] } as never
const attempt = (
  task?: WorkerAttempt["task"],
  change: Partial<WorkerAttempt> = {},
): WorkerAttempt => ({
  id: "90a788b1-d0ed-480c-aa28-2fd97de7da53",
  number: 1,
  state: "running",
  startedAt: 1_000,
  toolCount: 17,
  summary: { ticks: [{ at: 1_500 }], files: 5, lastActivityAt: 49 * 60_000 },
  ...(task ? { task } : {}),
  ...change,
})
const line = (change: Partial<ActivityLine>): ActivityLine => ({
  kind: "call",
  id: "x",
  sessionID: "ses_1",
  callID: "c",
  tool: "read",
  status: "completed",
  current: false,
  target: null,
  extraTargets: 0,
  detail: null,
  startedAt: 1,
  endedAt: 2,
  error: null,
  record: null,
  ...change,
})

test("a worker whose task is held reads Waiting, the word Tasks shows, not running", () => {
  const held = attempt({
    state: "running",
    reason: null,
    planState: "blocked",
    planReason: "Worker execution was interrupted; the runtime could not resume it",
  })
  expect(taskRowFor(held.task!, taskID)).toMatchObject({ status: "running", waiting: true })
  expect(workerState(session, held)).toMatchObject({ word: "Waiting", tone: "warning" })
  const fine = attempt({ state: "running", reason: null, planState: "running", planReason: null })
  expect(workerState(session, fine).word).toBe("Running")
  expect(
    workerState(
      session,
      attempt({ state: "verifying", reason: null, planState: "running", planReason: null }),
    ).word,
  ).toBe("Verifying")
  // Before the attempt read arrives the session's own recorded state is the one word.
  expect(workerState(session).word).toBe("Running")
  expect(workerState({ ...session, assignment: null, state: "idle" } as LiveSession).word).toBe(
    "Idle",
  )
})

test("tool names read as words and a target cell is never blank", () => {
  expect([
    toolName("read"),
    toolName("grep"),
    toolName("glob"),
    toolName("patch"),
    toolName("shell"),
  ]).toEqual(["Read", "Search", "Search", "Edit", "Shell"])
  expect(toolName("lazers_report_progress")).toBe("Report progress")
  expect(callTarget(line({ tool: "grep" }))).toBe("repository")
  expect(callTarget(line({ tool: "read", target: "src/a.ts" }))).toBe("src/a.ts")
  expect(callTarget(line({ tool: "shell", detail: "bun test" }))).toBe("bun test")
  expect(callTarget(line({ tool: "skill" }))).not.toBe("")
})

test("recent calls are the newest four; the rest are earlier", () => {
  const lines = [5, 1, 4, 2, 3, 6].map((startedAt) => line({ id: String(startedAt), startedAt }))
  const { recent, earlier } = recentCalls(lines)
  expect(recent.map((item) => item.id)).toEqual(["6", "5", "4", "3"])
  expect(earlier.map((item) => item.id)).toEqual(["2", "1"])
  expect(lastCall(lines)?.id).toBe("6")
  expect(
    lastCall([line({ id: "old", startedAt: 9 }), line({ id: "run", startedAt: 1, current: true })])
      ?.id,
  ).toBe("run")
})

test("idle appears only when quiet and nothing is running", () => {
  const now = 10 * 3_600_000
  expect(idleText(now - 30_000, now, false)).toBeUndefined()
  expect(idleText(now - 3_600_000, now, true)).toBeUndefined()
  expect(idleText(now - 43 * 3_600_000 + 10 * 3_600_000 - 0, now, false)).toMatch(/^idle \d+[hd]/)
  expect(idleText(null, now, false)).toBeUndefined()
})

test("started carries a date when it was not today", () => {
  const now = new Date(2026, 10, 19, 14, 0).getTime()
  expect(startedText(new Date(2026, 10, 19, 9, 5).getTime(), now)).not.toMatch(/Nov/)
  expect(startedText(new Date(2026, 10, 17, 12, 58).getTime(), now)).toMatch(/Nov.*17|17.*Nov/)
  expect(startedText(null, now)).toBeUndefined()
})

test("worker stats are real; a missing attempt read omits Calls and an idle architect shows two", () => {
  const stats = (value: WorkerAttempt | undefined) =>
    Object.fromEntries(
      workerStats({ live, session, attempt: value, now: 5_000_000, lastActivityAt: 4_000_000 }).map(
        (stat) => [stat.label, stat.value],
      ),
    )
  expect(
    stats(
      attempt(undefined, { model: { providerID: "openai", id: "gpt-6-luna", variant: "max" } }),
    ),
  ).toMatchObject({
    Runtime: "1h 23m",
    Calls: "17 · 5 files",
    Model: "gpt-6-luna · max",
  })
  expect(stats(undefined).Calls).toBeUndefined()
  const ended = stats(attempt(undefined, { state: "failed" }))
  expect(ended.Runtime).toBe("48m 59s")
  const architect = workerStats({
    live,
    session: { ...session, assignment: null } as LiveSession,
    now: 5_000_000,
    lastActivityAt: 4_000_000,
  })
  expect(architect.map((stat) => stat.label)).toEqual(["Last active", "Model"])
  expect(architect[1]!.value).toBeUndefined()
})

test("a held worker's runtime is working time, not time since it started", () => {
  const held = attempt({
    state: "running",
    reason: null,
    planState: "blocked",
    planReason: "Worker execution was interrupted; the runtime could not resume it",
  })
  const runtime = (value: WorkerAttempt) =>
    workerStats({ live, session, attempt: value, now: 44 * 3_600_000, lastActivityAt: null }).find(
      (stat) => stat.label === "Runtime",
    )?.value
  expect(runtime(held)).toBe("48m 59s")
  const working = attempt({
    state: "running",
    reason: null,
    planState: "running",
    planReason: null,
  })
  expect(runtime(working)).toBe("1d 19h")
})

test("a held worker is not running in the summary, the map or the list word", () => {
  const heldTask: {
    state: string
    reason: string | null
    planState: string
    planReason: string | null
  } = {
    state: "running",
    reason: null,
    planState: "blocked",
    planReason: "Worker execution was interrupted; the runtime could not resume it",
  }
  const worker = (task: typeof heldTask, id: string) =>
    ({
      ...session,
      sessionID: id,
      assignment: { ...session.assignment, taskID, taskReference: `LZ-${id}`, task },
    }) as unknown as LiveSession
  const held = worker(heldTask, "1")
  const fine = worker({ ...heldTask, planState: "running", planReason: null }, "2")
  expect(isHeldWorker(held)).toBe(true)
  expect(isHeldWorker(fine)).toBe(false)
  expect(workerState(held).word).toBe("Waiting")
  const live = {
    scope: { kind: "project", sessionID: "anchor" },
    sessions: [held, fine],
    routes: [],
    workload: undefined,
  } as unknown as Parameters<typeof monitorSegments>[0]
  expect(monitorSegments(live)).toEqual([
    { count: 1, word: "running" },
    { count: 1, word: "waiting" },
  ])
  const map = createRadarMap(live, 0)
  expect(map.nodeByID.get("group:runtime")?.sub).toBe("1 running")
  expect(map.nodeByID.get("group:waiting")?.sub).toBe("1 held")
  expect(map.nodeByID.get("session:1")?.sub).toBe("waiting")
  expect(map.nodeByID.get("session:1")?.running).toBe(false)
  expect(map.nodeByID.get("session:2")?.sub).toBe("running")
})

test("a raised concern and a takeover show beside the state; absent facts show nothing", () => {
  const base = attempt()
  expect(workerSignals(base)).toEqual({})
  expect(workerSignals(null)).toEqual({})
  expect(
    workerSignals({
      ...base,
      concern: {
        line: "3 verification rounds",
        action: "takeover",
        because: "Rounds keep failing",
      },
    }),
  ).toEqual({
    concern: {
      line: "3 verification rounds",
      recommendation: "Recommended: takeover. Rounds keep failing",
    },
  })
  expect(workerSignals({ ...base, concern: { line: "Long run" } })).toEqual({
    concern: { line: "Long run" },
  })
  expect(workerSignals({ ...base, takeover: true })).toEqual({ takeover: true })
})

test("an Architect takeover attempt omits Calls instead of showing zero", () => {
  const takeover = attempt(undefined, { toolCount: 0, takeover: true })
  const labels = workerStats({
    live,
    session,
    attempt: takeover,
    now: 5_000_000,
    lastActivityAt: null,
  }).filter((stat) => stat.value !== undefined)
  expect(labels.map((stat) => stat.label)).not.toContain("Calls")
  expect(labels.some((stat) => stat.value === "0")).toBe(false)
})
