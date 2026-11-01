import type { Plugin } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import { DateTime, Effect } from "effect"
import type { ArchitectInputPage, ArchitectSourceResult, RunnerHost } from "./host.ts"
import type { TaskRepository } from "../storage.ts"
import { basename, dirname } from "node:path"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"

export type NativeInboxEndpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>
export type NativeInboxClient = {
  server: Pick<ReturnType<typeof OpenCode.make>["server"], "info">
  session: Pick<
    ReturnType<typeof OpenCode.make>["session"],
    "get" | "synthetic" | "inbox" | "update"
  >
  message: Pick<ReturnType<typeof OpenCode.make>["message"], "list">
}
export type NativeInboxDependencies = {
  discover: typeof Service.discover
  make(endpoint: NativeInboxEndpoint): NativeInboxClient
  processID(): number
}

const nativeInboxDependencies: NativeInboxDependencies = {
  discover: (options) => Service.discover(options),
  make: (endpoint) => OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }),
  processID: () => process.pid,
}

async function inboxClient(
  ctx: Plugin.Context,
  dependencies: NativeInboxDependencies,
): Promise<NativeInboxClient> {
  const endpoint = await dependencies.discover({ version: ctx.app.version })
  if (!endpoint)
    throw new Error(`Native outcome inbox is unavailable for OpenCode ${ctx.app.version}`)
  const client = dependencies.make(endpoint)
  const info = await client.server.info()
  if (info.pid !== dependencies.processID() || info.version !== ctx.app.version)
    throw new Error("Native outcome inbox service is not this OpenCode host process")
  return client
}

async function assertArchitectTarget(
  ctx: Plugin.Context,
  client: NativeInboxClient,
  sessionID: string,
) {
  const target = await client.session.get({ sessionID })
  if (target.projectID !== ctx.location.project.id || target.agent !== "architect")
    throw new Error("Native outcome inbox target is not a same-project Architect session")
}

function inboxEntry(
  entry: Awaited<ReturnType<NativeInboxClient["session"]["inbox"]["list"]>>[number],
) {
  const metadata =
    entry.type === "synthetic" || entry.type === "user" ? entry.payload.metadata : undefined
  return {
    id: entry.id,
    type: entry.type,
    ...("delivery" in entry ? { delivery: entry.delivery } : {}),
    ...(metadata ? { metadata } : {}),
  } satisfies OutcomeInboxEntry
}

function architectSourceResult(
  message: Awaited<ReturnType<NativeInboxClient["message"]["list"]>>["data"][number],
): ArchitectSourceResult | undefined {
  if (message.type !== "assistant") return undefined
  const toolCounts = { running: 0, completed: 0, failed: 0, other: 0 }
  for (const part of message.content ?? []) {
    if (part.type !== "tool") continue
    switch (part.state.status) {
      case "running":
      case "streaming":
        toolCounts.running++
        break
      case "completed":
        toolCounts.completed++
        break
      case "error":
        toolCounts.failed++
        break
      default:
        toolCounts.other++
    }
  }
  const finish = message.finish ?? null
  const state =
    message.error || finish === "error" || toolCounts.failed > 0
      ? "failed"
      : message.time?.completed === undefined || toolCounts.running > 0 || toolCounts.other > 0
        ? "running"
        : "completed"
  // Return only a bounded status projection; never retain tool inputs/outputs or reasoning.
  const result = { state, finish, toolCounts } satisfies ArchitectSourceResult
  return result
}

export function nativeHost(
  ctx: Plugin.Context,
  repository: TaskRepository,
  dependencies: NativeInboxDependencies = nativeInboxDependencies,
): RunnerHost {
  return {
    async workerModel() {
      const agent = await Effect.runPromise(
        ctx.agent.get({ agentID: Agent.ID.make("lazers-implementor") }),
      )
      return agent.data.model
    },
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
    async session(id, options) {
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
      const messages = options?.messages
        ? await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
        : []
      const busy = session.time.busy ? DateTime.toEpochMillis(session.time.busy) : 0
      const idle = session.time.idle ? DateTime.toEpochMillis(session.time.idle) : 0
      return {
        id: session.id,
        parentID: session.parentID,
        projectID: session.projectID,
        directory: session.location.directory,
        agent: session.agent,
        metadata: session.metadata,
        archived: session.time.archived !== undefined,
        busy: busy > idle,
        ...(idle ? { idleAt: idle } : {}),
        outcome: session.outcome,
        model: session.model,
        usage: {
          input: session.tokens.input,
          output: session.tokens.output,
          reasoning: session.tokens.reasoning,
          cacheRead: session.tokens.cache.read,
          cacheWrite: session.tokens.cache.write,
          provenance: "OpenCode 2.2.5 session.get cumulative token snapshot",
        },
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
          ...(message.type === "synthetic" ? { type: "synthetic" } : {}),
          ...(message.metadata ? { metadata: message.metadata } : {}),
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
    async outcomeInbox(sessionID) {
      const client = await inboxClient(ctx, dependencies)
      await assertArchitectTarget(ctx, client, sessionID)
      return (await client.session.inbox.list({ sessionID })).map(inboxEntry)
    },
    async architectInputPage(sessionID, cursor): Promise<ArchitectInputPage> {
      const client = await inboxClient(ctx, dependencies)
      await assertArchitectTarget(ctx, client, sessionID)
      const [inbox, page] = await Promise.all([
        client.session.inbox.list({ sessionID }),
        client.message.list({
          sessionID,
          limit: 100,
          order: "asc",
          ...(cursor ? { cursor } : {}),
        }),
      ])
      return {
        inbox: inbox
          .filter((entry) => entry.type === "user" || entry.type === "synthetic")
          .map((entry) => ({
            id: entry.id,
            type: entry.type,
            ...("payload" in entry && entry.payload.metadata
              ? { metadata: entry.payload.metadata }
              : {}),
            ...("delivery" in entry ? { delivery: entry.delivery } : {}),
          })),
        messages: page.data.map((entry) => {
          const result = architectSourceResult(entry)
          return {
            id: entry.id,
            type: entry.type,
            ...(entry.metadata ? { metadata: entry.metadata } : {}),
            ...(result ? { result } : {}),
          }
        }),
        nextCursor: page.cursor.next ?? null,
      }
    },
    async cancelOutcome(input) {
      if (
        input.ownership.lazersSessionID !== input.sessionID ||
        input.ownership.lazersMessageID !== input.inboxID ||
        input.ownership.lazersProjectID !== ctx.location.project.id ||
        input.ownership.lazersProjectDirectory !== repository.projectDirectory
      )
        throw new Error("Refusing to cancel an outcome with mismatched durable ownership")
      const client = await inboxClient(ctx, dependencies)
      await assertArchitectTarget(ctx, client, input.sessionID)
      const entry = (await client.session.inbox.list({ sessionID: input.sessionID }))
        .map(inboxEntry)
        .find((candidate) => candidate.id === input.inboxID)
      if (!entry || !isOwnedQueuedOutcome(entry, input.ownership))
        throw new Error("Owned outcome is no longer queued; cancellation was not confirmed")
      await client.session.inbox.cancel({ sessionID: input.sessionID, inboxID: input.inboxID })
    },
    async create(input) {
      // Preserve the admitted native ref verbatim. Catalog metadata is advisory;
      // session.create decides whether OpenCode can use this provider/model/variant.
      const model = {
        id: Model.ID.make(input.model.id),
        providerID: Provider.ID.make(input.model.providerID),
        ...(input.model.variant !== undefined
          ? { variant: Model.VariantID.make(input.model.variant) }
          : {}),
      }
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
    async createArchitect(input) {
      const model = input.model
        ? {
            id: Model.ID.make(input.model.id),
            providerID: Provider.ID.make(input.model.providerID),
            ...(input.model.variant ? { variant: Model.VariantID.make(input.model.variant) } : {}),
          }
        : undefined
      await Effect.runPromise(
        ctx.session.create({
          id: Session.ID.make(input.id),
          ...(input.parentID
            ? { parentID: Session.ID.make(input.parentID) }
            : { location: { directory: AbsolutePath.make(input.directory) } }),
          agent: Agent.ID.make("architect"),
          ...(model ? { model } : {}),
          title: input.title,
          metadata: {
            lazersContinuation: true,
            lazersPlanID: input.planID,
            ...(input.planIDs ? { lazersPlanIDs: input.planIDs } : {}),
            lazersSourceSessionID: input.sourceSessionID,
          },
        }),
      )
    },
    async updateSession(input) {
      const client = await inboxClient(ctx, dependencies)
      await assertArchitectTarget(ctx, client, input.sessionID)
      let updateError: unknown
      try {
        await client.session.update({ sessionID: input.sessionID, archived: input.archived })
      } catch (error) {
        updateError = error
      }
      let readback: Awaited<ReturnType<typeof client.session.get>>
      try {
        readback = await client.session.get({ sessionID: input.sessionID })
      } catch (error) {
        throw new Error(
          `Native Architect archival readback is unavailable${updateError ? ` after update error: ${String(updateError)}` : ""}: ${String(error)}`,
          { cause: error },
        )
      }
      if ((readback.time.archived !== undefined) !== input.archived)
        throw new Error(
          `Native Architect archival did not match public session readback${updateError ? ` after update error: ${String(updateError)}` : ""}`,
        )
      if (updateError && input.archived)
        throw new Error(
          `Native Architect archive response was uncertain but archived state was confirmed by public readback: ${String(updateError)}`,
          { cause: updateError },
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
      if (
        input.metadata &&
        (input.metadata.lazersProjectID !== ctx.location.project.id ||
          input.metadata.lazersProjectDirectory !== repository.projectDirectory ||
          input.metadata.lazersSessionID !== input.sessionID ||
          input.metadata.lazersMessageID !== input.id)
      )
        throw new Error("Native outcome notification has mismatched durable ownership")
      const client = await inboxClient(ctx, dependencies)
      await assertArchitectTarget(ctx, client, input.sessionID)
      await client.session.synthetic({
        sessionID: Session.ID.make(input.sessionID),
        id: SessionMessage.ID.make(input.id),
        text: input.text,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        resume: input.resume,
        delivery: "queue",
        description: "LAZERS task outcome",
      })
    },
    async updateInstruction(input) {
      const sessionID = Session.ID.make(input.sessionID)
      const session = await Effect.runPromise(ctx.session.get({ sessionID }))
      if (
        session.id !== input.sessionID ||
        session.agent !== "lazers-implementor" ||
        input.projectID !== ctx.location.project.id ||
        session.projectID !== input.projectID ||
        session.location.directory !== input.directory ||
        session.metadata?.lazersAttemptID !== input.attemptID ||
        session.time.archived !== undefined
      )
        throw new Error("Scope instruction target is not the owned worker attempt")
      const matches = async () =>
        (await Effect.runPromise(ctx.session.instructions.entry.list({ sessionID }))).some(
          (entry) => entry.key === input.key && entry.value === input.text,
        )
      // A lost put response is recovered from the durable entry, not another
      // model message. An absent entry may safely repeat the same keyed upsert.
      if (await matches()) return
      await Effect.runPromise(
        ctx.session.instructions.entry.put({ sessionID, key: input.key, value: input.text }),
      )
      if (!(await matches())) throw new Error("Scope instruction update has no native readback")
    },
    async interrupt(id) {
      await Effect.runPromise(ctx.session.interrupt({ sessionID: Session.ID.make(id) }))
    },
  }
}
