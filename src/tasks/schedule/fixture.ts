import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { TaskReads } from "../read.ts"

export function openFixture(project = "/project") {
  const directory = mkdtempSync(join(tmpdir(), "lazers-schedule-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), project)
  const reads = new TaskReads(repository)
  return {
    repository,
    reads,
    directory,
    close() {
      repository.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
export type Fixture = ReturnType<typeof openFixture>

export function insertTask(repository: TaskRepository, name: string, session = "session-a") {
  const proposal = validProposal()
  proposal.objective = name
  proposal.writeScope = [`src/${name}/**`]
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: session,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  }).id
}

export function submitPlan(
  fixture: Pick<Fixture, "reads">,
  name: string,
  taskIDs: string[],
  options: { dependencies?: [string, string][]; afterPlans?: string[]; priority?: number } = {},
) {
  return fixture.reads.runner.submit(
    {
      requestID: `plan-${name}`,
      objective: name,
      baseCommit: "a".repeat(40),
      nodes: taskIDs.map((taskID) => ({ taskID, revision: 1 })),
      dependencies: (options.dependencies ?? []).map(([prerequisite, successor]) => ({
        prerequisite,
        successor,
      })),
      integrationOrder: taskIDs,
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
      ...(options.afterPlans ? { afterPlans: options.afterPlans } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    },
    "architect",
  ).planID as string
}
