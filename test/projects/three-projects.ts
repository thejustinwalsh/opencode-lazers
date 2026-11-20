import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../../src/project-key.ts"
import { projects, setProjectCode } from "../../src/projects/registry.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { TaskRepository } from "../../src/storage.ts"
import { validProposal } from "../proposal.ts"

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

export type TestProject = {
  key: string
  code: string
  directory: string
  repository: TaskRepository
  taskIDs: string[]
  planIDs: string[]
}

/** Insert a task into one checkout and return its id. */
export function addTask(repository: TaskRepository, objective: string, sessionID = "session-a") {
  const proposal = validProposal()
  proposal.objective = objective
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
      sessionID,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  }).id
}

/** Submit a plan holding the given tasks, owned by `owner`. */
export function addPlan(repository: TaskRepository, taskIDs: string[], owner = "session-a") {
  const proposal = validProposal()
  return new RunnerStore(repository).submit(
    {
      requestID: `plan-${taskIDs.join("-")}`,
      objective: `Plan for ${taskIDs.join(", ")}`,
      baseCommit: "a".repeat(40),
      nodes: taskIDs.map((taskID) => ({ taskID, revision: 1 })),
      dependencies: [],
      integrationOrder: taskIDs,
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    owner,
  ).planID
}

/**
 * Three registered projects in one temporary database, each with its own checkout, code
 * (AAA, BBB, CCC), tasks and one plan. Project AAA has two further tasks without a plan.
 */
export async function threeProjects() {
  resetProjectAliasCache()
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-all-projects-")))
  const path = join(parent, "tasks.sqlite")
  const opened: TaskRepository[] = []
  const made: TestProject[] = []
  for (const [index, name] of ["alpha", "beta", "gamma"].entries()) {
    const directory = join(parent, name)
    mkdirSync(directory, { recursive: true })
    await git(directory, "init", "-q", "-b", "main")
    await git(directory, "remote", "add", "origin", `git@h.com:o/${name}.git`)
    const repository = new TaskRepository(path, directory)
    opened.push(repository)
    const { key } = await registerProject(repository, {
      directory,
      opencodeProjectID: `opencode-${name}`,
    })
    const code = ["AAA", "BBB", "CCC"][index]!
    setProjectCode(repository, key, code)
    const planned = addTask(repository, `${name} planned task`)
    const planID = addPlan(repository, [planned])
    const extra =
      index === 0
        ? [addTask(repository, "alpha loose one"), addTask(repository, "alpha loose two")]
        : []
    made.push({ key, code, directory, repository, taskIDs: [planned, ...extra], planIDs: [planID] })
  }
  return {
    path,
    parent,
    projects: made,
    registry: () => projects(made[0]!.repository),
    close() {
      for (const repository of opened) repository.close()
      resetProjectAliasCache()
      rmSync(parent, { recursive: true, force: true })
    },
  }
}
