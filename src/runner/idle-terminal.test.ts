import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import { meterRepository } from "./read-meter.fixture.ts"
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

async function cleanupHistoryCost(
  historySize: number,
  gitCalls: () => number,
  unrelatedChurn = false,
) {
  const clock = { offset: 0 }
  const { f, plan, attempt, integrate } = await acceptedMergedFixture({ clock })
  const dirtyFile = join(attempt.workspace, "uncommitted.txt")
  writeFileSync(dirtyFile, "preserve this")
  await integrate(`cleanup-history-${historySize}`)
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")

  const source = f.store.effects(plan.id).find((effect) => effect.kind === "worktree")!
  const adoptionID = `cleanup-history-adoption-${historySize}`
  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_adoptions(
        id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,
        node_state,attempt_state,old_artifact,descendant_commit,target_branch,landing_head,
        reviewed_baseline,candidate_tree,input_fingerprint,environment_identity,reason,
        combined_artifact,task_workspace,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,1,1,?,'accepted','accepted','old','descendant','main','landing',
        'baseline','tree','input','environment','history facts','combined',?,'accepted',1,1)`,
    ).run(
      adoptionID,
      plan.id,
      attempt.task_id,
      `request-${historySize}`,
      "owner",
      attempt.id,
      attempt.workspace,
    )
    const insertCheck = db.query(
      `INSERT INTO runner_adoption_checks(
        adoption_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
        environment_identity,receipt_path,state,receipt,created_at
      ) VALUES(?,'task',?,'{}',?,?,'input','environment','/receipt','completed','{"exitCode":0}',?)`,
    )
    for (let index = 0; index < historySize; index++)
      insertCheck.run(
        adoptionID,
        `historical-check-${index}`,
        attempt.workspace,
        plan.artifact,
        index,
      )
    const insertAttempt = db.query(
      `INSERT INTO runner_attempts(
        id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,
        base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0,0,NULL)`,
    )
    const insertEffect = db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)")
    for (let index = 0; index < historySize; index++) {
      insertAttempt.run(
        `cleanup-history-attempt-${historySize}-${index}`,
        plan.id,
        f.root,
        attempt.task_id,
        10_000 + index,
        `cleanup-history-session-${historySize}-${index}`,
        `cleanup-history-message-${historySize}-${index}`,
        join(f.root, `history-workspace-${historySize}-${index}`),
        attempt.base_commit,
        null,
        "{}",
        10_000 + index,
      )
      insertEffect.run(
        `cleanup-history-effect-${historySize}-${index}`,
        plan.id,
        null,
        null,
        "cleanup-history",
        JSON.stringify({ index }),
        JSON.stringify({ history: "x".repeat(300) }),
      )
    }
    db.query("UPDATE runner_effects SET kind=?,payload=? WHERE id=?").run(
      "adoption-task-worktree",
      JSON.stringify({ adoptionID }),
      source.id,
    )
  })
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")

  const host = f.host as unknown as Record<string, unknown>
  const hostCalls: string[] = []
  const originals = new Map<string, unknown>()
  for (const [name, value] of Object.entries(host)) {
    if (typeof value !== "function") continue
    originals.set(name, value)
    host[name] = (...args: unknown[]) => {
      hostCalls.push(name)
      return (value as (...items: unknown[]) => unknown).apply(host, args)
    }
  }
  const planVersion = f.store.plan(plan.id)!.version
  const removalReceipt = f.store
    .effects(plan.id)
    .find((effect) => effect.kind === "worktree-remove")!.receipt
  let churn:
    | {
        planID: string
        taskID: string
      }
    | undefined
  if (unrelatedChurn) {
    const task = f.createTask(`cleanup-unrelated-${historySize}`)
    const unrelatedPlan = f.store.submit(
      f.inputFor([task], { requestID: `cleanup-unrelated-${historySize}` }),
      "owner",
    )
    await f.runtime.command(
      {
        requestID: `cleanup-unrelated-run-${historySize}`,
        planID: unrelatedPlan.planID,
        action: "run",
      },
      "owner",
    )
    expect(f.store.plan(unrelatedPlan.planID)?.state).toBe("running")
    churn = { planID: unrelatedPlan.planID, taskID: task.id }
    const cleanup = (
      f.runtime as unknown as {
        worktreeCleanup: { cleanupFacts(planID: string): unknown }
      }
    ).worktreeCleanup
    cleanup.cleanupFacts(plan.id)
  }
  hostCalls.length = 0
  const gitBefore = gitCalls()
  const sql = meterRepository(f.repository)
  const parse = JSON.parse
  let sourceReceiptDecodes = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    const value = args[0]
    if (typeof value === "string" && value.includes(`"workspace":"${attempt.workspace}"`))
      sourceReceiptDecodes++
    return parse(...args)
  }) as typeof JSON.parse
  try {
    if (churn) {
      const cleanup = (
        f.runtime as unknown as {
          worktreeCleanup: { cleanupFacts(planID: string): unknown }
        }
      ).worktreeCleanup
      for (let tick = 0; tick < 3; tick++) {
        f.repository.atomic((db) => {
          db.query("UPDATE runner_nodes SET reason=? WHERE plan_id=?").run(
            `unrelated node write ${tick}`,
            churn!.planID,
          )
          db.query(
            `INSERT INTO runner_progress(
              project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
              sources_json,kind,event_ids_json,dedupe_key,payload
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            f.root,
            "project",
            churn!.planID,
            churn!.taskID,
            "unrelated-attempt",
            "unrelated-session",
            tick,
            "test",
            "[]",
            "step",
            "[]",
            `unrelated-progress-${tick}`,
            JSON.stringify({ tick }),
          )
          db.query(
            `INSERT INTO runner_effects(
              id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence
            ) VALUES(?,?,?,NULL,'unrelated-effect','intended',?,NULL,1)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
          ).run("unrelated-cleanup-effect", churn!.planID, churn!.taskID, JSON.stringify({ tick }))
        })
        cleanup.cleanupFacts(plan.id)
      }
    } else {
      for (let tick = 0; tick < 3; tick++) await f.runtime.tick()
    }
  } finally {
    JSON.parse = parse
    sql.stop()
  }
  const cost = {
    rows: sql.rows,
    statements: [...sql.statements],
    cleanupHistoryRows: sql.of(/FROM runner_(?:effects|attempts|adoptions|adoption_checks)\b/i)
      .rows,
    cleanupHistoryBytes: sql.of(/FROM runner_(?:effects|attempts|adoptions|adoption_checks)\b/i)
      .bytes,
    bodyRows: sql.of(/SELECT[^;]*\bbody\b[^;]*\bFROM (?:runner_plans|tasks|runner_attempts)\b/i)
      .rows,
    sourceReceiptDecodes,
    fullPlanRows: sql.of(/SELECT \* FROM runner_plans\b/i).rows,
    hostCalls,
    gitCalls: gitCalls() - gitBefore,
  }
  for (const [name, value] of originals) host[name] = value
  expect(f.store.plan(plan.id)?.version).toBe(planVersion)
  expect(
    f.store.effects(plan.id).find((effect) => effect.kind === "worktree-remove")?.receipt,
  ).toBe(removalReceipt)
  return cost
}

test("unrelated active-plan churn does not reread cleanup history at small and large scale", async () => {
  const gitCalls = gitShim()
  const small = await cleanupHistoryCost(5, gitCalls, true)
  const large = await cleanupHistoryCost(500, gitCalls, true)
  expect(small.cleanupHistoryRows).toBe(0)
  expect(large.cleanupHistoryRows).toBe(0)
  expect(small.cleanupHistoryBytes).toBe(0)
  expect(large.cleanupHistoryBytes).toBe(0)
  expect(small.bodyRows).toBe(0)
  expect(large.bodyRows).toBe(0)
  expect(small.sourceReceiptDecodes).toBe(0)
  expect(large.sourceReceiptDecodes).toBe(0)
  expect(small.fullPlanRows).toBe(0)
  expect(large.fullPlanRows).toBe(0)
  expect(small.hostCalls).toEqual([])
  expect(large.hostCalls).toEqual([])
  expect(small.gitCalls).toBe(0)
  expect(large.gitCalls).toBe(0)
  expect(large.rows).toBe(small.rows)
  expect(large.statements).toEqual(small.statements)
}, 120_000)
