import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { TaskRepository } from "../storage.ts"
import { openStream } from "../streams/client.ts"
import { readerPool } from "../streams/pool.ts"
import { streamColumns, type StreamContext } from "../streams/source.ts"
import { planningDetailSource, planningListSource } from "../streams/sources/planning.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import { planningView } from "./read.ts"
import { PlanningStore } from "./store.ts"
import { planningViewOfRow } from "./view-assembly.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const proposal = (writeScope: string) => ({
  objective: "Open a stored plan from a chat link.",
  exclusions: [],
  constraints: [],
  assumptions: [],
  writeScope: [writeScope],
  context: [],
  acceptance: [{ id: "done", assertion: "It works.", evidence: [] }],
  requirements: { capabilities: [], skills: [], risk: "low" },
  verification: [{ id: "unit", command: "bun test --timeout 120000 x" }],
})
const bodyAt = (scope: string) =>
  PlanningBody.parse({
    title: "Plan",
    ask: "ask",
    plan: { objective: "o", verification: [], acceptance: [] },
    tasks: [{ draftID: "plan-link", proposal: proposal(scope) }],
  })

/** Three plans of session `s` (one with no revision yet), one of another session, one of another project. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-plan-streams-"))
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, root)
  const store = new PlanningStore(repository)
  const plan = (id: string, sessionId: string, createdAt: number, projectKey = "proj") =>
    store.createPlanning({
      id,
      projectKey,
      projectDirectory: root,
      sessionId,
      title: `Plan ${id}`,
      createdAt,
      updatedAt: createdAt,
    })
  const revise = (id: string, scope: string) => {
    const body = bodyAt(scope)
    store.appendRevision(id, undefined, body, validateBody(body), fieldHashes(body))
  }
  plan("p1", "s", 1)
  revise("p1", "src/a.ts")
  revise("p1", "src/b.ts")
  plan("p2", "s", 2)
  revise("p2", "src/a.ts")
  plan("p3", "s", 3)
  plan("other-session", "t", 4)
  revise("other-session", "src/a.ts")
  plan("other-project", "s", 5, "elsewhere")
  revise("other-project", "src/a.ts")
  // p1: a stale and a current finding, a question, a review with two agents (one retried), a tasked draft.
  for (const [id, field] of [
    ["f1", "write-scope"],
    ["f2", "objective"],
  ] as const)
    store.addFinding({
      id,
      planningId: "p1",
      reviewId: "r1",
      runId: "u1",
      source: "critic",
      revision: 1,
      draftId: "plan-link",
      field,
      severity: "major",
      body: JSON.stringify({ what: `about ${field}` }),
    })
  store.addQuestion({
    id: "q1",
    planningId: "p1",
    reviewId: "r1",
    source: "critic",
    revision: 1,
    body: JSON.stringify({ question: "Which file?" }),
  } as never)
  store.createReview({
    id: "r1",
    planningId: "p1",
    revision: 1,
    stage: "review",
    selectionJson: "[]",
    createdAt: 10,
  })
  for (const [id, agent, attempt, state, reason] of [
    ["u1", "critic", 1, "reviewed", null],
    ["u2", "grounding", 1, "failed", "silent"],
    ["u3", "grounding", 2, "failed", "gave up"],
  ] as const)
    store.createRun({
      id,
      reviewId: "r1",
      agent,
      attempt,
      state: state as never,
      reason,
      startedAt: 20 + attempt,
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 1_000,
    })
  store.recordTasked({
    planningId: "p1",
    draftId: "plan-link",
    revision: 2,
    reference: "LZ-9",
    changedFieldsJson: JSON.stringify(["writeScope"]),
  } as never)
  const pool = readerPool(path, { workers: 1 })
  cleanups.push(async () => {
    await pool.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { repository, store, pool, root }
}

const context = (root: string): StreamContext => ({
  projectID: "proj",
  projectDirectory: root,
  projectIds: (id) => [id],
  assertRead: async () => {},
})

async function rows(
  pool: ReturnType<typeof readerPool>,
  source: typeof planningListSource | typeof planningDetailSource,
  filter: never,
  order: string,
  window: number,
) {
  const stream = openStream(pool, source as never, { filter, order, window, transport: "copy" })
  try {
    await stream.ready()
    const columns = Object.keys(streamColumns(source as never, window))
    return stream.items.map((row) =>
      Object.fromEntries(
        columns.map((column) => [column, (row as Record<string, unknown>)[column]]),
      ),
    )
  } finally {
    stream.close()
  }
}

test("planning.list parity: the session's plans newest first, as the replaced list read; this project only", async () => {
  const f = fixture()
  const filter = await planningListSource.authorize!(
    { sessionID: "s", projectKey: "elsewhere" },
    context(f.root),
  )
  expect(filter.projectKey).toBe("proj")
  const listed = []
  const stream = openStream(f.pool, planningListSource, {
    filter,
    order: "newest",
    window: 1,
    transport: "copy",
  })
  try {
    await stream.ready()
    listed.push(stream.items[0]!.id)
    while (stream.after !== 0) {
      await stream.slide(1)
      listed.push(stream.items[0]!.id)
    }
  } finally {
    stream.close()
  }
  // The replaced read: `store.plannings(sessionID)` (created_at desc, id), this project's rows.
  const replaced = f.store
    .plannings("s")
    .filter((row) => row.projectKey === "proj")
    .map((row) => row.id)
  expect(listed).toEqual(replaced)
  expect(listed).toEqual(["p3", "p2", "p1"])
})

test("planning.detail parity: the assembled row equals the replaced get, staleness, agents and tasked included", async () => {
  const f = fixture()
  for (const id of ["p1", "p2"]) {
    const filter = await planningDetailSource.authorize!({ planningID: id }, context(f.root))
    const [row] = await rows(f.pool, planningDetailSource, filter as never, "key", 1)
    expect(planningViewOfRow(row!)).toEqual(planningView(f.store, "proj", id)!)
  }
  const view = planningViewOfRow(
    (
      await rows(
        f.pool,
        planningDetailSource,
        { planningID: "p1", projectKey: "proj" } as never,
        "key",
        1,
      )
    )[0]!,
  )
  expect(view.findings.map((finding) => [finding.id, finding.stale])).toEqual([
    ["f1", true],
    ["f2", false],
  ])
  expect(
    view.reviews[0]!.agents.map((agent) => [agent.agent, agent.status, agent.attempts]),
  ).toEqual([
    ["critic", "reviewed", 1],
    ["grounding", "not-run", 2],
  ])
  expect(view.tasked).toEqual([
    { draftID: "plan-link", reference: "LZ-9", changedFields: ["writeScope"] },
  ])
  // As `get` answered null: a plan with no revision yet, and another project's plan.
  expect(
    await rows(
      f.pool,
      planningDetailSource,
      { planningID: "p3", projectKey: "proj" } as never,
      "key",
      1,
    ),
  ).toEqual([])
  expect(planningView(f.store, "proj", "p3")).toBeUndefined()
  const foreign = await planningDetailSource.authorize!(
    { planningID: "other-project" },
    context(f.root),
  )
  expect(await rows(f.pool, planningDetailSource, foreign as never, "key", 1)).toEqual([])
})

test("idle: an open Plan stream issues no statement and no change on an unrelated write; a plan write reaches it", async () => {
  const f = fixture()
  const meter = meterRepository(f.repository)
  let changes = 0
  const stream = openStream(f.pool, planningDetailSource, {
    filter: { planningID: "p1", projectKey: "proj" },
    order: "key",
    window: 1,
    transport: "copy",
  })
  try {
    await stream.ready()
    stream.on("change", () => changes++)
    await Bun.sleep(300)
    expect(meter.statements).toEqual([])
    // An unrelated table: the stream reads nothing again.
    f.repository.atomic((db) =>
      db.exec("CREATE TABLE IF NOT EXISTS unrelated(x); INSERT INTO unrelated VALUES(1)"),
    )
    await Bun.sleep(300)
    expect(changes).toBe(0)
    // Not vacuous: a finding on the plan reaches the open detail.
    f.store.addFinding({
      id: "f3",
      planningId: "p1",
      reviewId: "r1",
      runId: "u1",
      source: "critic",
      revision: 2,
      draftId: null,
      field: "other",
      severity: "minor",
      body: JSON.stringify({ what: "late" }),
    })
    for (let waited = 0; waited < 50 && changes === 0; waited++) await Bun.sleep(20)
    expect(changes).toBeGreaterThan(0)
    expect(
      planningViewOfRow(stream.items[0] as never).findings.map((finding) => finding.id),
    ).toContain("f3")
  } finally {
    stream.close()
    meter.stop()
  }
})
