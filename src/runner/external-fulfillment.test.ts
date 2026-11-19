import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { submitTask } from "../submission.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { git } from "./artifacts.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(key = "external-fulfillment") {
  const directory = mkdtempSync(join(tmpdir(), "lazers-external-fulfillment-"))
  directories.push(directory)
  git(directory, ["init", "--initial-branch=main"])
  writeFileSync(join(directory, "baseline.txt"), "baseline\n")
  git(directory, ["add", "baseline.txt"])
  git(directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const baseCommit = git(directory, ["rev-parse", "HEAD"])
  const dataDirectory = join(directory, "data")
  mkdirSync(dataDirectory, { recursive: true })
  const repository = new TaskRepository(join(dataDirectory, "tasks.sqlite"), directory)
  repositories.push(repository)
  const submitted = submitTask(repository, keyedProposal(key), () => ({
    projectID: "project",
    projectDirectory: directory,
    workspaceDirectory: directory,
    sessionID: "architect-session",
    startingRevision: { kind: "git", commit: baseCommit },
  }))
  if (submitted.status !== "submitted") throw new Error("Expected submitted task")
  const task = repository.get(submitted.taskID)!
  const store = new RunnerStore(repository)
  const plan = store.submit(
    {
      requestID: `plan-${key}`,
      objective: task.proposal.objective,
      baseCommit,
      workspaceMode: "shared",
      workerModel: { providerID: "openai", id: "external-fulfillment-test" },
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect-session",
  )

  const owner: HostSession = {
    id: "architect-session",
    projectID: "project",
    directory,
    agent: "architect",
    archived: false,
    busy: false,
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  }
  const calls: string[] = []
  const host: RunnerHost = {
    workerModel: async () => ({ providerID: "openai", id: "external-fulfillment-test" }),
    worktree: async () => {
      calls.push("worktree")
      throw new Error("A fulfilled task must not create a worktree")
    },
    worktrees: async () => [directory],
    removeWorktree: async () => {
      calls.push("remove-worktree")
    },
    session: async (sessionID) => (sessionID === owner.id ? structuredClone(owner) : null),
    create: async () => {
      calls.push("create-worker")
    },
    createArchitect: async () => {
      calls.push("create-architect")
    },
    prompt: async () => {
      calls.push("prompt-worker")
    },
    updateInstruction: async () => {
      calls.push("instruction")
    },
    notify: async () => {
      calls.push("notify-owner")
    },
    interrupt: async () => {
      calls.push("interrupt")
    },
  }
  const runtime = new TaskRuntime(store, host, "project")
  cleanup.push(() => runtime.stop())
  return { directory, baseCommit, repository, task, store, plan, runtime, calls }
}

function reviewed(taskID: string, requestID: string) {
  return {
    taskID,
    requestID,
    disposition: "fulfilled" as const,
    reason: "The reviewed external artifact satisfies the original task.",
    evidence: [{ kind: "artifact" as const, reference: "reviews/external-fulfillment.patch" }],
    relatedTaskIDs: [],
  }
}

test("running a draft after reviewed fulfillment cannot reserve a worker or bypass its fence", async () => {
  const f = fixture("draft-run-fence")
  const disposition = reviewed(f.task.id, "draft-run-fence-review")
  expect(
    f.repository.recordDisposition(disposition, {
      sessionID: "architect-session",
      agent: "architect",
    }),
  ).toMatchObject({ status: "recorded", disposition: { disposition: "fulfilled" } })

  // Plan admission changes metadata only. The actual reservation must still be fenced.
  const admitted = await f.runtime.command(
    {
      requestID: "admit-after-reviewed-fulfillment",
      planID: f.plan.planID,
      action: "run",
    },
    "architect-session",
  )
  expect(admitted).toMatchObject({ status: "running" })
  expect(f.store.plan(f.plan.planID)?.state).toBe("running")
  expect(f.store.nodes(f.plan.planID)[0]?.state).toBe("queued")
  expect(f.store.attempts(f.plan.planID)).toEqual([])

  await f.runtime.tick()

  expect(f.store.plan(f.plan.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("fulfilled disposition"),
  })
  expect(f.store.nodes(f.plan.planID)[0]?.state).toBe("queued")
  expect(f.store.attempts(f.plan.planID)).toEqual([])
  expect(f.store.effects(f.plan.planID)).toEqual([])
  expect(f.calls).not.toContain("create-worker")
  expect(f.calls).not.toContain("prompt-worker")
  expect(f.calls).not.toContain("worktree")

  expect(() =>
    f.store.submit(
      {
        requestID: "new-plan-after-reviewed-fulfillment",
        objective: f.task.proposal.objective,
        baseCommit: f.baseCommit,
        nodes: [{ taskID: f.task.id, revision: f.task.revision }],
        dependencies: [],
        integrationOrder: [f.task.id],
        verification: f.task.proposal.verification,
        acceptance: f.task.proposal.acceptance,
      },
      "architect-session",
    ),
  ).toThrow("Task has been retired; inspect its disposition")
  expect(f.store.attempts(f.plan.planID)).toEqual([])
})

test("reviewed fulfillment prevents the unstarted retry from requeueing a cancelled node", async () => {
  const f = fixture("retry-fence")
  f.store.move(f.plan.planID, f.task.id, "CANCEL")
  f.repository.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='cancelled',version=version+1 WHERE id=?")
      .run(f.plan.planID),
  )
  f.repository.recordDisposition(reviewed(f.task.id, "retry-fence-review"), {
    sessionID: "architect-session",
    agent: "architect",
  })
  const before = f.repository.atomic(
    (db) =>
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=?",
        )
        .get(f.plan.planID)!.count,
  )
  const repositoryVersion = f.repository.version()

  await expect(
    f.runtime.command(
      {
        requestID: "retry-after-reviewed-fulfillment",
        planID: f.plan.planID,
        action: "retry",
        taskID: f.task.id,
        reason: "Attempting an unstarted retry must not bypass the disposition.",
      },
      "architect-session",
    ),
  ).rejects.toThrow("fulfilled disposition")

  expect(f.store.plan(f.plan.planID)?.state).toBe("cancelled")
  expect(f.store.nodes(f.plan.planID)[0]?.state).toBe("cancelled")
  expect(f.store.attempts(f.plan.planID)).toEqual([])
  expect(f.store.effects(f.plan.planID)).toEqual([])
  expect(
    f.repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=?",
          )
          .get(f.plan.planID)!.count,
    ),
  ).toBe(before)
  expect(f.repository.version()).toBe(repositoryVersion)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
          )
          .get(f.directory, "retry-after-reviewed-fulfillment")!.count,
    ),
  ).toBe(0)
  expect(f.calls).not.toContain("create-worker")
  expect(f.calls).not.toContain("prompt-worker")
})

test("two repository connections serialize disposition and worker reservation in either winning order", () => {
  const first = fixture("dispatch-wins")
  const secondRepository = new TaskRepository(first.repository.path, first.directory)
  repositories.push(secondRepository)
  const fence = first.store.claim("dispatch-wins")!
  first.store.fenced("dispatch-wins", fence, (db) => {
    first.store.move(first.plan.planID, first.task.id, "READY")
    first.store.move(first.plan.planID, first.task.id, "DISPATCH")
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)`,
    ).run(
      crypto.randomUUID(),
      first.plan.planID,
      first.task.id,
      1,
      "ses_dispatch_wins",
      "msg_dispatch_wins",
      first.directory,
      first.baseCommit,
      "{}",
      Date.now(),
    )
  })
  const versionAfterDispatch = secondRepository.version()
  expect(() =>
    secondRepository.recordDisposition(reviewed(first.task.id, "dispatch-wins-review"), {
      sessionID: "architect-session",
      agent: "architect",
    }),
  ).toThrow("active execution")
  expect(secondRepository.version()).toBe(versionAfterDispatch)
  expect(first.repository.taskDisposition(first.task.id)).toBeUndefined()
  expect(first.store.attempts(first.plan.planID)).toHaveLength(1)
  expect(first.store.nodes(first.plan.planID)[0]?.state).toBe("running")

  const dispositionWins = fixture("disposition-wins")
  const otherRepository = new TaskRepository(
    dispositionWins.repository.path,
    dispositionWins.directory,
  )
  repositories.push(otherRepository)
  const otherStore = new RunnerStore(otherRepository)
  expect(
    dispositionWins.repository.recordDisposition(
      reviewed(dispositionWins.task.id, "disposition-wins-review"),
      { sessionID: "architect-session", agent: "architect" },
    ),
  ).toMatchObject({ status: "recorded" })
  dispositionWins.repository.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='running',version=version+1 WHERE id=?")
      .run(dispositionWins.plan.planID),
  )
  const beforeTransitions = otherStore.atomic(
    (db) =>
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=?",
        )
        .get(dispositionWins.plan.planID)!.count,
  )
  expect(() =>
    otherStore.fenced("disposition-wins", otherStore.claim("disposition-wins")!, (db) => {
      otherStore.move(dispositionWins.plan.planID, dispositionWins.task.id, "READY")
      otherStore.move(dispositionWins.plan.planID, dispositionWins.task.id, "DISPATCH")
      db.query(
        `INSERT INTO runner_attempts
           (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
           VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)`,
      ).run(
        crypto.randomUUID(),
        dispositionWins.plan.planID,
        dispositionWins.task.id,
        1,
        "ses_disposition_wins",
        "msg_disposition_wins",
        dispositionWins.directory,
        dispositionWins.baseCommit,
        "{}",
        Date.now(),
      )
    }),
  ).toThrow("fulfilled disposition")
  expect(dispositionWins.store.nodes(dispositionWins.plan.planID)[0]?.state).toBe("queued")
  expect(dispositionWins.store.attempts(dispositionWins.plan.planID)).toEqual([])
  expect(dispositionWins.store.effects(dispositionWins.plan.planID)).toEqual([])
  expect(
    otherStore.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=?",
          )
          .get(dispositionWins.plan.planID)!.count,
    ),
  ).toBe(beforeTransitions)
})
