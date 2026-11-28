import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { CodeReviewResolver } from "../comparisons/resolver.ts"

export type CodeReviewFixtureResources = {
  roots: string[]
  repositories: TaskRepository[]
}

export type CodeReviewFixture = ReturnType<typeof makeCodeReviewFixture>

export function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

export function gitInput(root: string, args: string[], input: string): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", input })
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`)
}

export function makeCodeReviewFixture(resources: CodeReviewFixtureResources) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-code-review-"))
  resources.roots.push(directory)
  const projectDirectory = join(directory, "project")
  mkdirSync(projectDirectory)
  git(projectDirectory, "init", "--initial-branch=main")
  git(projectDirectory, "config", "user.name", "Code Review Test")
  git(projectDirectory, "config", "user.email", "code-review-test@example.invalid")
  git(projectDirectory, "config", "core.excludesFile", "/dev/null")
  mkdirSync(join(projectDirectory, "src"))
  writeFileSync(join(projectDirectory, ".gitignore"), "ignored-output/\n")
  writeFileSync(join(projectDirectory, "package.json"), '{"name":"review-fixture"}\n')
  writeFileSync(join(projectDirectory, "src/a.ts"), "export const answer = 1\n")
  writeFileSync(join(projectDirectory, "src/empty.ts"), "")
  writeFileSync(join(projectDirectory, "src/staged.ts"), "export const staged = 1\n")
  writeFileSync(join(projectDirectory, "src/unstaged.ts"), "export const dirty = 1\n")
  git(projectDirectory, "add", ".")
  git(projectDirectory, "commit", "-m", "base")
  const base = git(projectDirectory, "rev-parse", "HEAD")

  writeFileSync(join(projectDirectory, "src/a.ts"), "export const answer = 2\n")
  git(projectDirectory, "add", "src/a.ts")
  git(projectDirectory, "commit", "-m", "first artifact")
  const first = git(projectDirectory, "rev-parse", "HEAD")

  writeFileSync(join(projectDirectory, "src/a.ts"), "export const answer = 3\n")
  writeFileSync(join(projectDirectory, "src/new-empty.ts"), "")
  git(projectDirectory, "add", "src/a.ts")
  git(projectDirectory, "add", "src/new-empty.ts")
  git(projectDirectory, "commit", "-m", "repair artifact")
  const second = git(projectDirectory, "rev-parse", "HEAD")

  const workerWorkspace = join(directory, "worker-worktree")
  git(projectDirectory, "worktree", "add", "--detach", workerWorkspace, second)
  const databasePath = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(databasePath, projectDirectory)
  resources.repositories.push(repository)
  const taskID = "70cc1c08-0530-43ad-aad2-70b934243dbd"
  const task = repository.insert({
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: workerWorkspace,
      sessionID: "owner",
      startingRevision: { kind: "git", commit: base },
    },
    proposal: validProposal(),
  })
  const runner = new RunnerStore(repository)
  const input = {
    requestID: "code-review-fixture",
    objective: "Inspect task-specific code review comparisons",
    baseCommit: base,
    nodes: [{ taskID: task.id, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [task.id],
    verification: task.proposal.verification,
    acceptance: task.proposal.acceptance,
  }
  const submitted = runner.submit(input, "owner")
  const planID = submitted.planID
  const firstAttemptID = "724f0384-9018-49e4-8fbe-7e5e999a9db1"
  const secondAttemptID = "861b2337-8558-4c9a-8311-78a57a790c7d"
  repository.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_attempts(
        id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,
        artifact,policy,state,started_at,tool_count,retry_count
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0)`,
    )
    insert.run(
      firstAttemptID,
      planID,
      projectDirectory,
      taskID,
      1,
      "session-first",
      "message-first",
      workerWorkspace,
      base,
      first,
      "{}",
      1,
    )
    insert.run(
      secondAttemptID,
      planID,
      projectDirectory,
      taskID,
      2,
      "session-second",
      "message-second",
      workerWorkspace,
      first,
      second,
      "{}",
      2,
    )
    db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
      second,
      planID,
      taskID,
    )
    db.query("UPDATE runner_plans SET artifact=? WHERE id=?").run(second, planID)
  })
  const resolver = new CodeReviewResolver(repository, runner, "project")
  return {
    databasePath,
    projectDirectory,
    workerWorkspace,
    repository,
    runner,
    resolver,
    taskID,
    planID,
    firstAttemptID,
    secondAttemptID,
    base,
    first,
    second,
  }
}
