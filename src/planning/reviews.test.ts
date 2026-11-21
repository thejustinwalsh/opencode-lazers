import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { TaskRepository } from "../storage.ts"
import type { PlanningAgentId } from "./contract.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import type { PlanningHost, PlanningObservation } from "./host.ts"
import { planningView } from "./read.ts"
import { PlanningReviews, reviewNoticeID, type AgentSelection } from "./reviews.ts"
import { PlanningStore } from "./store.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

type Behavior = "ok" | "malformed" | "truncated" | "hang" | "slow"
type Child = {
  agent: string
  promptedAt?: number
  nth: number
  interrupted?: boolean
}

const reply = (agent: string, ok = true) =>
  JSON.stringify({
    agent,
    status: "reviewed",
    checked: ["the write scope"],
    findings: ok
      ? [
          {
            id: "F1",
            severity: "major",
            confidence: "confirmed",
            target: { unit: "plan-link", field: "write-scope" },
            what: `${agent} found a problem`,
            failureScenario: "A worker edits the wrong file.",
            evidence: ["src/a.ts:1"],
            suggestion: "Fix the path.",
          },
        ]
      : [],
    questions: ok
      ? [
          {
            id: "Q1",
            question: "Which file?",
            why: "Changes the scope.",
            relatedFinding: "F1",
            weight: "changes-scope",
          },
        ]
      : [],
  })

function fixture(behavior: (agent: string, nth: number) => Behavior = () => "ok") {
  const root = mkdtempSync(join(tmpdir(), "lazers-reviews-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  const clock = { t: 1_000 }
  const children = new Map<string, Child>()
  const created: string[] = []
  const interrupts: string[] = []
  const counts = new Map<string, number>()
  let finished = false
  const host: PlanningHost = {
    async create(input) {
      created.push(input.id)
      if (children.has(input.id)) return "exists"
      const agent = input.agent.replace("lazers-planning-", "")
      const nth = (counts.get(agent) ?? 0) + 1
      counts.set(agent, nth)
      children.set(input.id, { agent, nth })
      return "created"
    },
    async prompt(input) {
      children.get(input.sessionID)!.promptedAt = clock.t
    },
    async observe(sessionID): Promise<PlanningObservation> {
      const child = children.get(sessionID)
      if (!child) return { found: false }
      if (child.promptedAt === undefined) return { found: true, updatedAt: 1 }
      const mode = behavior(child.agent, child.nth)
      const busyAt = child.promptedAt
      if (mode === "hang" || (mode === "slow" && !finished))
        return { found: true, updatedAt: busyAt, busyAt }
      if (child.interrupted)
        return { found: true, updatedAt: busyAt, busyAt, idleAt: busyAt, outcome: "interrupted" }
      return { found: true, updatedAt: busyAt, busyAt, idleAt: busyAt, outcome: "succeeded" }
    },
    async reply(sessionID) {
      const child = children.get(sessionID)!
      const mode = behavior(child.agent, child.nth)
      const text =
        mode === "malformed" ? '{"agent":"' + child.agent + '"' : reply(child.agent, true)
      return {
        text,
        finish: mode === "truncated" ? "length" : "stop",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
      }
    },
    async interrupt(sessionID) {
      interrupts.push(sessionID)
      const child = children.get(sessionID)
      if (child) child.interrupted = true
    },
  }
  const notices: { sessionID: string; id: string; text: string }[] = []
  const make = () =>
    new PlanningReviews({
      store,
      host,
      now: () => clock.t,
      pollMs: 0,
      inactivityMs: 300_000,
      mapFor: async () => ({
        text: "Source files:\nsrc/a.ts: const a",
        hash: "maphash",
        tokens: 5,
        paths: new Set(["src/a.ts"]),
      }),
      notify: async (sessionID, id, text) => void notices.push({ sessionID, id, text }),
      title: (agent, revision) => `${agent} r${revision}`,
    })
  const draft = (scope: string) =>
    PlanningBody.parse({
      title: "Plan",
      ask: "ask",
      plan: { objective: "o", verification: [], acceptance: [] },
      tasks: [{ draftID: "plan-link", proposal: { objective: "Do it.", writeScope: [scope] } }],
    })
  const append = (scope: string) => {
    const body = draft(scope)
    store.appendRevision("p1", undefined, body, validateBody(body), fieldHashes(body))
  }
  store.createPlanning({
    id: "p1",
    projectKey: "proj",
    projectDirectory: root,
    sessionId: "arch",
    title: "Plan",
    createdAt: 1,
    updatedAt: 1,
  })
  append("src/a.ts")
  append("src/a.ts")
  append("src/a.ts")
  const agents = (...ids: PlanningAgentId[]): AgentSelection[] =>
    ids.map((agent) => ({ agent, source: "all" }))
  const start = (reviews: PlanningReviews, ...ids: PlanningAgentId[]) =>
    reviews.start({
      planningID: "p1",
      stage: "review",
      agents: agents(...ids),
      parentSessionID: "arch",
      directory: root,
    })
  return {
    repository,
    store,
    clock,
    make,
    start,
    append,
    notices,
    interrupts,
    created,
    finish: () => (finished = true),
  }
}

test("agents that succeed settle the review with findings at the reviewed revision", async () => {
  const f = fixture()
  const reviews = f.make()
  const review = await f.start(reviews, "comprehension", "grounding")
  expect(f.store.planning("p1")!.state).toBe("in-review")
  const result = await reviews.run(review.id)
  expect(result.agents.map((a) => [a.agent, a.status])).toEqual([
    ["comprehension", "reviewed"],
    ["grounding", "reviewed"],
  ])
  expect(result.findings).toHaveLength(2)
  expect(result.findings.every((x) => x.revision === 3)).toBe(true)
  expect(result.questions).toHaveLength(2)
  expect(f.store.planning("p1")!.state).toBe("questions-open")
  expect(f.store.review(review.id)!.returnedAt).not.toBeNull()
  expect(f.notices).toEqual([])
  expect(result.summary).toMatchObject({ agents: 2, notRun: 0, tokens: 2400 })
  await reviews.tick()
  expect(f.notices).toEqual([])
})

test("malformed output is retried once; two failures are not-run, never clean", async () => {
  const f = fixture((agent, nth) =>
    agent === "grounding" ? (nth === 1 ? "malformed" : "ok") : "malformed",
  )
  const reviews = f.make()
  const review = await f.start(reviews, "comprehension", "grounding")
  const result = await reviews.run(review.id)
  const grounding = result.agents.find((a) => a.agent === "grounding")!
  expect(grounding).toMatchObject({ status: "reviewed", attempts: 2 })
  const comprehension = result.agents.find((a) => a.agent === "comprehension")!
  expect(comprehension).toMatchObject({ status: "not-run", attempts: 2 })
  expect(comprehension.reason).toStartWith("malformed:")
  const runs = f.store.runs(review.id).filter((r) => r.agent === "grounding")
  expect(runs[0]).toMatchObject({ state: "failed" })
  expect(runs[0]!.reason).toStartWith("malformed:")
  expect(runs[0]!.rawReply).toContain('{"agent":"grounding"')
  expect(result.summary.notRun).toBe(1)
})

test("a reply cut off by length fails as truncated", async () => {
  const f = fixture(() => "truncated")
  const reviews = f.make()
  const review = await f.start(reviews, "critic")
  const result = await reviews.run(review.id)
  expect(result.agents[0]).toMatchObject({ status: "not-run", reason: "truncated" })
})

test("a hung agent is interrupted and retried once, then recorded stuck", async () => {
  const f = fixture(() => "hang")
  const reviews = f.make()
  const review = await f.start(reviews, "readiness")
  for (let i = 0; i < 8 && !f.store.review(review.id)!.settledAt; i++) {
    await reviews.advance(review.id)
    f.clock.t += 300_000
  }
  const result = reviews.result(review.id)
  expect(result.agents[0]).toMatchObject({ status: "not-run", reason: "stuck", attempts: 2 })
  expect(f.interrupts).toHaveLength(2)
  expect(f.store.planning("p1")!.state).toBe("questions-open")
})

test("a restart mid-review finishes from stored state and reports once", async () => {
  const f = fixture(() => "slow")
  const first = f.make()
  const review = await f.start(first, "comprehension", "grounding")
  await first.advance(review.id)
  expect(f.store.runs(review.id).map((r) => r.state)).toEqual(["running", "running"])
  // The executor is dropped; a new one on the same database takes over.
  const second = f.make()
  f.finish()
  for (let i = 0; i < 5 && !f.store.review(review.id)!.settledAt; i++) await second.tick()
  expect(f.store.review(review.id)!.settledAt).not.toBeNull()
  expect(f.notices).toHaveLength(1)
  expect(f.notices[0]!.id).toBe(reviewNoticeID(review.id))
  expect(f.notices[0]!.sessionID).toBe("arch")
  expect(f.notices[0]!.text).toStartWith("[lz-notice kind=planning-review plan=p1 v=3]")
  await second.tick()
  await second.tick()
  expect(f.notices).toHaveLength(1)
})

test("a run left in starting whose child is missing is created again with the same session id", async () => {
  const f = fixture()
  const first = f.make()
  const review = await f.start(first, "critic")
  const run = f.store.runs(review.id)[0]!
  expect(run.state).toBe("starting")
  const second = f.make()
  await second.tick()
  expect(f.created).toContain(run.sessionId!)
  expect(f.store.runs(review.id)[0]!.sessionId).toBe(run.sessionId!)
})

test("an abort interrupts the children and records both agents cancelled", async () => {
  const f = fixture(() => "slow")
  const reviews = f.make()
  const review = await f.start(reviews, "comprehension", "grounding")
  const abort = new AbortController()
  const pending = reviews.run(review.id, abort.signal)
  await new Promise((resolve) => setTimeout(resolve, 20))
  abort.abort()
  const result = await pending
  expect(result.agents.map((a) => [a.status, a.reason])).toEqual([
    ["not-run", "cancelled"],
    ["not-run", "cancelled"],
  ])
  expect(f.interrupts).toHaveLength(2)
  expect(f.store.planning("p1")!.state).toBe("questions-open")
})

test("a revision stored during the review leaves its findings at the reviewed revision, stale", async () => {
  const f = fixture(() => "slow")
  const reviews = f.make()
  const review = await f.start(reviews, "grounding")
  await reviews.advance(review.id)
  f.append("src/b.ts")
  f.finish()
  const result = await reviews.run(review.id)
  expect(result.revision).toBe(3)
  expect(f.store.planning("p1")!.state).toBe("questions-open")
  const view = planningView(f.store, "proj", "p1")!
  const scope = view.findings.find((x) => x.field === "write-scope")!
  expect(scope.revision).toBe(3)
  expect(scope.stale).toBe(true)
})

test("planning children take no delegated-agent admission", async () => {
  const f = fixture()
  const count = () =>
    f.repository.read((db) => {
      const table = db
        .query("SELECT 1 FROM sqlite_master WHERE name='delegated_agent_admissions'")
        .get()
      return table
        ? (db.query("SELECT COUNT(*) AS n FROM delegated_agent_admissions").get() as { n: number })
            .n
        : 0
    })
  const before = count()
  const reviews = f.make()
  const review = await f.start(reviews, "grounding", "critic")
  await reviews.run(review.id)
  expect(count()).toBe(before)
})

test("an open review of the same plan, stage and revision is joined, and a path missing from the map is a finding", async () => {
  const f = fixture(() => "slow")
  const reviews = f.make()
  f.append("src/missing.ts")
  const one = await f.start(reviews, "grounding")
  const two = await f.start(reviews, "grounding")
  expect(two.id).toBe(one.id)
  const own = f.store.findings("p1").filter((x) => x.source === "path-check")
  expect(own).toHaveLength(1)
  expect(own[0]).toMatchObject({ revision: 4, severity: "major", draftId: "plan-link" })
})

test("an idle tick with settled history reads no review rows and makes no host call", async () => {
  const f = fixture()
  const reviews = f.make()
  // History: three settled, returned reviews with their runs, findings and questions.
  for (let round = 0; round < 3; round++) {
    const review = await f.start(reviews, "comprehension", "grounding")
    await reviews.run(review.id)
    expect(f.store.review(review.id)!.settledAt).not.toBeNull()
  }
  await reviews.tick()
  const created = f.created.length
  const interrupts = f.interrupts.length
  const notices = f.notices.length

  const meter = meterRepository(f.repository)
  await reviews.tick()
  await reviews.tick()
  meter.stop()
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[read-sweep] idle planning tick x2 rows=${meter.rows} bytes=${meter.bytes} statements=${meter.statements.length}`,
    )
  // One probe per tick for open or unannounced reviews: none.
  expect(meter.rows).toBe(0)
  expect(meter.statements.length).toBe(2)
  expect([f.created.length, f.interrupts.length, f.notices.length]).toEqual([
    created,
    interrupts,
    notices,
  ])
})

test("idle review ticks read one stamp each and write nothing", async () => {
  const f = fixture()
  const reviews = f.make()
  const review = await f.start(reviews, "comprehension")
  await reviews.run(review.id)
  await reviews.tick()
  let reads = 0
  let writes = 0
  const read = f.repository.read.bind(f.repository)
  const atomic = f.repository.atomic.bind(f.repository)
  f.repository.read = ((run: never) => {
    reads++
    return read(run)
  }) as typeof f.repository.read
  f.repository.atomic = ((run: never) => {
    writes++
    return atomic(run)
  }) as typeof f.repository.atomic
  for (let i = 0; i < 60; i++) await reviews.tick()
  f.repository.read = read
  f.repository.atomic = atomic
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(`[planning-tick] 60 idle ticks reads=${reads} writes=${writes}`)
  expect(writes).toBe(0)
  // One probe per tick, however many reviews are settled behind it.
  expect(reads).toBe(60)
}, 120_000)
