import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { projectSettings, setProjectSetting } from "../projects/settings.ts"
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
  // The fixture project runs with three slots, set where the owner sets it: Projects settings.
  setProjectSetting(repository, "github.com/example/project", "limit", 3)
  return { root, databasePath, projectDirectory, repository, store, capacity }
}

async function setLimit(
  capacity: DelegatedAgentCapacity,
  repository: TaskRepository,
  limit: number,
) {
  setProjectSetting(repository, await capacity.key(), "limit", limit)
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

test("the limit is the Projects setting, shared by a project's checkouts and not by another project", async () => {
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
  setProjectSetting(first.repository, "github.com/example/project", "limit", 5)
  expect(await secondCapacity.settings()).toMatchObject({ limit: 5 })
  expect(projectSettings(secondRepository, "github.com/example/project").limit).toBe(5)
  expect(await otherProject.settings()).toMatchObject({ limit: null, reason: null })
})

test("with no limit set every request is admitted at once, as before capacity existed", async () => {
  const f = fixture()
  setProjectSetting(f.repository, "github.com/example/project", "limit", undefined)
  const candidates = [1, 2, 3, 4, 5].map((index) =>
    submitCandidate(f.store, f.repository, f.projectDirectory, index),
  )
  for (const candidate of candidates) {
    const request = await f.capacity.ensureRunnerQueued({ ...candidate, attemptNumber: 1 })
    expect(typeof insertAdmittedAttempt(f.repository, f.capacity, request, candidate)).toBe(
      "string",
    )
  }
  const helper = await f.capacity.ensureNativeQueued({
    parentSessionID: "parent",
    toolCallID: "unlimited",
    agent: "research",
    description: "helper",
  })
  await f.capacity.waitForNative(helper, AbortSignal.timeout(1_000))
  expect(await f.capacity.settings()).toMatchObject({
    limit: null,
    active: 6,
    queued: 0,
    reason: null,
  })
})

test("a changed limit applies to the next admission without touching admitted work", async () => {
  const f = fixture()
  await setLimit(f.capacity, f.repository, 1)
  const first = submitCandidate(f.store, f.repository, f.projectDirectory, 1)
  const second = submitCandidate(f.store, f.repository, f.projectDirectory, 2)
  const firstRequest = await f.capacity.ensureRunnerQueued({ ...first, attemptNumber: 1 })
  const secondRequest = await f.capacity.ensureRunnerQueued({ ...second, attemptNumber: 1 })
  expect(typeof insertAdmittedAttempt(f.repository, f.capacity, firstRequest, first)).toBe("string")
  expect(insertAdmittedAttempt(f.repository, f.capacity, secondRequest, second)).toBe(false)
  await setLimit(f.capacity, f.repository, 2)
  expect(typeof insertAdmittedAttempt(f.repository, f.capacity, secondRequest, second)).toBe(
    "string",
  )
  await setLimit(f.capacity, f.repository, 1)
  expect(await f.capacity.settings()).toMatchObject({ limit: 1, active: 2, queued: 0 })
  expect((await f.capacity.settings()).reason).toContain("without preemption")
})

test("runner slots are atomic and queued candidates refill by priority without preemption", async () => {
  const f = fixture()
  await setLimit(f.capacity, f.repository, 1)
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

test("verifying attempts no longer consume delegated-agent slots", async () => {
  const f = fixture()
  await setLimit(f.capacity, f.repository, 1)
  const verifying = submitCandidate(f.store, f.repository, f.projectDirectory, 1)
  const waiting = submitCandidate(f.store, f.repository, f.projectDirectory, 2)
  const verifyingRequest = await f.capacity.ensureRunnerQueued({
    ...verifying,
    attemptNumber: 1,
  })
  const waitingRequest = await f.capacity.ensureRunnerQueued({ ...waiting, attemptNumber: 1 })
  const verifyingAttempt = insertAdmittedAttempt(
    f.repository,
    f.capacity,
    verifyingRequest,
    verifying,
  )
  expect(typeof verifyingAttempt).toBe("string")

  f.repository.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(verifyingAttempt),
  )

  expect(await f.capacity.settings()).toMatchObject({ active: 0, queued: 1, limit: 1 })
  expect(typeof insertAdmittedAttempt(f.repository, f.capacity, waitingRequest, waiting)).toBe(
    "string",
  )
  expect(await f.capacity.settings()).toMatchObject({ active: 1, queued: 0, limit: 1 })
})

test("startup backfill upgrades the existing attempt admission instead of duplicating it", async () => {
  const f = fixture()
  await f.capacity.ready()
  const candidate = submitCandidate(f.store, f.repository, f.projectDirectory, 1)
  const attemptID = crypto.randomUUID()
  const projectKey = "github.com/example/project"
  const now = Date.now()
  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,
        policy,state,started_at)
       VALUES(?,?,?,?,1,?,?,?,?,?,'running',?)`,
    ).run(
      attemptID,
      candidate.planID,
      f.projectDirectory,
      candidate.taskID,
      `worker-${attemptID}`,
      `message-${attemptID}`,
      f.projectDirectory,
      "b".repeat(40),
      "{}",
      now,
    )
    db.query(
      `INSERT INTO delegated_agent_admissions
       (id,project_key,project_directory,request_key,kind,state,agent,queue_order,plan_id,task_id,
        attempt_number,attempt_id,created_at,updated_at)
       VALUES(?,?,?,?,'runner','admitted','lazers-implementor',1,?,?,1,?,?,?)`,
    ).run(
      crypto.randomUUID(),
      projectKey,
      f.projectDirectory,
      `runner-existing:${attemptID}`,
      candidate.planID,
      candidate.taskID,
      attemptID,
      now,
      now,
    )
  })

  const reopened = new DelegatedAgentCapacity(f.repository, projectKey)
  await reopened.ready()
  const canonicalKey = `runner:${candidate.planID}:${candidate.taskID}:1`
  expect(
    f.repository.read(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM delegated_agent_admissions WHERE attempt_id=?",
          )
          .get(attemptID)!.count,
    ),
  ).toBe(1)
  expect(
    f.repository.read(
      (db) =>
        db
          .query<{ request_key: string }, [string]>(
            "SELECT request_key FROM delegated_agent_admissions WHERE attempt_id=?",
          )
          .get(attemptID)?.request_key,
    ),
  ).toBe(canonicalKey)
})

test("scheduling and inspection snapshots do not settle admission rows", async () => {
  const f = fixture()
  const candidate = submitCandidate(f.store, f.repository, f.projectDirectory, 1)
  const requestID = await f.capacity.ensureRunnerQueued({
    ...candidate,
    attemptNumber: 1,
  })
  const attemptID = insertAdmittedAttempt(f.repository, f.capacity, requestID, candidate)
  expect(typeof attemptID).toBe("string")
  f.repository.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attemptID as string),
  )

  expect((await f.capacity.schedulingSnapshot()).active).toBe(0)
  expect((await f.capacity.inspectionSnapshot()).active).toBe(0)
  expect(
    f.repository.read(
      (db) =>
        db
          .query<{ state: string }, [string]>(
            "SELECT state FROM delegated_agent_admissions WHERE id=?",
          )
          .get(requestID)?.state,
    ),
  ).toBe("admitted")
})

test("a dead native queue owner cannot leave an orphan head ahead of live helpers", async () => {
  const f = fixture()
  const projectKey = "github.com/example/project"
  const abandoned = new DelegatedAgentCapacity(
    f.repository,
    projectKey,
    undefined,
    () => 2_147_483_647,
  )
  await abandoned.ready()
  const orphan = await abandoned.ensureNativeQueued({
    parentSessionID: "abandoned-parent",
    toolCallID: "orphan-call",
    agent: "research",
    description: "orphan",
  })

  const live = new DelegatedAgentCapacity(f.repository, projectKey)
  await live.ready()
  await expect(live.waitForNative(orphan, new AbortController().signal)).rejects.toThrow(
    "no longer available",
  )
  expect(await live.settings()).toMatchObject({ active: 0, queued: 0 })
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
  await f.capacity.releaseNativeRequest(requests[0]!)
  await waits[3]
  expect(await f.capacity.settings()).toMatchObject({ active: 3, queued: 1, limit: 3 })

  controllers[4]!.abort(new Error("parent tool was cancelled"))
  await expect(waits[4]).rejects.toThrow("parent tool was cancelled")
  for (const request of requests) await f.capacity.releaseNativeRequest(request)
  expect(await f.capacity.settings()).toMatchObject({ active: 0, queued: 0 })
})

test("process loss alone does not release a native admission that may have executed", async () => {
  const f = fixture()
  const prior = new DelegatedAgentCapacity(
    f.repository,
    "github.com/example/project",
    undefined,
    () => 2_147_483_647,
  )
  await prior.ready()
  const request = await prior.ensureNativeQueued({
    parentSessionID: "prior-parent",
    toolCallID: "prior-call",
    agent: "research",
    description: "Native execution still needs fresh observation",
  })
  await prior.waitForNative(request, new AbortController().signal)
  const reopened = new DelegatedAgentCapacity(f.repository, "github.com/example/project")
  await reopened.ready()
  expect(await reopened.settings()).toMatchObject({ active: 1 })
})

test("ambiguous creation metadata cannot bind the wrong admitted helper", async () => {
  const f = fixture()
  await f.capacity.ready()
  const input = { parentSessionID: "parent", agent: "research", description: "same description" }
  for (const toolCallID of ["first", "second"]) {
    const request = await f.capacity.ensureNativeQueued({ ...input, toolCallID })
    await f.capacity.waitForNative(request, new AbortController().signal)
  }
  expect(
    await f.capacity.bindNativeChildFromCreatedSession({
      sessionID: "ses_unknown-child",
      ...input,
    }),
  ).toBeUndefined()
  expect(await f.capacity.settings()).toMatchObject({ active: 2 })
})
