import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import { CodeReviewStore } from "../comparisons/store.ts"
import { registerCodeReview } from "../comparisons/rpc.ts"
import { CodeReviewResolver } from "../comparisons/resolver.ts"
import {
  git,
  makeCodeReviewFixture,
  type CodeReviewFixtureResources,
} from "../analysis/test-fixture.ts"
import { prepareIntegrationComparison } from "./comparison.ts"
import { CodeReviewIntegrationSchema } from "./contract.ts"
import { registerCodeReviewIntegrations } from "./rpc.ts"
import { CodeReviewIntegrationStore } from "./store.ts"
import { CodeReviewIntegrationTargetStore } from "./target-store.ts"

const resources: CodeReviewFixtureResources = { roots: [], repositories: [] }

function register(fixture: ReturnType<typeof makeCodeReviewFixture>) {
  const handlers = new Map<string, Record<string, (input: unknown) => unknown>>()
  const context = {
    rpc: {
      register: (definition: unknown, methods: object) => {
        const id = (definition as { id: string }).id
        handlers.set(id, methods as Record<string, (input: unknown) => unknown>)
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
      Effect.gen(function* () {
        yield* registerCodeReview(context as never, fixture.repository, fixture.runner, "project")
        yield* registerCodeReviewIntegrations(
          context as never,
          fixture.repository,
          fixture.runner,
          "project",
        )
      }),
    ),
  )
  const call = async (rpcID: string, method: string, input: unknown) => {
    await ready
    const handler = handlers.get(rpcID)?.[method]
    if (!handler) throw new Error(`Missing ${rpcID}.${method} handler`)
    return Effect.runPromise(handler(input) as Effect.Effect<unknown, never, never>)
  }
  return call
}

afterEach(() => {
  for (const repository of resources.repositories.splice(0)) repository.close()
  for (const root of resources.roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("integrated target ranges are paged, authorized, pinned, and readable after Git cleanup", async () => {
  const fixture = makeCodeReviewFixture(resources)
  const targetStore = new CodeReviewIntegrationTargetStore(fixture.repository)
  const created = fixture.repository.atomic((db) =>
    targetStore.createOrExtendIn(db, {
      projectID: "project",
      taskIDs: [fixture.taskID],
      branch: "feature/review",
      baseBranch: "main",
      baseRevision: fixture.base,
      expectedHead: fixture.second,
      currentHead: fixture.second,
      pullRequest: {
        id: "pr-42",
        number: 42,
        url: "https://example.invalid/pull/42",
        title: "Reviewed task",
      },
      now: 2,
    }),
  )
  const integrationID = crypto.randomUUID()
  const createdAt = 3
  const comparison = await prepareIntegrationComparison({
    repository: fixture.repository,
    projectID: "project",
    integrationID,
    taskID: fixture.taskID,
    planID: fixture.planID,
    attemptID: fixture.secondAttemptID,
    baseRevision: fixture.base,
    headRevision: fixture.second,
    capturedAt: createdAt,
  })
  const integration = CodeReviewIntegrationSchema.parse({
    id: integrationID,
    target: created.target,
    taskID: fixture.taskID,
    planID: fixture.planID,
    attemptID: fixture.secondAttemptID,
    sourceBaseRevision: fixture.first,
    sourceArtifactRevision: fixture.second,
    sourceWorkspaceID: fixture.workerWorkspace,
    targetBeforeRevision: fixture.base,
    targetAfterRevision: fixture.second,
    landedCommits: [fixture.first, fixture.second],
    proofID: "proof:target-range",
    lineage: "proven",
    batch: null,
    createdAt,
  })
  const comparisonStore = new CodeReviewStore(fixture.repository)
  const integrationStore = new CodeReviewIntegrationStore(fixture.repository)
  fixture.repository.atomic((db) => {
    comparisonStore.persistIn(db, comparison.comparison, comparison.files, comparison.blobs)
    integrationStore.recordIntegrationIn(
      db,
      integration,
      comparison.comparison.identity.comparisonID,
    )
    fixture.runner.record(fixture.planID, fixture.taskID, "TASK_INTEGRATION_RECORDED", {
      artifact: fixture.second,
      branch: "main",
      head: fixture.second,
      reason: "Legacy receipt without an exact range",
    })
  })

  const call = register(fixture)
  const firstPage = (await call("lazers.codeReviewIntegrations", "list", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    limit: 1,
  })) as {
    integrations: (typeof integration)[]
    nextCursor: { createdAt: number; integrationID: string }
  }
  expect(firstPage.integrations).toEqual([integration])
  expect(firstPage.nextCursor).toEqual({ createdAt, integrationID })
  const secondPage = (await call("lazers.codeReviewIntegrations", "list", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    limit: 1,
    cursor: firstPage.nextCursor,
  })) as { integrations: (typeof integration)[]; nextCursor: unknown }
  expect(secondPage.integrations).toMatchObject([{ lineage: "uncertain", target: null }])
  expect(secondPage.nextCursor).toBeNull()

  const resolved = (await call("lazers.codeReviewIntegrations", "resolve", {
    sessionID: "ses-review",
    taskID: fixture.taskID,
    integrationID,
  })) as { comparison: { identity: { comparisonID: string } }; integration: typeof integration }
  expect(resolved.integration).toEqual(integration)
  expect(resolved.comparison.identity.comparisonID).toBe(
    comparison.comparison.identity.comparisonID,
  )
  await expect(
    call("lazers.codeReviewIntegrations", "resolve", {
      sessionID: "ses-foreign",
      taskID: fixture.taskID,
      integrationID,
    }),
  ).rejects.toThrow("Code review scope is unavailable")

  const resolver = new CodeReviewResolver(fixture.repository, fixture.runner, "project")
  const source = resolver.sourceIdentity(comparison.comparison, "head", "src/a.ts")
  const sourceInput = {
    sessionID: "ses-review",
    source,
    startLine: 1,
    endLine: 1,
  }
  const beforeGC = (await call("lazers.codeReview", "source", sourceInput)) as { text: string }
  expect(beforeGC.text).toBe("export const answer = 3\n")

  git(fixture.projectDirectory, "checkout", "--detach", fixture.base)
  git(fixture.projectDirectory, "branch", "-D", "main")
  git(fixture.projectDirectory, "worktree", "remove", "--force", fixture.workerWorkspace)
  git(fixture.projectDirectory, "reflog", "expire", "--expire=now", "--all")
  git(fixture.projectDirectory, "gc", "--prune=now")

  const afterGC = (await call("lazers.codeReview", "source", sourceInput)) as { text: string }
  expect(afterGC.text).toBe(beforeGC.text)
})
