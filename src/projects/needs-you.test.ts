import { afterEach, expect, test } from "bun:test"
import { RECOVERY_BUNDLE_EVENT } from "../runner/recovery-bundle.ts"
import { threeProjects } from "../../test/projects/three-projects.ts"
import { needsYouPage, ownerHolds, openRecoveryBundle, architectQuestions } from "./needs-you.ts"
import { projectUnits } from "./scope.ts"
import type { NeedsYouItem } from "./needs-you.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function fixture() {
  const three = await threeProjects()
  cleanups.push(() => three.close())
  const [a, b, c] = three.projects
  // Beta: its task is held for the owner. Gamma: an undelivered recovery bundle.
  b!.repository.atomic((db) =>
    db
      .query(
        "UPDATE runner_nodes SET state='blocked',reason='Waiting for an owner decision' WHERE task_id=?",
      )
      .run(b!.taskIDs[0]!),
  )
  const outboxID = crypto.randomUUID()
  c!.repository.atomic((db) => {
    db.query(
      "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,NULL,NULL)",
    ).run(outboxID, c!.planIDs[0]!, "ses-owner", `msg-${outboxID}`, "{}")
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,1,?,?,?)",
    ).run(
      c!.planIDs[0]!,
      RECOVERY_BUNDLE_EVENT,
      JSON.stringify({ outboxID, raisedAt: 5_000, keys: ["a", "b"], generation: 1 }),
      5_000,
    )
  })
  return { three, a: a!, b: b!, c: c!, outboxID }
}

async function pages(
  three: Awaited<ReturnType<typeof threeProjects>>,
  options: Partial<Parameters<typeof needsYouPage>[0]> = {},
) {
  const [a] = three.projects
  const result: NonNullable<Awaited<ReturnType<typeof needsYouPage>>>[] = []
  let cursor: string | undefined
  do {
    const page = await needsYouPage({
      repository: a!.repository,
      units: projectUnits(a!.repository, () => [three.projects[1]!.directory]),
      ownDirectory: a!.directory,
      ...(cursor ? { cursor } : {}),
      ...options,
    })
    if (!page) break
    result.push(page)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

test("holds and recovery bundles come from each project's recorded rows, with its project", async () => {
  const { three, b, c, outboxID } = await fixture()
  const result = await pages(three)
  expect(result.map((page) => [page.project.code, page.items.length])).toEqual([
    ["AAA", 0],
    ["BBB", 1],
    ["CCC", 1],
  ])
  const items = result.flatMap((page) => page.items) as NeedsYouItem[]
  expect(items[0]).toMatchObject({
    kind: "owner-hold",
    id: b.taskIDs[0],
    reason: "Waiting for an owner decision",
    project: { code: "BBB", loaded: true },
  })
  expect(items[0]?.reference?.startsWith("BBB-")).toBe(true)
  expect(items[1]).toMatchObject({
    kind: "recovery-bundle",
    id: outboxID,
    count: 2,
    since: 5_000,
    project: { code: "CCC", loaded: false },
  })
  expect(c.code).toBe("CCC")
})

test("a delivered bundle is not the owner's, and a resolved hold disappears on the next read", async () => {
  const { three, b, c } = await fixture()
  c.repository.atomic((db) => db.query("UPDATE runner_outbox SET state='delivered'").run())
  b.repository.atomic((db) => db.query("UPDATE runner_nodes SET state='queued'").run())
  expect((await pages(three)).flatMap((page) => page.items)).toEqual([])
  c.repository.read((db) => expect(openRecoveryBundle(db, c.directory)).toBeUndefined())
  b.repository.read((db) => expect(ownerHolds(db, b.directory)).toEqual([]))
})

test("native questions come only from the caller's own checkout", async () => {
  const { three, a } = await fixture()
  a.repository.read((db) => expect(db).toBeDefined())
  const asked: string[] = []
  const result = await pages(three, {
    sessionOf: async (id) => {
      asked.push(id)
      return { id, archived: false, pendingForms: 2, agent: "architect" }
    },
  })
  const questions = result
    .flatMap((page) => page.items)
    .filter((item) => item.kind === "architect-question")
  expect(questions).toHaveLength(1)
  expect(questions[0]).toMatchObject({ id: "session-a", count: 2, project: { code: "AAA" } })
  expect(new Set(asked)).toEqual(new Set(["session-a"]))
  expect(architectQuestions([{ id: "s", archived: true, pendingForms: 3 }])).toEqual([])
})

test("lz.projects needsYou pages every project and asserts no permission", async () => {
  const { Effect } = await import("effect")
  const { registerProjects } = await import("./rpc.ts")
  const { three } = await fixture()
  const [a, b] = three.projects
  let handlers: { needsYou(input: unknown): import("effect").Effect.Effect<unknown> } | undefined
  const asserted: unknown[] = []
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: NonNullable<typeof handlers>) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({ id: sessionID, projectID: "project", agent: "architect", time: {} }),
    },
    permission: {
      assert: (input: { resources: string[] }) => {
        asserted.push(input.resources)
        return input.resources.includes(b!.directory)
          ? Effect.fail(new Error("denied"))
          : Effect.void
      },
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      registerProjects(ctx as never, a!.repository, {
        projectID: "project",
        loaded: () => [],
      }).pipe(Effect.asVoid),
    ),
  )
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = (await Effect.runPromise(
      handlers!.needsYou({ sessionID: "ses-caller", ...(cursor ? { cursor } : {}) }),
    )) as { project?: { code: string }; nextCursor: string | null }
    if (page.project) seen.push(page.project.code)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(["AAA", "BBB", "CCC"])
  expect(asserted).toEqual([])
})

test("a963208e-1: a page says whether native questions were read for its checkout", async () => {
  const { three } = await fixture()
  const own = async (directory: string, units = [three.projects[0]!.directory]) =>
    needsYouPage({
      repository: three.projects[0]!.repository,
      units: projectUnits(three.projects[0]!.repository, () => units),
      ownDirectory: directory,
      sessionOf: async () => null,
    })
  const result = await pages(three, { sessionOf: async () => null })
  expect(result.map((page) => [page.project.code, page.questionsRead])).toEqual([
    ["AAA", true],
    ["BBB", false],
    ["CCC", false],
  ])
  expect((await own(three.projects[0]!.directory))!.questionsRead).toBe(true)
  // Without any session reader nothing is read, and the page says so.
  expect((await pages(three))[0]!.questionsRead).toBe(false)
})
