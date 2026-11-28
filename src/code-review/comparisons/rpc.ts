import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { callerSession } from "../../projects/read-access.ts"
import type { TaskRepository } from "../../storage.ts"
import type { RunnerStore } from "../../runner/store.ts"
import { timedRpc } from "../../diagnostics/stall-probe.ts"
import {
  CodeReview,
  CodeReviewHistoryInputSchema,
  CodeReviewMarkReviewedInputSchema,
  CodeReviewReviewedInputSchema,
  CodeReviewResolveInputSchema,
  CodeReviewSourceIdentitySchema,
  CodeReviewSourceShapeInputSchema,
  CodeReviewStructuralInputSchema,
  CodeReviewSourceWindowInputSchema,
  type CodeReviewSourceShapeInput,
} from "../contract.ts"
import { CodeReviewResolver } from "./resolver.ts"
import { readStructuralComparison } from "../analysis/structural.ts"

type ReviewContext = Pick<Plugin.Context, "rpc" | "session" | "permission">

export async function authorizeCodeReview(
  ctx: ReviewContext,
  sessionID: string,
  projectID: string,
  projectDirectory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const session = await callerSession(ctx, sessionID, projectID)
  if (!session) throw new Error("Code review scope is unavailable")
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action: "read",
      resources: [projectDirectory],
    }),
    { signal },
  )
  signal.throwIfAborted()
}

/** Authorized, versioned comparison/source RPCs for one canonical project. */
export function registerCodeReview(
  ctx: ReviewContext,
  repository: TaskRepository,
  runner: RunnerStore,
  projectID: string,
) {
  return Effect.gen(function* () {
    const resolver = new CodeReviewResolver(repository, runner, projectID)
    yield* timedRpc(ctx.rpc).register(CodeReview, {
      resolve: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewResolveInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            return resolver.resolve(request, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      history: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewHistoryInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            return resolver.history(request, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      shape: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request: CodeReviewSourceShapeInput =
              CodeReviewSourceShapeInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            const source = CodeReviewSourceIdentitySchema.parse(request.source)
            if (source.projectID !== projectID)
              throw new Error("Pinned source belongs to another project")
            return resolver.shape(source, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      source: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewSourceWindowInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            const source = CodeReviewSourceIdentitySchema.parse(request.source)
            if (source.projectID !== projectID)
              throw new Error("Pinned source belongs to another project")
            return resolver.sourceWindow({ ...request, source }, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      structural: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewStructuralInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            return readStructuralComparison(resolver, request, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      markReviewed: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewMarkReviewedInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            return resolver.markReviewed(request, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      reviewed: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CodeReviewReviewedInputSchema.parse(input)
            await authorizeCodeReview(
              ctx,
              request.sessionID,
              projectID,
              repository.projectDirectory,
              signal,
            )
            return resolver.reviewed(request, signal)
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
    })
  })
}
