import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import { DateTime, Effect } from "effect"
import type { RunnerHost } from "./host.ts"
import type { TaskRepository } from "../storage.ts"
import { basename, dirname } from "node:path"

export function nativeHost(ctx: Plugin.Context, _repository: TaskRepository): RunnerHost {
  return {
    async worktree(input) {
      const result = await Effect.runPromise(
        ctx.worktree.create({
          projectID: ctx.location.project.id,
          from: ctx.location.directory,
          branch: input.base,
          directory: AbsolutePath.make(dirname(input.directory)),
          name: basename(input.directory),
        }),
      )
      return result.directory
    },
    async worktrees() {
      await Effect.runPromise(ctx.worktree.refresh({ projectID: ctx.location.project.id }))
      return (
        await Effect.runPromise(ctx.worktree.list({ projectID: ctx.location.project.id }))
      ).map((entry) => entry.directory)
    },
    async removeWorktree(directory) {
      await Effect.runPromise(
        ctx.worktree.remove({
          projectID: ctx.location.project.id,
          directory: AbsolutePath.make(directory),
          force: false,
        }),
      )
    },
    async session(id) {
      const session = await Effect.runPromise(
        ctx.session.get({ sessionID: Session.ID.make(id) }).pipe(
          Effect.catch((error) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              error._tag === "SessionNotFoundError"
            )
              return Effect.succeed(null)
            return Effect.fail(error)
          }),
        ),
      )
      if (!session) return null
      const messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
      const busy = session.time.busy ? DateTime.toEpochMillis(session.time.busy) : 0
      const idle = session.time.idle ? DateTime.toEpochMillis(session.time.idle) : 0
      return {
        id: session.id,
        parentID: session.parentID,
        projectID: session.projectID,
        directory: session.location.directory,
        archived: session.time.archived !== undefined,
        busy: busy > idle,
        outcome: session.outcome,
        model: session.model,
        tokens:
          session.tokens.input +
          session.tokens.output +
          session.tokens.reasoning +
          session.tokens.cache.read +
          session.tokens.cache.write,
        tools: messages.reduce(
          (sum, message) =>
            sum +
            (message.type === "assistant"
              ? message.content.filter((part) => part.type === "tool").length
              : 0),
          0,
        ),
        // Subscription billing is not a dated equivalent API estimate.
        cost: null,
        messages: messages.map((message) => ({
          id: message.id,
          text:
            message.type === "user" || message.type === "synthetic"
              ? message.text
              : message.type === "assistant"
                ? message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : "",
        })),
      }
    },
    async create(input) {
      const model = {
        id: Model.ID.make(input.model.id),
        providerID: Provider.ID.make(input.model.providerID),
        ...(input.model.variant ? { variant: Model.VariantID.make(input.model.variant) } : {}),
      }
      const catalog = await Effect.runPromise(ctx.model.list())
      if (
        !catalog.data.some(
          (m) => m.id === model.id && m.providerID === model.providerID && m.enabled,
        )
      )
        throw new Error("Admitted worker model is unavailable; no fallback")
      await Effect.runPromise(
        ctx.session.create({
          id: Session.ID.make(input.id),
          parentID: Session.ID.make(input.parentID),
          agent: Agent.ID.make(input.agent),
          model,
          location: { directory: AbsolutePath.make(input.directory) },
          title: input.title,
          metadata: { lazersAttemptID: input.attemptID },
        }),
      )
    },
    async prompt(input) {
      const id = Session.ID.make(input.sessionID)
      const before = await Effect.runPromise(ctx.session.get({ sessionID: id }))
      if (before.location.directory !== input.directory) {
        await Effect.runPromise(
          ctx.session.move({ sessionID: id, directory: AbsolutePath.make(input.directory) }),
        )
        await Effect.runPromise(ctx.session.wait({ sessionID: id }))
      }
      const located = await Effect.runPromise(ctx.session.get({ sessionID: id }))
      if (located.location.directory !== input.directory)
        throw new Error("Worker session is not in its assigned worktree")
      // Remove only the entry written by the former eager skill adapter. Missing-key removal is safe.
      await Effect.runPromise(
        ctx.session.instructions.entry.remove({ sessionID: id, key: "lazers-required-skills" }),
      )
      await Effect.runPromise(
        ctx.session.prompt({
          sessionID: Session.ID.make(input.sessionID),
          id: SessionMessage.ID.make(input.id),
          text: input.text,
        }),
      )
    },
    async notify(input) {
      await Effect.runPromise(
        ctx.session.synthetic({
          sessionID: Session.ID.make(input.sessionID),
          id: SessionMessage.ID.make(input.id),
          text: input.text,
          resume: input.resume,
          description: "LAZERS task outcome",
        }),
      )
    },
    async interrupt(id) {
      await Effect.runPromise(ctx.session.interrupt({ sessionID: Session.ID.make(id) }))
    },
  }
}
