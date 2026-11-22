import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import {
  recordTaskAdvice,
  taskAdviceSnapshot,
  TASK_ADVICE_HISTORY_PROJECTION_LIMIT,
} from "./advice.ts"
import { getTaskDetail } from "./stream-query.ts"
import { taskInstructions } from "./instructions.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-task-advice-"))
  const path = join(directory, "tasks.sqlite")
  const repositories: TaskRepository[] = []
  const open = (projectDirectory = "/project") => {
    const repository = new TaskRepository(path, projectDirectory)
    repositories.push(repository)
    return repository
  }
  cleanups.push(() => {
    for (const repository of repositories) repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { open, path }
}

function insert(repository: TaskRepository) {
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: "submitter-session",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
}

test("S2-4 advice distinguishes an absent schema from an installed empty history", () => {
  const repository = fixture().open()
  const task = insert(repository)
  expect(taskAdviceSnapshot(repository, task.id)).toBeNull()
  repository.atomic((db) => db.exec("DROP TABLE task_advice"))
  expect(() => taskAdviceSnapshot(repository, task.id)).toThrow(
    "Task advice schema is not installed",
  )
})

function input(taskID: string, requestID: string, expectedRevision = 0) {
  return {
    taskID,
    specRevision: 1,
    requestID,
    expectedRevision,
    findings: ["The live task bytes remain the approved source of truth."],
    implementationAdvice: ["Attach advice separately and keep it non-authoritative."],
    references: [
      { kind: "source" as const, reference: "src/tasks/read.ts", description: "Shared read seam." },
      { kind: "mini-skill" as const, reference: "sqlite", description: "Optional, not fetched." },
    ],
  }
}

test("advice persists append-only with exact replay, correction, conflicts, provenance, and reopen", async () => {
  const { open } = fixture()
  const repository = open()
  const task = insert(repository)
  const taskBody = repository.atomic(
    (db) =>
      db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!.body,
  )
  const firstInput = {
    ...input(task.id, "advice-request-1"),
    findings: [
      "The original worker is interrupted, but its checkout still contains the implementation and focused tests. Reconciliation only rechecks the current hold; it does not continue an interrupted model turn. The existing resume action can continue the same attempt without discarding its workspace, usage or history, while keeping unknown background activity explicitly unknown.",
    ],
    implementationAdvice: [
      "Inspect the current plan, assigned worker and pending input before resuming. Use the supported resume action for the existing attempt, retain the checkout and baseline, and let runtime recheck eligibility. After continuing, finish the outstanding typecheck, commit the tested changes and report the actual artifact and remaining verification gaps. Keep product verification separate from the fact that the continuation request was delivered.",
    ],
  }
  const first = recordTaskAdvice(repository, firstInput, {
    sessionID: "trusted-architect-session",
    agent: "architect",
  })
  expect(first.status).toBe("recorded")
  if (first.status !== "recorded") throw new Error("Expected recorded advice")
  expect(first.advice).toMatchObject({
    projectDirectory: "/project",
    taskID: task.id,
    specRevision: 1,
    requestID: firstInput.requestID,
    revision: 1,
    findings: firstInput.findings,
    implementationAdvice: firstInput.implementationAdvice,
    provenance: {
      sessionID: "trusted-architect-session",
      agent: "architect",
    },
  })
  const instructions = taskInstructions(await getTaskDetail(repository, { taskID: task.id }))
  expect(instructions).toContain(firstInput.findings[0]!)
  expect(instructions).toContain(firstInput.implementationAdvice[0]!)
  const replay = recordTaskAdvice(repository, firstInput, {
    sessionID: "replacement-architect-session",
    agent: "architect",
  })
  expect(replay).toEqual({ status: "replayed", advice: first.advice })

  const changedReplay = recordTaskAdvice(
    repository,
    { ...firstInput, implementationAdvice: ["Different content with the same request ID."] },
    { sessionID: "trusted-architect-session", agent: "architect" },
  )
  expect(changedReplay).toMatchObject({ status: "conflict", taskID: task.id })
  expect(changedReplay).not.toHaveProperty("advice")

  const stale = recordTaskAdvice(repository, input(task.id, "advice-stale-request", 0), {
    sessionID: "trusted-architect-session",
    agent: "architect",
  })
  expect(stale).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
  })

  const correctionInput = {
    ...input(task.id, "advice-request-2", 1),
    findings: ["A new observation supersedes the earlier effective finding."],
    implementationAdvice: ["Workers receive only this current advice in readable instructions."],
  }
  const correction = recordTaskAdvice(repository, correctionInput, {
    sessionID: "correcting-architect-session",
    agent: "architect",
  })
  expect(correction.status).toBe("recorded")
  if (correction.status !== "recorded") throw new Error("Expected correction")
  expect(correction.advice.revision).toBe(2)
  expect(taskAdviceSnapshot(repository, task.id)).toEqual({
    current: correction.advice,
    history: [first.advice, correction.advice],
    historyCount: 2,
    historyTruncated: false,
  })
  expect(
    repository.atomic(
      (db) =>
        db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!
          .body,
    ),
  ).toBe(taskBody)

  repository.close()
  const reopened = open()
  expect(reopened.get(task.id)).toEqual(task)
  expect(taskAdviceSnapshot(reopened, task.id)).toEqual({
    current: correction.advice,
    history: [first.advice, correction.advice],
    historyCount: 2,
    historyTruncated: false,
  })
  expect(
    recordTaskAdvice(reopened, correctionInput, {
      sessionID: "new-session-after-reopen",
      agent: "architect",
    }),
  ).toEqual({ status: "replayed", advice: correction.advice })
})

test("foreign-project reads and writes do not expose or create attachment receipts", () => {
  const { open } = fixture()
  const repository = open()
  const foreign = open("/other-project")
  const task = insert(repository)
  expect(taskAdviceSnapshot(foreign, task.id)).toBeNull()
  expect(() =>
    recordTaskAdvice(foreign, input(task.id, "foreign-request"), {
      sessionID: "other-architect",
      agent: "architect",
    }),
  ).toThrow("Task not found in this project")
  // S2-4: startup owns the schema; rejected writes must not create receipts.
  expect(foreign.read((db) => db.query("SELECT count(*) AS count FROM task_advice").get())).toEqual(
    { count: 0 },
  )
  const original = recordTaskAdvice(repository, input(task.id, "shared-request-id"), {
    sessionID: "architect-session",
    agent: "architect",
  })
  expect(original.status).toBe("recorded")
  expect(() =>
    recordTaskAdvice(foreign, input(task.id, "shared-request-id"), {
      sessionID: "other-architect",
      agent: "architect",
    }),
  ).toThrow("Task not found in this project")
  expect(() =>
    recordTaskAdvice(
      foreign,
      { ...input(task.id, "shared-request-id"), findings: ["Changed foreign replay."] },
      { sessionID: "other-architect", agent: "architect" },
    ),
  ).toThrow("Task not found in this project")
  expect(taskAdviceSnapshot(foreign, task.id)).toBeNull()
})

test("corrections continue past the bounded read projection without dropping history or changing task bytes", async () => {
  const repository = fixture().open()
  const task = insert(repository)
  const originalBody = repository.atomic(
    (db) =>
      db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!.body,
  )
  const totalRevisions = TASK_ADVICE_HISTORY_PROJECTION_LIMIT + 2
  for (let revision = 0; revision < totalRevisions; revision++) {
    const receipt = recordTaskAdvice(
      repository,
      {
        ...input(task.id, `bounded-advice-${revision}`, revision),
        findings: [`Finding revision ${revision + 1}.`],
      },
      { sessionID: "architect-session", agent: "architect" },
    )
    expect(receipt.status).toBe("recorded")
  }
  const snapshot = taskAdviceSnapshot(repository, task.id)
  expect(snapshot?.current.revision).toBe(totalRevisions)
  expect(snapshot?.history).toHaveLength(TASK_ADVICE_HISTORY_PROJECTION_LIMIT)
  expect(snapshot?.history[0]?.revision).toBe(
    totalRevisions - TASK_ADVICE_HISTORY_PROJECTION_LIMIT + 1,
  )
  expect(snapshot?.history.at(-1)?.revision).toBe(totalRevisions)
  expect(snapshot).toMatchObject({ historyCount: totalRevisions, historyTruncated: true })
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM task_advice WHERE project_directory=? AND task_id=?",
          )
          .get(repository.projectDirectory, task.id)!.count,
    ),
  ).toBe(totalRevisions)
  expect(
    repository.atomic(
      (db) =>
        db
          .query<{ revision: number }, [string, string, number]>(
            "SELECT revision FROM task_advice WHERE project_directory=? AND task_id=? AND revision=?",
          )
          .get(repository.projectDirectory, task.id, 1)?.revision,
    ),
  ).toBe(1)
  expect(
    repository.atomic(
      (db) =>
        db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!
          .body,
    ),
  ).toBe(originalBody)
  const detail = await getTaskDetail(repository, { taskID: task.id })
  expect(detail).toMatchObject({
    status: "found",
    advice: {
      current: { revision: totalRevisions },
      historyCount: totalRevisions,
      historyTruncated: true,
    },
  })
  if (detail.status !== "found") throw new Error("Expected task detail with advice")
  const instructions = taskInstructions(detail)
  expect(instructions).toContain(`Finding revision ${totalRevisions}.`)
  expect(instructions).not.toContain("Finding revision 1.")
})

test("concurrent writers serialize expected-revision compare-and-append", async () => {
  const { open, path } = fixture()
  const repository = open()
  const task = insert(repository)
  const storageModule = new URL("../storage.ts", import.meta.url).href
  const adviceModule = new URL("./advice.ts", import.meta.url).href
  const script = `
    import { TaskRepository } from ${JSON.stringify(storageModule)};
    import { recordTaskAdvice } from ${JSON.stringify(adviceModule)};
    const [path, taskID, requestID, finding] = process.argv.slice(1);
    const repository = new TaskRepository(path, "/project");
    const receipt = recordTaskAdvice(repository, {
      taskID, specRevision: 1, requestID, expectedRevision: 0,
      findings: [finding], implementationAdvice: ["Commit only against the expected advice revision."], references: []
    }, { sessionID: requestID, agent: "architect" });
    console.log(JSON.stringify(receipt));
    repository.close();
  `
  const processes = ["concurrent-advice-a", "concurrent-advice-b"].map((requestID) =>
    Bun.spawn([process.execPath, "-e", script, path, task.id, requestID, requestID], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const receipts = await Promise.all(
    processes.map(async (process) => {
      const [output, error, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(status, error).toBe(0)
      return JSON.parse(output.trim()) as { status: string }
    }),
  )
  expect(receipts.map((receipt) => receipt.status).sort()).toEqual(["conflict", "recorded"])
  expect(taskAdviceSnapshot(repository, task.id)?.history).toHaveLength(1)
})
