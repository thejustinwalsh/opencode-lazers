import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { fingerprint } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import type { RunnerStore } from "../../runner/store.ts"
import { timedRpc } from "../../diagnostics/stall-probe.ts"
import { CODE_REVIEW_CONTRACT_VERSION, CodeReviewComparisonSchema } from "../contract.ts"
import { CodeReviewResolver } from "../comparisons/resolver.ts"
import { authorizeCodeReview } from "../comparisons/rpc.ts"
import {
  CodeReviewIntegratedComparisonSchema,
  CodeReviewIntegrationsListOutputSchema,
  CodeReviewIntegrationsResolveInputSchema,
  CodeReviewIntegrationSchema,
  CodeReviewIntegrations,
  CodeReviewIntegrationsListInputSchema,
  type CodeReviewIntegration,
} from "./contract.ts"
import { CodeReviewIntegrationStore } from "./store.ts"

type IntegrationContext = Pick<Plugin.Context, "rpc" | "session" | "permission">

export function registerCodeReviewIntegrations(
  ctx: IntegrationContext,
  repository: TaskRepository,
  runner: RunnerStore,
  projectID: string,
) {
  return Effect.gen(function* () {
    const integrations = new CodeReviewIntegrationStore(repository)
    const resolver = new CodeReviewResolver(repository, runner, projectID)
    yield* timedRpc(ctx.rpc).register(CodeReviewIntegrations, {
      list: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewIntegrationsListInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            if (!repository.get(request.taskID))
              throw new Error("Task is unavailable in this project")
            const page = integrations.integrations(
              request.taskID,
              request.limit ?? 50,
              request.cursor,
            )
            signal.throwIfAborted()
            return CodeReviewIntegrationsListOutputSchema.parse(page)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      resolve: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewIntegrationsResolveInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            if (!repository.get(request.taskID))
              throw new Error("Task is unavailable in this project")
            const result = integrationComparison(
              repository,
              integrations,
              resolver,
              projectID,
              request.taskID,
              request.integrationID,
            )
            signal.throwIfAborted()
            return result
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
    })
  })
}

function integrationComparison(
  repository: TaskRepository,
  integrations: CodeReviewIntegrationStore,
  resolver: CodeReviewResolver,
  projectID: string,
  taskID: string,
  integrationID: string,
) {
  const integration = integrations.integration(taskID, integrationID)
  if (!integration) throw new Error("Integration is unavailable for this task")
  const comparisonID = integrations.comparisonID(integration.id)
  if (!comparisonID) return legacyIntegrationComparison(repository, projectID, taskID, integration)

  const comparison = resolver.store.comparison(comparisonID)
  if (!comparisonMatchesIntegration(comparison, projectID, taskID, integration))
    throw new Error("Pinned integrated comparison does not match its integration")
  return CodeReviewIntegratedComparisonSchema.parse({
    comparison: CodeReviewComparisonSchema.parse(comparison),
    integration: CodeReviewIntegrationSchema.parse(integration),
  })
}

function legacyIntegrationComparison(
  repository: TaskRepository,
  projectID: string,
  taskID: string,
  integration: CodeReviewIntegration,
) {
  if (integration.lineage !== "uncertain")
    throw new Error("Pinned integrated comparison is unavailable")
  return CodeReviewIntegratedComparisonSchema.parse({
    integration,
    comparison: unavailableComparison(repository, projectID, taskID, integration),
  })
}

function comparisonMatchesIntegration(
  comparison: ReturnType<CodeReviewResolver["store"]["comparison"]>,
  projectID: string,
  taskID: string,
  integration: CodeReviewIntegration,
): boolean {
  return (
    comparison !== undefined &&
    comparison.identity.projectID === projectID &&
    comparison.identity.taskID === taskID &&
    comparison.identity.baseRevision === integration.targetBeforeRevision &&
    comparison.identity.headRevision === integration.targetAfterRevision
  )
}

function unavailableComparison(
  repository: TaskRepository,
  projectID: string,
  taskID: string,
  integration: CodeReviewIntegration,
) {
  const task = repository.get(taskID)
  if (!task) throw new Error("Task is unavailable in this project")
  const comparisonID = fingerprint({
    kind: "unavailable-legacy-integration",
    projectID,
    taskID,
    integrationID: integration.id,
  })
  return CodeReviewComparisonSchema.parse({
    identity: {
      version: CODE_REVIEW_CONTRACT_VERSION,
      comparisonID,
      projectID,
      taskID,
      planID: integration.planID,
      attemptID: integration.attemptID,
      mode: "since",
      baseRevision: integration.targetBeforeRevision,
      headRevision: integration.targetAfterRevision,
      snapshotID: null,
      capturedAt: integration.createdAt,
      attribution: "committed",
    },
    available: false,
    unavailableReason: "Legacy integration did not retain an exact target range.",
    fileCount: 0,
    changedCount: 0,
    sides: ["base", "head"],
    sourceName: "codeReview.files",
    taskReference: repository.referenceFor(task.id) ?? task.id,
    taskTitle: task.proposal.objective.slice(0, 120),
    planContext: null,
  })
}
