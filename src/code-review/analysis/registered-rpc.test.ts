import { afterEach, expect, test } from "bun:test"
import { rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { CodeReviewResolver } from "../comparisons/resolver.ts"
import { registerCodeReview } from "../comparisons/rpc.ts"
import { git, makeCodeReviewFixture, type CodeReviewFixtureResources } from "./test-fixture.ts"

const resources: CodeReviewFixtureResources = { roots: [], repositories: [] }

function register(fixture: ReturnType<typeof makeCodeReviewFixture>) {
  const handlers: Record<string, (input: unknown) => unknown> = {}
  const context = {
    rpc: {
      register: (_definition: unknown, methods: object) => {
        Object.assign(handlers, methods)
        return Effect.succeed({})
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: sessionID === "ses-foreign" ? "another-project" : "project",
          agent: "lazers-architect",
        }),
    },
    permission: { assert: () => Effect.void },
  }
  const ready = Effect.runPromise(
    Effect.scoped(
      registerCodeReview(context as never, fixture.repository, fixture.runner, "project"),
    ),
  )
  const call = async (method: string, input: unknown, signal?: AbortSignal) => {
    await ready
    const handler = handlers[method]
    if (!handler) throw new Error(`Code review method ${method} was not registered`)
    return Effect.runPromise(handler(input) as Effect.Effect<unknown, never, never>, { signal })
  }
  return call
}

afterEach(async () => {
  for (const repository of resources.repositories.splice(0)) repository.close()
  for (const root of resources.roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("registered structural reads preserve pinned content, absent sides, and independent source paths", async () => {
  const fixture = makeCodeReviewFixture(resources)
  const call = register(fixture)
  const comparison = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "task",
  })) as { identity: { comparisonID: string } }

  const source = await call("structural", {
    sessionID: "ses-review",
    comparisonID: comparison.identity.comparisonID,
    path: "src/a.ts",
  })
  expect(source).toMatchObject({
    status: "ready",
    reason: null,
    baseSource: { side: "base", path: "src/a.ts", revision: expect.any(String) },
    headSource: { side: "head", path: "src/a.ts", revision: expect.any(String) },
    diff: { engineVersion: "0.71.0", status: "changed" },
  })
  const repeated = await call("structural", {
    sessionID: "ses-review",
    comparisonID: comparison.identity.comparisonID,
    path: "src/a.ts",
  })
  expect(repeated).toEqual(source)
  await expect(
    call("structural", {
      sessionID: "ses-foreign",
      comparisonID: comparison.identity.comparisonID,
      path: "src/a.ts",
    }),
  ).rejects.toThrow("Code review scope is unavailable")

  const addition = (await call("structural", {
    sessionID: "ses-review",
    comparisonID: comparison.identity.comparisonID,
    path: "src/new-empty.ts",
  })) as { status: string; baseSource: unknown; diff: { status: string } }
  expect(addition).toMatchObject({ status: "ready", baseSource: null, diff: { status: "created" } })

  const renamed = (await call("structural", {
    sessionID: "ses-review",
    comparisonID: comparison.identity.comparisonID,
    previousPath: "src/a.ts",
    path: "src/new-empty.ts",
  })) as {
    baseSource: { path: string } | null
    headSource: { path: string } | null
    diff: { path: string; previousPath?: string }
  }
  expect(renamed.baseSource?.path).toBe("src/a.ts")
  expect(renamed.headSource?.path).toBe("src/new-empty.ts")
  expect(renamed.diff).toMatchObject({ path: "src/new-empty.ts", previousPath: "src/a.ts" })

  await expect(
    call("structural", {
      sessionID: "ses-review",
      comparisonID: comparison.identity.comparisonID,
      baseSide: "staged",
      path: "src/a.ts",
    }),
  ).rejects.toThrow("Selected side is unavailable")
  await expect(
    call("structural", {
      sessionID: "ses-review",
      comparisonID: comparison.identity.comparisonID,
      path: "src/not-in-inventory.ts",
    }),
  ).rejects.toThrow("Path is not present")

  git(fixture.projectDirectory, "rm", "src/a.ts")
  git(fixture.projectDirectory, "commit", "-m", "delete source")
  const deletedRevision = git(fixture.projectDirectory, "rev-parse", "HEAD")
  fixture.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET artifact=? WHERE id=?")
      .run(deletedRevision, fixture.secondAttemptID),
  )
  const deletionComparison = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "attempt",
    attemptID: fixture.secondAttemptID,
  })) as { identity: { comparisonID: string } }
  const deletion = await call("structural", {
    sessionID: "ses-review",
    comparisonID: deletionComparison.identity.comparisonID,
    path: "src/a.ts",
  })
  expect(deletion).toMatchObject({
    status: "ready",
    baseSource: { side: "base", path: "src/a.ts" },
    headSource: null,
    diff: { status: "deleted" },
  })
})

test("registered structural reads cover task, attempt, since, live, plan, and captured live sides", async () => {
  const fixture = makeCodeReviewFixture(resources)
  writeFileSync(join(fixture.workerWorkspace, "src/staged.ts"), "export const staged = 2\n")
  git(fixture.workerWorkspace, "add", "src/staged.ts")
  writeFileSync(join(fixture.workerWorkspace, "src/unstaged.ts"), "export const dirty = 2\n")
  writeFileSync(join(fixture.workerWorkspace, "src/untracked.ts"), "export const local = 1\n")
  const call = register(fixture)
  const selections = [
    { taskID: fixture.taskID, mode: "task" },
    { taskID: fixture.taskID, mode: "attempt", attemptID: fixture.secondAttemptID },
    {
      taskID: fixture.taskID,
      mode: "since",
      baseAttemptID: fixture.firstAttemptID,
      headAttemptID: fixture.secondAttemptID,
    },
    { taskID: fixture.taskID, mode: "live", attemptID: fixture.secondAttemptID },
    { taskID: fixture.taskID, mode: "plan", planID: fixture.planID },
  ] as const

  for (const selection of selections) {
    const comparison = (await call("resolve", {
      sessionID: "ses-review",
      ...selection,
    })) as { identity: { comparisonID: string } }
    const structural = await call("structural", {
      sessionID: "ses-review",
      comparisonID: comparison.identity.comparisonID,
      path: "src/a.ts",
    })
    expect(structural).toMatchObject({
      status: "ready",
      comparison: { comparisonID: comparison.identity.comparisonID },
      baseSource: { side: "base" },
      headSource: { side: "head" },
    })
  }

  const live = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "live",
    attemptID: fixture.secondAttemptID,
  })) as { identity: { comparisonID: string } }
  const readLiveSides = (input: {
    baseSide: "head" | "staged" | "untracked"
    headSide: "staged" | "unstaged" | "untracked"
    path: string
  }) =>
    call("structural", {
      sessionID: "ses-review",
      comparisonID: live.identity.comparisonID,
      ...input,
    })
  expect(
    await readLiveSides({ baseSide: "head", headSide: "staged", path: "src/staged.ts" }),
  ).toMatchObject({
    status: "ready",
    baseSource: { side: "head" },
    headSource: { side: "staged" },
  })
  expect(
    await readLiveSides({
      baseSide: "staged",
      headSide: "unstaged",
      path: "src/unstaged.ts",
    }),
  ).toMatchObject({
    status: "ready",
    baseSource: { side: "staged" },
    headSource: { side: "unstaged" },
  })
  expect(
    await readLiveSides({
      baseSide: "untracked",
      headSide: "untracked",
      path: "src/untracked.ts",
    }),
  ).toMatchObject({
    status: "ready",
    baseSource: { side: "untracked" },
    headSource: { side: "untracked" },
  })
})

test("structural source policy separates binary, confidential, and unavailable live snapshots", async () => {
  const fixture = makeCodeReviewFixture(resources)
  writeFileSync(join(fixture.workerWorkspace, "image.png"), new Uint8Array([0, 1, 2, 3]))
  writeFileSync(join(fixture.workerWorkspace, ".env"), "API_TOKEN=must-not-persist\n")
  writeFileSync(join(fixture.workerWorkspace, "captured.ts"), "export const live = 1\n")
  symlinkSync("target.ts", join(fixture.workerWorkspace, "link.ts"))
  const call = register(fixture)
  const comparison = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "live",
    attemptID: fixture.secondAttemptID,
  })) as { identity: { comparisonID: string } }
  const structural = (path: string) =>
    call("structural", {
      sessionID: "ses-review",
      comparisonID: comparison.identity.comparisonID,
      baseSide: "untracked",
      headSide: "untracked",
      path,
    })
  expect(await structural("image.png")).toMatchObject({
    status: "unavailable",
    reason: "binary",
    diff: null,
  })
  expect(await structural(".env")).toMatchObject({
    status: "unavailable",
    reason: "confidential",
    diff: null,
  })
  expect(await structural("link.ts")).toMatchObject({
    status: "unavailable",
    reason: "unsupported-kind",
    diff: null,
  })

  const liveFile = fixture.resolver.store.file(
    comparison.identity.comparisonID,
    "untracked",
    "captured.ts",
  )
  expect(liveFile?.objectID).toMatch(/^sha256:/)
  fixture.repository.atomic((db) =>
    db
      .query("DELETE FROM code_review_blobs WHERE project_directory=? AND blob_id=?")
      .run(fixture.projectDirectory, liveFile!.objectID!),
  )
  expect(await structural("captured.ts")).toMatchObject({
    status: "unavailable",
    reason: "source-unavailable",
    diff: null,
  })
})

test("registered reviewed baselines are idempotent, paged, immutable, and pin same-attempt history", async () => {
  const fixture = makeCodeReviewFixture(resources)
  const call = register(fixture)
  const firstComparison = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "attempt",
    attemptID: fixture.firstAttemptID,
  })) as { identity: { comparisonID: string } }
  await expect(
    call("resolve", {
      sessionID: "ses-review",
      taskID: fixture.taskID,
      mode: "since",
      baseComparisonID: firstComparison.identity.comparisonID,
      headAttemptID: fixture.firstAttemptID,
    }),
  ).rejects.toThrow("not a reviewed baseline")

  const baseline = await call("markReviewed", {
    sessionID: "ses-review",
    comparisonID: firstComparison.identity.comparisonID,
    requestID: "review-first",
  })
  expect(
    await call("markReviewed", {
      sessionID: "ses-review",
      comparisonID: firstComparison.identity.comparisonID,
      requestID: "review-first",
    }),
  ).toEqual(baseline)

  fixture.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET artifact=? WHERE id=?")
      .run(fixture.second, fixture.firstAttemptID),
  )
  const advanced = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "attempt",
    attemptID: fixture.firstAttemptID,
  })) as { identity: { comparisonID: string } }
  const since = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "since",
    baseComparisonID: firstComparison.identity.comparisonID,
    headAttemptID: fixture.firstAttemptID,
  })) as {
    identity: { baseRevision: string | null; headRevision: string | null }
  }
  expect(since.identity).toMatchObject({
    baseRevision: fixture.first,
    headRevision: fixture.second,
  })

  const secondBaseline = await call("markReviewed", {
    sessionID: "ses-review",
    comparisonID: advanced.identity.comparisonID,
    requestID: "review-advanced",
  })
  const firstPage = (await call("reviewed", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    limit: 1,
  })) as { baselines: Array<{ comparisonID: string }>; nextCursor: unknown }
  expect(firstPage.baselines).toHaveLength(1)
  expect(firstPage.baselines[0]?.comparisonID).toBe(firstComparison.identity.comparisonID)
  expect(firstPage.nextCursor).not.toBeNull()
  const secondPage = (await call("reviewed", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    limit: 1,
    cursor: firstPage.nextCursor,
  })) as { baselines: Array<{ comparisonID: string }>; nextCursor: unknown }
  expect(secondPage.baselines).toHaveLength(1)
  expect(secondPage.baselines[0]?.comparisonID).toBe(advanced.identity.comparisonID)
  expect(secondPage.nextCursor).toBeNull()
  expect(secondBaseline).toMatchObject({ identity: { headRevision: fixture.second } })

  await expect(
    call("markReviewed", {
      sessionID: "ses-review",
      comparisonID: advanced.identity.comparisonID,
      requestID: "review-first",
    }),
  ).rejects.toThrow("already used")

  rmSync(fixture.workerWorkspace, { recursive: true, force: true })
  const afterCleanup = await call("structural", {
    sessionID: "ses-review",
    comparisonID: firstComparison.identity.comparisonID,
    path: "src/a.ts",
  })
  expect(afterCleanup).toMatchObject({
    status: "ready",
    baseSource: { revision: expect.any(String) },
    headSource: { revision: expect.any(String) },
  })
})

test("registered structural analysis keeps cancellation and concurrent viewers independent", async () => {
  const fixture = makeCodeReviewFixture(resources)
  const call = register(fixture)
  const earlier = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "attempt",
    attemptID: fixture.secondAttemptID,
  })) as { identity: { comparisonID: string } }
  const largeContent = `export const values = [${Array.from({ length: 5000 }, (_, index) => index).join(",")}]\n`
  writeFileSync(join(fixture.projectDirectory, "src/large.ts"), largeContent)
  git(fixture.projectDirectory, "add", "src/large.ts")
  git(fixture.projectDirectory, "commit", "-m", "add large source")
  const largeRevision = git(fixture.projectDirectory, "rev-parse", "HEAD")
  fixture.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET artifact=? WHERE id=?")
      .run(largeRevision, fixture.secondAttemptID),
  )
  const comparison = (await call("resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    mode: "attempt",
    attemptID: fixture.secondAttemptID,
  })) as { identity: { comparisonID: string } }
  const earlierInput = {
    sessionID: "ses-review",
    comparisonID: earlier.identity.comparisonID,
    path: "src/a.ts",
  }
  const input = {
    sessionID: "ses-review",
    comparisonID: comparison.identity.comparisonID,
    path: "src/a.ts",
  }
  const concurrent = await Promise.all([
    call("structural", earlierInput),
    call("structural", input),
  ])
  expect(concurrent[0]).toMatchObject({
    status: "ready",
    comparison: { comparisonID: earlier.identity.comparisonID },
    sourceID: expect.any(String),
  })
  expect(concurrent[1]).toMatchObject({
    status: "ready",
    comparison: { comparisonID: comparison.identity.comparisonID },
    sourceID: expect.any(String),
  })
  const sourceIDs = concurrent.map((result) => (result as { sourceID: string }).sourceID)
  expect(sourceIDs[0]).not.toBe(sourceIDs[1])
  const concurrentViewers = await Promise.all([
    call("structural", input),
    call("structural", input),
  ])
  expect(concurrentViewers[0]).toMatchObject({ status: "ready" })
  expect(concurrentViewers[1]).toEqual(concurrentViewers[0])

  const controller = new AbortController()
  const cancelled = call(
    "structural",
    {
      sessionID: "ses-review",
      comparisonID: comparison.identity.comparisonID,
      path: "src/large.ts",
    },
    controller.signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await expect(cancelled).rejects.toThrow()
})

test("the reviewed-baseline schema upgrade preserves existing comparison rows", async () => {
  const fixture = makeCodeReviewFixture(resources)
  const comparison = await fixture.resolver.resolve(
    { taskID: fixture.taskID, mode: "task" } as never,
    new AbortController().signal,
  )
  fixture.repository.atomic((db) => {
    db.exec(`
      DROP TABLE code_review_reviewed_requests;
      DROP TABLE code_review_reviewed_baselines;
      UPDATE schema_modules SET generation=1 WHERE module='code-review';
    `)
  })
  const upgraded = new CodeReviewResolver(fixture.repository, fixture.runner, "project")
  expect(upgraded.store.comparison(comparison.identity.comparisonID)).toEqual(comparison)
  expect(
    upgraded.store.file(comparison.identity.comparisonID, "head", "src/a.ts")?.objectID,
  ).not.toBeNull()
  expect(
    fixture.repository.read(
      (db) =>
        db
          .query<{ generation: number }, [string]>(
            "SELECT generation FROM schema_modules WHERE module=?",
          )
          .get("code-review")?.generation,
    ),
  ).toBe(2)
})
