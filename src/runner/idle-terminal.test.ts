import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import {
  acceptedMergedFixture,
  fixture,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

const shims: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const directory of shims.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A `git` first on PATH that logs each call, so a test can count subprocesses. */
function gitShim() {
  const real = Bun.which("git")!
  const directory = mkdtempSync(join(tmpdir(), "lazers-git-shim-"))
  shims.push(directory)
  const log = join(directory, "calls.log")
  writeFileSync(log, "")
  writeFileSync(join(directory, "git"), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`)
  chmodSync(join(directory, "git"), 0o755)
  process.env.PATH = `${directory}:${originalPath}`
  return () => readFileSync(log, "utf8").split("\n").filter(Boolean).length
}

function meter(repository: TaskRepository, host: Record<string, unknown>, gitCalls: () => number) {
  const read = repository.read.bind(repository)
  const atomic = repository.atomic.bind(repository)
  const out = { reads: 0, atomics: 0, writes: 0, host: [] as string[], git: 0 }
  const gitBefore = gitCalls()
  repository.read = ((run: (db: Database) => unknown) => {
    out.reads++
    return read(run)
  }) as typeof repository.read
  repository.atomic = ((run: (db: Database) => unknown) =>
    atomic((db) => {
      out.atomics++
      const total = () => db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n
      const before = total()
      const result = run(db)
      if (total() !== before) out.writes++
      return result
    })) as typeof repository.atomic
  const originals = new Map<string, unknown>()
  for (const [name, value] of Object.entries(host)) {
    if (typeof value !== "function") continue
    originals.set(name, value)
    host[name] = (...args: unknown[]) => {
      out.host.push(name)
      return (value as (...a: unknown[]) => unknown).apply(host, args)
    }
  }
  return {
    out,
    stop() {
      repository.read = read
      repository.atomic = atomic
      for (const [name, value] of originals) host[name] = value
      out.git = gitCalls() - gitBefore
    },
  }
}

async function ticksCost(
  f: Awaited<ReturnType<typeof acceptedMergedFixture>>["f"],
  ticks: number,
  gitCalls: () => number,
) {
  const m = meter(f.repository, f.host as unknown as Record<string, unknown>, gitCalls)
  for (let i = 0; i < ticks; i++) await f.runtime.tick()
  m.stop()
  return m.out
}

function expectStampOnly(few: Awaited<ReturnType<typeof ticksCost>>, many: typeof few) {
  expect(few.writes).toBe(0)
  expect(many.writes).toBe(0)
  expect(few.host).toEqual([])
  expect(many.host).toEqual([])
  expect(few.git).toBe(0)
  expect(many.git).toBe(0)
  expect(many.reads).toBe(few.reads * 5)
}

test("a cleanup-blocked plan whose facts did not change costs a stamp check per tick", async () => {
  const clock = { offset: 0 }
  const { f, plan, attempt, integrate } = await acceptedMergedFixture({ clock })
  writeFileSync(join(attempt.workspace, "uncommitted.txt"), "preserve this")
  await integrate("integrate-dirty")
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  await f.runtime.tick()
  const gitCalls = gitShim()
  const few = await ticksCost(f, 5, gitCalls)
  const many = await ticksCost(f, 25, gitCalls)
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[idle-terminal] blocked, 5 ticks ${JSON.stringify({ ...few, host: few.host.length })}`,
    )
  expectStampOnly(few, many)
  // The exit stays: a changed fact runs cleanup again.
  rmSync(join(attempt.workspace, "uncommitted.txt"))
  clock.offset += 61_000
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("integrated")
}, 120_000)

test("a cancelled plan that preserved unmerged commits costs a stamp check per tick", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  writeFileSync(join(attempt.workspace, "partial.txt"), "unmerged work")
  git(attempt.workspace, ["add", "-A"])
  git(attempt.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "partial work",
  ])
  await f.runtime.command(
    { requestID: "cancel", planID: f.receipt.planID, action: "cancel" },
    "owner",
  )
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  const gitCalls = gitShim()
  const few = await ticksCost({ ...f } as never, 5, gitCalls)
  const many = await ticksCost({ ...f } as never, 25, gitCalls)
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[idle-terminal] cancelled, 5 ticks ${JSON.stringify({ ...few, host: few.host.length })}`,
    )
  expectStampOnly(few, many)
}, 120_000)
