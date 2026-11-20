import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject } from "../project-key.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { dispatchPauseTransition } from "./pause-machine.ts"
import { effectivePause, outerPauseReason, pauseRecords, setPause } from "./pause.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Two projects in one database, each with a plan. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-pause-"))
  const path = join(directory, "tasks.sqlite")
  const a = new TaskRepository(path, join(directory, "alpha"))
  const b = new TaskRepository(path, join(directory, "beta"))
  cleanups.push(() => {
    a.close()
    b.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const storeA = new RunnerStore(a)
  const storeB = new RunnerStore(b)
  const keyA = (await registerProject(a, { directory: a.projectDirectory, opencodeProjectID: "a" }))
    .key
  const keyB = (await registerProject(b, { directory: b.projectDirectory, opencodeProjectID: "b" }))
    .key
  const plan = (repository: TaskRepository, id: string) =>
    repository.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, repository.projectDirectory, "owner", 1, 1, "running", "{}"),
    )
  const planA = crypto.randomUUID()
  const planB = crypto.randomUUID()
  plan(a, planA)
  plan(b, planB)
  return { a, b, storeA, storeB, keyA, keyB, planA, planB }
}

test("the machine rejects an unpause from enabled and allows a repeated pause", () => {
  expect(() => dispatchPauseTransition("enabled", "PROJECT_DISPATCH_UNPAUSED")).toThrow()
  expect(() => dispatchPauseTransition("enabled", "GLOBAL_DISPATCH_UNPAUSED")).toThrow()
  expect(dispatchPauseTransition("enabled", "PROJECT_DISPATCH_PAUSED")).toBe("paused")
  expect(dispatchPauseTransition("paused", "GLOBAL_DISPATCH_PAUSED")).toBe("paused")
  expect(dispatchPauseTransition("paused", "PROJECT_DISPATCH_UNPAUSED")).toBe("enabled")
})

test("pausing one project holds its plans and no other project's", async () => {
  const f = await fixture()
  expect(effectivePause(f.a, f.planA)).toBeUndefined()
  setPause(f.a, { kind: "project", key: f.keyA }, { paused: true, reason: "Rebuild", by: "owner" })
  expect(effectivePause(f.a, f.planA)).toMatchObject({
    level: "project",
    reason: "Rebuild",
    by: "owner",
  })
  expect(effectivePause(f.b, f.planB)).toBeUndefined()
  expect(f.storeA.effectiveDispatchPause(f.planA)).toEqual({
    reason: "Project pause: Rebuild",
    untilPlans: [],
    level: "project",
  })
  expect(f.storeB.effectiveDispatchPause(f.planB)).toBeUndefined()
  setPause(f.a, { kind: "project", key: f.keyA }, { paused: false, reason: "", by: "owner" })
  expect(effectivePause(f.a, f.planA)).toBeUndefined()
})

test("global pause holds every project", async () => {
  const f = await fixture()
  setPause(f.a, { kind: "global" }, { paused: true, reason: "Battery", by: "owner" })
  expect(effectivePause(f.a, f.planA)?.level).toBe("global")
  expect(effectivePause(f.b, f.planB)?.level).toBe("global")
  expect(f.storeB.effectiveDispatchPause(f.planB)?.reason).toBe("Global pause: Battery")
  expect(pauseRecords(f.a)).toEqual([
    expect.objectContaining({ scope: { kind: "global" }, reason: "Battery", by: "owner" }),
  ])
})

test("the strictest of plan, project and global wins, and clearing reveals the next", async () => {
  const f = await fixture()
  f.storeA.setDispatchPause(f.planA, { reason: "Plan hold", untilPlans: [] }, {})
  expect(effectivePause(f.a, f.planA)).toMatchObject({ level: "plan", reason: "Plan hold" })
  setPause(f.a, { kind: "project", key: f.keyA }, { paused: true, reason: "P", by: "owner" })
  setPause(f.a, { kind: "global" }, { paused: true, reason: "G", by: "owner" })
  expect(effectivePause(f.a, f.planA)?.level).toBe("global")
  setPause(f.a, { kind: "global" }, { paused: false, reason: "", by: "owner" })
  expect(effectivePause(f.a, f.planA)?.level).toBe("project")
  setPause(f.a, { kind: "project", key: f.keyA }, { paused: false, reason: "", by: "owner" })
  expect(effectivePause(f.a, f.planA)).toMatchObject({ level: "plan", reason: "Plan hold" })
  // The plan's own pause and its resume condition are untouched by the other levels.
  expect(f.storeA.dispatchPause(f.planA)).toEqual({ reason: "Plan hold", untilPlans: [] })
})

test("a global pause set before a project registers already holds it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-pause-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "late"))
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const store = new RunnerStore(repository)
  setPause(repository, { kind: "global" }, { paused: true, reason: "Hold", by: "owner" })
  expect(store.effectiveDispatchPause("none")?.level).toBe("global")
  await registerProject(repository, {
    directory: repository.projectDirectory,
    opencodeProjectID: "late",
  })
  expect(store.effectiveDispatchPause("none")?.level).toBe("global")
})

test("a repeated pause updates the reason; unpausing a scope that is not paused is a no-op", async () => {
  const f = await fixture()
  const scope = { kind: "project", key: f.keyA } as const
  setPause(f.a, scope, { paused: false, reason: "", by: "owner" })
  expect(pauseRecords(f.a)).toEqual([])
  setPause(f.a, scope, { paused: true, reason: "one", by: "owner" })
  setPause(f.a, scope, { paused: true, reason: "two", by: "owner" })
  expect(pauseRecords(f.a)).toHaveLength(1)
  expect(effectivePause(f.a, f.planA)?.reason).toBe("two")
  expect(() =>
    setPause(f.a, { kind: "project", key: "global" }, { paused: true, reason: "", by: "o" }),
  ).toThrow()
})

test("the held reason names the level", () => {
  expect(outerPauseReason({ level: "project", reason: "Rebuild" })).toBe("Project pause: Rebuild")
  expect(outerPauseReason({ level: "global", reason: " " })).toBe("Global pause")
})
