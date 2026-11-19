import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import { RunnerStore } from "./store.ts"

const roots: string[] = []
const repositories: TaskRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-agent-capacity-"))
  roots.push(root)
  const databasePath = join(root, "tasks.sqlite")
  const projectDirectory = join(root, "project")
  mkdirSync(projectDirectory)
  const repository = new TaskRepository(databasePath, projectDirectory)
  repositories.push(repository)
  const store = new RunnerStore(repository)
  const capacity = new DelegatedAgentCapacity(repository, "github.com/example/project")
  return { root, databasePath, projectDirectory, repository, store, capacity }
}

function submitCandidate(
  store: RunnerStore,
  repository: TaskRepository,
  projectDirectory: string,
  index: number,
  priority?: number,
) {
  const taskID = crypto.randomUUID()
  const proposal = {
    ...validProposal(),
    objective: `Run capacity candidate ${index}`,
    writeScope: [`src/capacity-${index}.ts`],
  }
  repository.insert({
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "architect",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
  const plan = store.submit(
    {
      requestID: `capacity-plan-${index}`,
      objective: `Run capacity candidate ${index}`,
      baseCommit: "b".repeat(40),
      nodes: [{ taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
      ...(priority !== undefined ? { priority } : {}),
    },
    "architect",
  )
  return { planID: plan.planID, taskID }
}

function insertAdmittedAttempt(
  repository: TaskRepository,
  capacity: DelegatedAgentCapacity,
  requestID: string,
  candidate: { planID: string; taskID: string },
) {
  const attemptID = crypto.randomUUID()
  return repository.atomic((db) => {
    if (!capacity.admitRunnerInTransaction(db, requestID, attemptID)) return false
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,1,?,?,?,?,?,'preparing',?)`,
    ).run(
      attemptID,
      candidate.planID,
      candidate.taskID,
      `worker-${attemptID}`,
      `message-${attemptID}`,
      repository.projectDirectory,
      "b".repeat(40),
      "{}",
      Date.now(),
    )
    return attemptID
  })
}

test("canonical worktrees share revisioned settings while distinct projects remain isolated", async () => {
  const first = fixture()
  const secondDirectory = join(first.root, "worktree")
  mkdirSync(secondDirectory)
  const secondRepository = new TaskRepository(first.repository.path, secondDirectory)
  repositories.push(secondRepository)
  const secondCapacity = new DelegatedAgentCapacity(secondRepository, "github.com/example/project")
  const otherProject = new DelegatedAgentCapacity(
    secondRepository,
    "github.com/example/another-project",
  )
  await Promise.all([first.capacity.ready(), secondCapacity.ready(), otherProject.ready()])

  expect((await first.capacity.settings()).limit).toBe(3)
  expect(
    await first.capacity.configure({
      expectedRevision: 0,
      limit: 5,
    }),
  ).toMatchObject({ status: "updated", settings: { revision: 1, limit: 5 } })
  expect(await secondCapacity.settings()).toMatchObject({ revision: 1, limit: 5 })
  expect(
    await secondCapacity.configure({
      expectedRevision: 0,
      limit: 2,
    }),
  ).toMatchObject({ status: "conflict", currentRevision: 1 })
  expect(await otherProject.settings()).toMatchObject({ revision: 0, limit: 3 })

  await expect(first.capacity.configure({ expectedRevision: 1, limit: 0 })).rejects.toThrow()
  await expect(
    first.capacity.configure({
      expectedRevision: 1,
      limit: 2,
      projectDirectory: secondDirectory,
    }),
  ).rejects.toThrow()
})

test("runner slots are atomic and queued candidates refill by priority without preemption", async () => {
  const f = fixture()
  await f.capacity.configure({ expectedRevision: 0, limit: 1 })
  const lowPriority = submitCandidate(f.store, f.repository, f.projectDirectory, 1, 4)
  const highPriority = submitCandidate(f.store, f.repository, f.projectDirectory, 2, 1)
  const lowRequest = await f.capacity.ensureRunnerQueued({
    ...lowPriority,
    attemptNumber: 1,
  })
  const highRequest = await f.capacity.ensureRunnerQueued({
    ...highPriority,
    attemptNumber: 1,
  })

  expect(insertAdmittedAttempt(f.repository, f.capacity, lowRequest, lowPriority)).toBe(false)
  const highAttempt = insertAdmittedAttempt(f.repository, f.capacity, highRequest, highPriority)
  expect(typeof highAttempt).toBe("string")
  expect(await f.capacity.settings()).toMatchObject({ active: 1, queued: 1, limit: 1 })

  f.repository.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(highAttempt as string),
  )
  expect(await f.capacity.settings()).toMatchObject({ active: 0, queued: 1 })
  const lowAttempt = insertAdmittedAttempt(f.repository, f.capacity, lowRequest, lowPriority)
  expect(typeof lowAttempt).toBe("string")
  expect(await f.capacity.settings()).toMatchObject({ active: 1, queued: 0, limit: 1 })
})

test("native helper waiters share the same three slots and release on observed child completion", async () => {
  const f = fixture()
  await f.capacity.ready()
  const requests: string[] = []
  for (let index = 0; index < 5; index++)
    requests.push(
      await f.capacity.ensureNativeQueued({
        parentSessionID: "parent",
        toolCallID: `call-${index}`,
        agent: index === 0 ? "auditor" : "research",
        description: `helper-${index}`,
      }),
    )
  const controllers = requests.map(() => new AbortController())
  const waits = requests.map((request, index) =>
    f.capacity.waitForNative(request, controllers[index]!.signal),
  )
  await Promise.all(waits.slice(0, 3))
  expect(await f.capacity.settings()).toMatchObject({ active: 3, queued: 2, limit: 3 })

  await f.capacity.bindNativeChild(requests[0]!, "child-0")
  await f.capacity.releaseNativeChild("child-0")
  await waits[3]
  expect(await f.capacity.settings()).toMatchObject({ active: 3, queued: 1, limit: 3 })

  controllers[4]!.abort(new Error("parent tool was cancelled"))
  await expect(waits[4]).rejects.toThrow("parent tool was cancelled")
  for (const request of requests) await f.capacity.releaseNativeRequest(request)
  expect(await f.capacity.settings()).toMatchObject({ active: 0, queued: 0 })
})
