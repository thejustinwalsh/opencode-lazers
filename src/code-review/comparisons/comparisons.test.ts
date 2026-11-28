import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { openStream } from "../../streams/client.ts"
import { readerPool, type ReaderPool } from "../../streams/pool.ts"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { CodeReviewResolver } from "./resolver.ts"
import { codeReviewFilesSource } from "../../streams/sources/code-review.ts"
import { codeReviewFilesRef } from "../../streams/sources/code-review-ref.ts"

const roots: string[] = []
const repositories: TaskRepository[] = []
const pools: ReaderPool[] = []

test("GUI consumer reference exposes the complete comparison file inventory", () => {
  expect(codeReviewFilesRef.name).toBe("codeReview.files")
  expect(codeReviewFilesRef.columns.path).toBe("text")
  expect(codeReviewFilesRef.columns.changed).toBe("bool")
})

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-code-review-"))
  roots.push(directory)
  const projectDirectory = join(directory, "project")
  mkdirSync(projectDirectory)
  git(projectDirectory, "init", "--initial-branch=main")
  git(projectDirectory, "config", "user.name", "Code Review Test")
  git(projectDirectory, "config", "user.email", "code-review-test@example.invalid")
  mkdirSync(join(projectDirectory, "src"))
  writeFileSync(join(projectDirectory, ".gitignore"), "ignored-output/\n")
  writeFileSync(join(projectDirectory, "package.json"), '{"name":"review-fixture"}\n')
  writeFileSync(join(projectDirectory, "src/a.ts"), "export const answer = 1\n")
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
  git(projectDirectory, "add", "src/a.ts")
  git(projectDirectory, "commit", "-m", "repair artifact")
  const second = git(projectDirectory, "rev-parse", "HEAD")

  const workerWorkspace = join(directory, "worker-worktree")
  git(projectDirectory, "worktree", "add", "--detach", workerWorkspace, second)
  const databasePath = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(databasePath, projectDirectory)
  repositories.push(repository)
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

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close()
  for (const repository of repositories.splice(0)) repository.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("Task, Attempt, Since review and Plan comparisons resolve pinned revisions and full inventories", async () => {
  const f = makeFixture()
  const signal = new AbortController().signal
  const task = await f.resolver.resolve({ taskID: f.taskID, mode: "task" } as never, signal)
  expect(task.identity.baseRevision).toBe(f.base)
  expect(task.identity.headRevision).toBe(f.second)
  expect(task.changedCount).toBe(1)

  const attempt = await f.resolver.resolve(
    { taskID: f.taskID, mode: "attempt", attemptID: f.secondAttemptID } as never,
    signal,
  )
  expect(attempt.identity.baseRevision).toBe(f.first)
  expect(attempt.identity.headRevision).toBe(f.second)

  const since = await f.resolver.resolve(
    {
      taskID: f.taskID,
      mode: "since",
      baseAttemptID: f.firstAttemptID,
      headAttemptID: f.secondAttemptID,
    } as never,
    signal,
  )
  expect(since.identity.baseRevision).toBe(f.first)
  expect(since.identity.headRevision).toBe(f.second)

  const plan = await f.resolver.resolve(
    { taskID: f.taskID, mode: "plan", planID: f.planID } as never,
    signal,
  )
  expect(plan.identity.baseRevision).toBe(f.base)
  expect(plan.identity.headRevision).toBe(f.second)
  expect(plan.planContext?.taskIDs).toEqual([f.taskID])
  expect(plan.planContext?.taskFiles[f.taskID]).toContain("src/a.ts")

  const baseFile = f.resolver.store.file(task.identity.comparisonID, "base", "src/a.ts")
  expect(baseFile?.changed).toBe(true)
  const unchangedConfig = f.resolver.store.file(task.identity.comparisonID, "head", "package.json")
  const unchangedIgnore = f.resolver.store.file(task.identity.comparisonID, "head", ".gitignore")
  expect(unchangedConfig?.changed).toBe(false)
  expect(unchangedIgnore?.changed).toBe(false)

  const history = await f.resolver.history({ taskID: f.taskID }, signal)
  expect(history.revisions.map((revision) => revision.attemptID)).toEqual([
    f.firstAttemptID,
    f.secondAttemptID,
  ])
  expect(history.nextCursor).toBeNull()
  expect(
    f.repository.read(
      (db) =>
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM code_review_blobs").get()!
          .count,
    ),
  ).toBe(0)
  const firstPage = await f.resolver.history({ taskID: f.taskID, limit: 1 }, signal)
  expect(firstPage.revisions).toHaveLength(1)
  expect(firstPage.nextCursor).not.toBeNull()
  const secondPage = await f.resolver.history(
    { taskID: f.taskID, limit: 1, cursor: firstPage.nextCursor! },
    signal,
  )
  expect(secondPage.revisions).toHaveLength(1)
  expect(secondPage.revisions[0]?.attemptID).toBe(f.secondAttemptID)
  expect(secondPage.nextCursor).toBeNull()
  f.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET started_at=10 WHERE project_directory=? AND task_id=?")
      .run(f.projectDirectory, f.taskID),
  )
  await expect(
    f.resolver.resolve(
      {
        taskID: f.taskID,
        mode: "since",
        baseAttemptID: f.secondAttemptID,
        headAttemptID: f.firstAttemptID,
      } as never,
      signal,
    ),
  ).rejects.toThrow("must not follow")
})

test("Live shape preserves binary and symlink metadata after the workspace is removed", async () => {
  const f = makeFixture()
  writeFileSync(join(f.workerWorkspace, "src/image.png"), new Uint8Array([0, 1, 2, 3]))
  symlinkSync("target.ts", join(f.workerWorkspace, "src/link.ts"))
  const comparison = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  const binary = f.resolver.sourceIdentity(comparison, "untracked", "src/image.png")
  const symlink = f.resolver.sourceIdentity(comparison, "untracked", "src/link.ts")
  expect(await f.resolver.shape(binary, new AbortController().signal)).toMatchObject({
    exists: true,
    kind: "binary",
    size: 4,
  })
  expect(await f.resolver.shape(symlink, new AbortController().signal)).toMatchObject({
    exists: true,
    kind: "symlink",
    size: "target.ts".length,
  })

  rmSync(f.workerWorkspace, { recursive: true, force: true })
  expect(await f.resolver.shape(binary, new AbortController().signal)).toMatchObject({
    kind: "binary",
    size: 4,
  })
  expect(await f.resolver.shape(symlink, new AbortController().signal)).toMatchObject({
    kind: "symlink",
    size: "target.ts".length,
  })
})

test("Live shared-workspace snapshots are explicitly unowned", async () => {
  const f = makeFixture()
  f.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET workspace=? WHERE id=?")
      .run(f.projectDirectory, f.secondAttemptID),
  )
  const comparison = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  expect(comparison.identity.attribution).toBe("shared-workspace-unowned")
})

test("Live capture refuses tracked paths that escape through a symlinked parent", async () => {
  const f = makeFixture()
  const outside = join(f.workerWorkspace, "..", "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "a.ts"), "export const escaped = true\n")
  rmSync(join(f.workerWorkspace, "src"), { recursive: true })
  symlinkSync(outside, join(f.workerWorkspace, "src"))
  await expect(
    f.resolver.resolve(
      { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
      new AbortController().signal,
    ),
  ).rejects.toThrow("outside its Git root")
})

test("side inventories page unchanged files and source windows keep exact historical content", async () => {
  const f = makeFixture()
  const comparison = await f.resolver.resolve(
    { taskID: f.taskID, mode: "task" } as never,
    new AbortController().signal,
  )
  const pool = readerPool(f.databasePath, { workers: 1 })
  pools.push(pool)
  const stream = openStream(pool, codeReviewFilesSource, {
    filter: {
      projectDirectory: f.projectDirectory,
      comparisonID: comparison.identity.comparisonID,
      side: "head",
      scope: { kind: "project", sessionID: "owner" },
    },
    order: "path",
    window: 2,
    transport: "copy",
  })
  await stream.ready()
  const paths = new Set(stream.items.map((item) => item.path as string))
  while (stream.after !== 0) {
    await stream.slide(2)
    for (const item of stream.items) paths.add(item.path as string)
  }
  stream.close()
  expect(paths.size).toBe(comparison.fileCount)
  expect(paths.has("package.json")).toBe(true)
  expect(paths.has(".gitignore")).toBe(true)

  const pinned = f.resolver.sourceIdentity(comparison, "base", "src/a.ts")
  const shape = await f.resolver.shape(pinned, new AbortController().signal)
  expect(shape).toMatchObject({ exists: true, kind: "text", lineCount: 1, changed: true })
  const source = await f.resolver.sourceWindow(
    { source: pinned, startLine: 1, endLine: 1 } as never,
    new AbortController().signal,
  )
  expect(source.text).toBe("export const answer = 1\n")
})

test("Live captures staged, unstaged and untracked source immutably without task-ownership claims", async () => {
  const f = makeFixture()
  const staged = join(f.workerWorkspace, "src/staged.ts")
  writeFileSync(staged, "export const staged = 2\n")
  git(f.workerWorkspace, "add", "src/staged.ts")
  writeFileSync(join(f.workerWorkspace, "src/a.ts"), "export const answer = 4\n")
  writeFileSync(join(f.workerWorkspace, "src/untracked.ts"), "export const local = 1\n")
  writeFileSync(join(f.workerWorkspace, "bun.lock"), "lockfile v1\n")
  writeFileSync(join(f.workerWorkspace, ".prettierrc"), '{"singleQuote":true}\n')

  const first = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  expect(first.identity.attribution).toBe("assigned-workspace")
  expect(first.identity.snapshotID).toMatch(/^[0-9a-f]{64}$/)
  expect(
    f.resolver.store.file(first.identity.comparisonID, "staged", "src/staged.ts"),
  ).toMatchObject({
    changed: true,
    status: "modified",
  })
  expect(f.resolver.store.file(first.identity.comparisonID, "unstaged", "src/a.ts")).toMatchObject({
    changed: true,
    status: "modified",
  })
  expect(
    f.resolver.store.file(first.identity.comparisonID, "untracked", "src/untracked.ts"),
  ).toMatchObject({ changed: true, status: "added" })
  expect(
    f.resolver.store.file(first.identity.comparisonID, "unstaged", "package.json"),
  ).toMatchObject({ changed: false, kind: "text" })
  expect(
    f.resolver.store.file(first.identity.comparisonID, "unstaged", ".gitignore"),
  ).toMatchObject({ changed: false, kind: "text" })

  const oldSource = f.resolver.sourceIdentity(first, "unstaged", "src/a.ts")
  const lockSource = f.resolver.sourceIdentity(first, "untracked", "bun.lock")
  const configSource = f.resolver.sourceIdentity(first, "untracked", ".prettierrc")
  writeFileSync(join(f.workerWorkspace, "src/a.ts"), "export const answer = 5\n")
  const second = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  expect(second.identity.snapshotID).not.toBe(first.identity.snapshotID)
  expect(
    (
      await f.resolver.sourceWindow(
        { source: oldSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe("export const answer = 4\n")
  expect(
    (
      await f.resolver.sourceWindow(
        { source: lockSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe("lockfile v1\n")
  expect(
    (
      await f.resolver.sourceWindow(
        { source: configSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe('{"singleQuote":true}\n')
  const newSource = f.resolver.sourceIdentity(second, "unstaged", "src/a.ts")
  expect(
    (
      await f.resolver.sourceWindow(
        { source: newSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe("export const answer = 5\n")

  rmSync(f.workerWorkspace, { recursive: true, force: true })
  expect(
    (
      await f.resolver.sourceWindow(
        { source: oldSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe("export const answer = 4\n")
  expect(
    (
      await f.resolver.sourceWindow(
        { source: lockSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe("lockfile v1\n")
  expect(
    (
      await f.resolver.sourceWindow(
        { source: configSource, startLine: 1, endLine: 1 } as never,
        new AbortController().signal,
      )
    ).text,
  ).toBe('{"singleQuote":true}\n')
  await expect(
    f.resolver.resolve(
      { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
      new AbortController().signal,
    ),
  ).rejects.toThrow("no workspace was recreated")
})

test("cancelled and cross-project pinned reads cannot persist or disclose comparison content", async () => {
  const f = makeFixture()
  const comparison = await f.resolver.resolve(
    { taskID: f.taskID, mode: "task" } as never,
    new AbortController().signal,
  )
  const before = f.repository.read(
    (db) =>
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM code_review_comparisons")
        .get()!.count,
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    f.resolver.resolve({ taskID: f.taskID, mode: "task" } as never, cancelled.signal),
  ).rejects.toThrow()
  const after = f.repository.read(
    (db) =>
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM code_review_comparisons")
        .get()!.count,
  )
  expect(after).toBe(before)

  const other = new TaskRepository(f.databasePath, join(f.projectDirectory, "other"))
  repositories.push(other)
  const foreignResolver = new CodeReviewResolver(other, new RunnerStore(other), "other-project")
  await expect(
    foreignResolver.shape(
      f.resolver.sourceIdentity(comparison, "head", "src/a.ts"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("does not belong to this project")
})
