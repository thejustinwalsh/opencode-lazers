import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { taskEventsProjection } from "../events/task-events-refresh.ts"
import { ensureHostSessionStateSchema } from "../host-sessions/state.ts"
import { startProjection } from "../projections/owner.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { acquireReaderPool } from "../streams/pool.ts"
import {
  activityQueries,
  detailQueries,
  searchQueries,
  seedHostSessions,
} from "./detail-corpus-queries.ts"
import { detailCorpus, named } from "./detail.fixture.ts"
import { readActivityPayload, readCurrentActivity, readTaskDetail } from "./detail-read.ts"
import { poolRead, queryTaskPage } from "./stream-query.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const RECORDED = JSON.parse(
  readFileSync(new URL("./detail.recorded.json", import.meta.url), "utf8"),
) as Record<"get" | "search" | "activity", Record<string, unknown>>

const pacing = {
  startMs: 0,
  quiet: { sliceMs: 40, waitMs: 1 },
  busy: { sliceMs: 40, waitMs: 1 },
  retryMs: 60_000,
}

/** The corpus with its task events folded and its host sessions stored, and a reader pool. */
async function corpus() {
  const made = await detailCorpus()
  cleanups.push(() => made.close())
  const events = startProjection(
    made.f.repository.path,
    made.f.repository.projectDirectory,
    taskEventsProjection,
    { pacing },
  )
  cleanups.push(() => events.release())
  await events.owner.settle()
  ensureHostSessionStateSchema(made.f.repository)
  made.f.repository.atomic((db) => seedHostSessions(db, made))
  const lease = acquireReaderPool(made.f.repository.path)
  cleanups.push(() => lease.release())
  return { ...made, read: poolRead(lease.pool) }
}

test("tasks.detail, tasks.attempts and tasks.activity compose what Tasks.get returned, field for field", async () => {
  const made = await corpus()
  for (const [key, query] of Object.entries(detailQueries(made))) {
    const { taskID, sessionID, revision, classificationRevision } = query.input as {
      taskID: string
      sessionID?: string
      revision?: number
      classificationRevision?: number
    }
    const detail = await readTaskDetail(
      made.read,
      {
        project: made.f.repository.projectDirectory,
        taskID,
        ...(revision !== undefined ? { revision } : {}),
        ...(classificationRevision !== undefined ? { classificationRevision } : {}),
        ...(sessionID ? ("linked" in query ? { session: sessionID } : { creator: sessionID }) : {}),
      },
      { payloads: "all" },
    )
    expect({ key, detail: named(detail, made.names) }).toEqual({ key, detail: RECORDED.get[key] })
  }
})

test("the panel's detail carries the scope payloads; a History row reads its own when it opens", async () => {
  const made = await corpus()
  const project = made.f.repository.projectDirectory
  const detail = await readTaskDetail(
    made.read,
    { project, taskID: made.tasks.grind },
    { payloads: "scope" },
  )
  if (detail.status !== "found") throw new Error("not found")
  const full = RECORDED.get.grind as { activity: { event: string; payload: string }[] }
  const shown = named(detail, made.names) as { activity: { event: string; payload?: string }[] }
  expect(shown.activity.map((event) => event.event)).toEqual(
    full.activity.map((event) => event.event),
  )
  for (const event of shown.activity)
    if (event.event === "SCOPE_REPORTED" || event.event === "SCOPE_AMENDED")
      expect(event.payload).toBe(full.activity.find((item) => item.event === event.event)!.payload)
    else expect(event.payload).toBeUndefined()
  const verify = detail.activity!.find((event) => event.event === "REPAIR")!
  expect(
    await readActivityPayload(made.read, {
      project,
      taskID: made.tasks.grind,
      planID: detail.execution!.planID,
      id: verify.id,
    }),
  ).toBe(full.activity.find((event) => event.event === "REPAIR")!.payload)
})

test("tasks.currentActivity over stored host sessions shows what the host reads showed", async () => {
  const made = await corpus()
  for (const [key, input] of Object.entries(activityQueries(made))) {
    const shown = await readCurrentActivity(made.read, {
      project: made.f.repository.projectDirectory,
      ...(input.scope === "session" ? { session: input.sessionID } : {}),
      taskIDs: input.taskIDs,
    })
    expect({ key, shown: named(shown, made.names) }).toEqual({
      key,
      shown: RECORDED.activity[key],
    })
  }
})

test("lz-query-tasks search hits carry their matches from the stored search fields", async () => {
  const made = await corpus()
  for (const [key, query] of Object.entries(searchQueries)) {
    const {
      serverTime: _time,
      projectDirectory: _directory,
      ...page
    } = await queryTaskPage(made.f.repository, { limit: 100, state: "all", ...query })
    expect({ key, page: named(page, made.names) }).toEqual({ key, page: RECORDED.search[key] })
  }
})

test("idle: the detail, activity and search reads run no statement on the main connection and read no history", async () => {
  const made = await corpus()
  const project = made.f.repository.projectDirectory
  const meter = meterRepository(made.f.repository)
  try {
    for (const taskID of Object.values(made.tasks))
      await readTaskDetail(made.read, { project, taskID }, { payloads: "all" })
    await readCurrentActivity(made.read, { project, taskIDs: Object.values(made.tasks) })
    expect(meter.statements).toEqual([])
    // The tool's search: one readiness point read, no task body and no history.
    await queryTaskPage(made.f.repository, { limit: 100, state: "all", search: "grind" })
    expect(meter.of(/runner_transitions|runner_progress|FROM tasks\b/).rows).toBe(0)
    expect(meter.statements.length).toBeLessThanOrEqual(1)
  } finally {
    meter.stop()
  }
  // Nothing written meanwhile: the drains have nothing queued.
  made.f.repository.read((db) => {
    expect(db.query("SELECT COUNT(*) AS n FROM task_schedule_dirty").get()).toEqual({ n: 0 })
    expect(db.query("SELECT COUNT(*) AS n FROM task_events_dirty").get()).toEqual({ n: 0 })
  })
})
