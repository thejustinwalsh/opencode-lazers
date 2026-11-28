import { afterEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { Effect, Scope } from "effect"
import { openStream } from "../../streams/client.ts"
import { readerPool, type ReaderPool } from "../../streams/pool.ts"
import { registerStreams } from "../../streams/rpc.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { CodeReviewResolver } from "./resolver.ts"
import { codeReviewFilesSource } from "../../streams/sources/code-review.ts"
import { codeReviewFilesRef } from "../../streams/sources/code-review-ref.ts"
import { registerCodeReview } from "./rpc.ts"
import {
  git,
  gitInput,
  makeCodeReviewFixture,
  type CodeReviewFixture,
} from "../analysis/test-fixture.ts"

const roots: string[] = []
const repositories: TaskRepository[] = []
const pools: ReaderPool[] = []

test("GUI consumer reference exposes the complete comparison file inventory", () => {
  expect(codeReviewFilesRef.name).toBe("codeReview.files")
  expect(codeReviewFilesRef.columns.path).toBe("text")
  expect(codeReviewFilesRef.columns.changed).toBe("bool")
})

async function streamSideRows(
  fixture: CodeReviewFixture,
  comparisonID: string,
  side: "base" | "head" | "staged" | "unstaged" | "untracked",
) {
  const pool = readerPool(fixture.databasePath, { workers: 1 })
  pools.push(pool)
  const stream = openStream(pool, codeReviewFilesSource, {
    filter: {
      projectDirectory: fixture.projectDirectory,
      comparisonID,
      side,
      scope: { kind: "project", sessionID: "owner" },
    },
    order: "path",
    window: 100,
    transport: "copy",
  })
  await stream.ready()
  const rows = new Map(
    stream.items.map((item) => [
      item.path as string,
      {
        kind: item.kind,
        status: item.status,
        changed: item.changed,
        size: item.size,
        objectID: item.object_id,
      },
    ]),
  )
  stream.close()
  return rows
}

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close()
  for (const repository of repositories.splice(0)) repository.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("Task, Attempt, Since review and Plan comparisons resolve pinned revisions and full inventories", async () => {
  const f = makeCodeReviewFixture({ roots, repositories })
  const signal = new AbortController().signal
  const task = await f.resolver.resolve({ taskID: f.taskID, mode: "task" } as never, signal)
  expect(task.identity.baseRevision).toBe(f.base)
  expect(task.identity.headRevision).toBe(f.second)
  expect(task.changedCount).toBe(2)

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
  expect(plan.planContext?.taskFiles[f.taskID]).toContain("src/new-empty.ts")

  const baseFile = f.resolver.store.file(task.identity.comparisonID, "base", "src/a.ts")
  expect(baseFile?.changed).toBe(true)
  const unchangedConfig = f.resolver.store.file(task.identity.comparisonID, "head", "package.json")
  const unchangedIgnore = f.resolver.store.file(task.identity.comparisonID, "head", ".gitignore")
  expect(unchangedConfig?.changed).toBe(false)
  expect(unchangedIgnore?.changed).toBe(false)
  expect(f.resolver.store.file(task.identity.comparisonID, "head", "package.json")?.size).toBe(
    '{"name":"review-fixture"}\n'.length,
  )
  expect(f.resolver.store.file(task.identity.comparisonID, "head", "src/empty.ts")?.size).toBe(0)

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
  const f = makeCodeReviewFixture({ roots, repositories })
  writeFileSync(join(f.workerWorkspace, "src/image.png"), new Uint8Array([0, 1, 2, 3]))
  writeFileSync(join(f.workerWorkspace, "src/textual.png"), "looks like text\n")
  symlinkSync("target.ts", join(f.workerWorkspace, "src/link.ts"))
  const comparison = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  const binary = f.resolver.sourceIdentity(comparison, "untracked", "src/image.png")
  const textualBinary = f.resolver.sourceIdentity(comparison, "untracked", "src/textual.png")
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
  expect(await f.resolver.shape(textualBinary, new AbortController().signal)).toMatchObject({
    exists: true,
    kind: "binary",
    size: "looks like text\n".length,
  })
  expect(f.resolver.store.blob(binary.revision)).toBeUndefined()
  expect(f.resolver.store.blob(textualBinary.revision)).toBeUndefined()
  expect(f.resolver.store.blob(symlink.revision)).toBeUndefined()

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
  const f = makeCodeReviewFixture({ roots, repositories })
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
  const f = makeCodeReviewFixture({ roots, repositories })
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

test("Live normalizes staged and unstaged deletions and reports unmerged index conflicts", async () => {
  const f = makeCodeReviewFixture({ roots, repositories })
  rmSync(join(f.workerWorkspace, "src/unstaged.ts"))
  git(f.workerWorkspace, "rm", "src/staged.ts")
  const deleted = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  const stagedRows = await streamSideRows(f, deleted.identity.comparisonID, "staged")
  const unstagedRows = await streamSideRows(f, deleted.identity.comparisonID, "unstaged")
  expect(stagedRows.get("src/staged.ts")).toMatchObject({
    kind: "absent",
    status: "deleted",
    changed: true,
    objectID: null,
  })
  expect(unstagedRows.get("src/staged.ts")).toMatchObject({
    kind: "absent",
    status: "unchanged",
    changed: false,
  })
  expect(unstagedRows.get("src/unstaged.ts")).toMatchObject({
    kind: "absent",
    status: "deleted",
    changed: true,
    objectID: null,
  })

  git(f.workerWorkspace, "update-index", "--force-remove", "src/a.ts")
  const conflictEntries = [f.base, f.first, f.second]
    .map(
      (revision, index) =>
        `100644 ${git(f.projectDirectory, "rev-parse", `${revision}:src/a.ts`)} ${index + 1}\tsrc/a.ts`,
    )
    .join("\n")
  gitInput(f.workerWorkspace, ["update-index", "--index-info"], `${conflictEntries}\n`)
  const conflicted = await f.resolver.resolve(
    { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
    new AbortController().signal,
  )
  const conflictedStaged = await streamSideRows(f, conflicted.identity.comparisonID, "staged")
  const conflictedUnstaged = await streamSideRows(f, conflicted.identity.comparisonID, "unstaged")
  expect(conflictedStaged.get("src/a.ts")).toMatchObject({
    kind: "unknown",
    status: "conflicted",
    changed: true,
  })
  expect(conflictedUnstaged.get("src/a.ts")).toMatchObject({
    kind: "text",
    status: "conflicted",
    changed: true,
  })
})

test("side inventories page unchanged files and source windows keep exact historical content", async () => {
  const f = makeCodeReviewFixture({ roots, repositories })
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
  const sizes = new Map(stream.items.map((item) => [item.path as string, item.size]))
  while (stream.after !== 0) {
    await stream.slide(2)
    for (const item of stream.items) {
      const path = item.path as string
      paths.add(path)
      sizes.set(path, item.size)
    }
  }
  stream.close()
  expect(paths.size).toBe(comparison.fileCount)
  expect(paths.has("package.json")).toBe(true)
  expect(paths.has(".gitignore")).toBe(true)
  expect(sizes.get("package.json")).toBe('{"name":"review-fixture"}\n'.length)
  expect(sizes.get("src/empty.ts")).toBe(0)

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
  const f = makeCodeReviewFixture({ roots, repositories })
  const staged = join(f.workerWorkspace, "src/staged.ts")
  writeFileSync(staged, "export const staged = 2\n")
  git(f.workerWorkspace, "add", "src/staged.ts")
  writeFileSync(join(f.workerWorkspace, "src/a.ts"), "export const answer = 4\n")
  writeFileSync(join(f.workerWorkspace, "src/untracked.ts"), "export const local = 1\n")
  writeFileSync(join(f.workerWorkspace, "bun.lock"), "lockfile v1\n")
  writeFileSync(join(f.workerWorkspace, ".prettierrc"), '{"singleQuote":true}\n')
  writeFileSync(join(f.workerWorkspace, "main.cjs"), "module.exports = 1\n")
  writeFileSync(join(f.workerWorkspace, "code.cxx"), "int main() { return 0; }\n")
  writeFileSync(join(f.workerWorkspace, "src/custom-language"), "custom text source\n")
  writeFileSync(join(f.workerWorkspace, ".env"), "API_TOKEN=must-not-persist\n")
  writeFileSync(join(f.workerWorkspace, ".env.example"), "API_TOKEN=example\n")

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
  const cjsSource = f.resolver.sourceIdentity(first, "untracked", "main.cjs")
  const cxxSource = f.resolver.sourceIdentity(first, "untracked", "code.cxx")
  const extensionlessSource = f.resolver.sourceIdentity(first, "untracked", "src/custom-language")
  const secretSource = f.resolver.sourceIdentity(first, "untracked", ".env")
  const exampleSource = f.resolver.sourceIdentity(first, "untracked", ".env.example")
  const readLine = (source: typeof cjsSource) =>
    f.resolver.sourceWindow(
      { source, startLine: 1, endLine: 1 } as never,
      new AbortController().signal,
    )
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
  expect((await readLine(cjsSource)).text).toBe("module.exports = 1\n")
  expect((await readLine(cxxSource)).text).toBe("int main() { return 0; }\n")
  expect((await readLine(extensionlessSource)).text).toBe("custom text source\n")
  expect((await readLine(exampleSource)).text).toBe("API_TOKEN=example\n")
  expect(await f.resolver.shape(secretSource, new AbortController().signal)).toMatchObject({
    kind: "unknown",
    lineCount: null,
  })
  expect(f.resolver.store.blob(secretSource.revision)).toBeUndefined()
  await expect(readLine(secretSource)).rejects.toThrow("binary or unavailable as text")
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
  expect((await readLine(cjsSource)).text).toBe("module.exports = 1\n")
  expect((await readLine(extensionlessSource)).text).toBe("custom text source\n")
  await expect(
    f.resolver.resolve(
      { taskID: f.taskID, mode: "live", attemptID: f.secondAttemptID } as never,
      new AbortController().signal,
    ),
  ).rejects.toThrow("no workspace was recreated")
})

test("cancelled and cross-project pinned reads cannot persist or disclose comparison content", async () => {
  const f = makeCodeReviewFixture({ roots, repositories })
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

test("registered comparison RPCs and file streams enforce project read authorization", async () => {
  const f = makeCodeReviewFixture({ roots, repositories })
  const handlers: Record<string, (input: unknown) => unknown> = {}
  const permissionCalls: {
    sessionID: string
    agent: string
    action: string
    resources: string[]
  }[] = []
  let contractID = ""
  const ctx = {
    rpc: {
      register: (definition: { id: string }, methods: object) => {
        contractID = definition.id
        Object.assign(handlers, methods)
        return Effect.succeed({})
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: sessionID === "ses_foreign" ? "another-project" : "project",
          agent: "lazers-architect",
        }),
    },
    permission: {
      assert: (input: {
        sessionID: string
        agent: string
        action: string
        resources: string[]
      }) => {
        permissionCalls.push(input)
        return input.sessionID === "ses_denied"
          ? Effect.fail(new Error("read denied"))
          : Effect.void
      },
    },
  }
  await Effect.runPromise(
    Effect.scoped(registerCodeReview(ctx as never, f.repository, f.runner, "project")),
  )
  expect(contractID).toBe("lazers.codeReview")
  const call = (method: string, input: unknown) => {
    const handler = handlers[method]
    if (!handler) throw new Error(`RPC method ${method} was not registered`)
    return Effect.runPromise(handler(input) as Effect.Effect<unknown, never, never>)
  }
  const countComparisons = () =>
    f.repository.read(
      (db) =>
        db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM code_review_comparisons")
          .get()!.count,
    )
  const request = (sessionID: string) => ({ sessionID, taskID: f.taskID, mode: "task" })
  await expect(call("resolve", request("ses_denied"))).rejects.toThrow("read denied")
  await expect(call("resolve", request("ses_foreign"))).rejects.toThrow(
    "Code review scope is unavailable",
  )
  expect(countComparisons()).toBe(0)
  const comparison = (await call("resolve", request("ses_authorized"))) as Awaited<
    ReturnType<CodeReviewResolver["resolve"]>
  >
  expect(comparison.identity.projectID).toBe("project")
  expect(countComparisons()).toBe(1)
  expect(permissionCalls).toEqual([
    {
      sessionID: "ses_denied",
      agent: "lazers-architect",
      action: "read",
      resources: [f.projectDirectory],
    },
    {
      sessionID: "ses_authorized",
      agent: "lazers-architect",
      action: "read",
      resources: [f.projectDirectory],
    },
  ])
  const source = f.resolver.sourceIdentity(comparison, "head", "src/a.ts")
  await expect(call("shape", { sessionID: "ses_foreign", source })).rejects.toThrow(
    "Code review scope is unavailable",
  )

  const pool = readerPool(f.databasePath, { workers: 1 })
  pools.push(pool)
  const streamHandlers: Record<string, (input: never, context: never) => Effect.Effect<unknown>> =
    {}
  const streamReads: string[] = []
  const streamContext = {
    projectID: "project",
    projectDirectory: f.projectDirectory,
    projectIds: (id: string) => [id],
    assertRead: async (sessionID: string) => {
      streamReads.push(sessionID)
      if (sessionID === "ses_denied") throw new Error("stream read denied")
    },
    read: <T>(run: (db: Database) => T) => f.repository.read(run),
  }
  const streamScope = Effect.runSync(Scope.make())
  const streamRPC = {
    rpc: {
      register: (_definition: unknown, methods: object) => {
        Object.assign(streamHandlers, methods)
        return Effect.succeed({ events: { emit: () => Effect.void } })
      },
    },
  }
  await Effect.runPromise(
    registerStreams(streamRPC as never, {
      databasePath: f.databasePath,
      pool,
      context: streamContext,
    }).pipe(Scope.provide(streamScope)),
  )
  const input = (stream: string, sessionID: string) => ({
    stream,
    source: "codeReview.files",
    filter: {
      comparisonID: comparison.identity.comparisonID,
      side: "head",
      scope: { kind: "project", sessionID },
      projectDirectory: "/attacker-controlled",
    },
    order: "path",
    window: 2,
  })
  const streamCall = (method: string, request: unknown) => {
    const handler = streamHandlers[method]
    if (!handler) throw new Error(`Stream method ${method} was not registered`)
    return Effect.runPromise(
      handler(
        request as never,
        {
          error: (_type: string, message: string) => new Error(message),
        } as never,
      ),
    )
  }
  await expect(streamCall("open", input("denied", "ses_denied"))).rejects.toThrow(
    "stream read denied",
  )
  const frame = (await streamCall("open", input("authorized", "ses_authorized"))) as {
    data: string
  }
  expect(frame.data.length).toBeGreaterThan(0)
  expect(streamReads).toEqual(["ses_denied", "ses_authorized"])

  const other = new TaskRepository(f.databasePath, join(f.projectDirectory, "other"))
  repositories.push(other)
  const foreignHandlers: typeof streamHandlers = {}
  const foreignScope = Effect.runSync(Scope.make())
  const foreignContext = {
    ...streamContext,
    projectID: "another-project",
    projectDirectory: other.projectDirectory,
    read: <T>(run: (db: Database) => T) => other.read(run),
  }
  const foreignRPC = {
    rpc: {
      register: (_definition: unknown, methods: object) => {
        Object.assign(foreignHandlers, methods)
        return Effect.succeed({ events: { emit: () => Effect.void } })
      },
    },
  }
  await Effect.runPromise(
    registerStreams(foreignRPC as never, {
      databasePath: f.databasePath,
      pool,
      context: foreignContext,
    }).pipe(Scope.provide(foreignScope)),
  )
  const foreignOpen = foreignHandlers.open!
  await expect(
    Effect.runPromise(
      foreignOpen(
        input("foreign", "ses_authorized") as never,
        { error: (_type: string, message: string) => new Error(message) } as never,
      ),
    ),
  ).rejects.toThrow("Code review comparison is unavailable")
  await Effect.runPromise(Scope.close(streamScope, { _tag: "Success", value: undefined } as never))
  await Effect.runPromise(Scope.close(foreignScope, { _tag: "Success", value: undefined } as never))
})
