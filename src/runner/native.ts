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
import type {
  ArchitectInputPage,
  ArchitectSourceResult,
  HostBackgroundObservation,
  RunnerHost,
} from "./host.ts"
import type { TaskRepository } from "../storage.ts"
import { basename, dirname } from "node:path"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"

export type NativeInboxEndpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>
export type NativeInboxClient = {
  server: Pick<ReturnType<typeof OpenCode.make>["server"], "info">
  form: Pick<ReturnType<typeof OpenCode.make>["form"], "list">
  permission: Pick<ReturnType<typeof OpenCode.make>["permission"], "request">
  session: Pick<
    ReturnType<typeof OpenCode.make>["session"],
    "active" | "get" | "synthetic" | "inbox" | "update"
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

type NativeIdleBackgroundWork = { kind: "shell" | "subagent" | "image" }
type NativeIdleBackgroundLineage = {
  inputID: string
  executionStartSequence: number
  eventSequence: number
}
const idleBackground = new Map<string, HostBackgroundObservation>()
const idleBackgroundOwners = new Map<string, symbol>()

/** An asynchronous read may update only the observation it started from. */
export function nativeIdleObservationFence(sessionID: string, observer?: symbol): () => boolean {
  const observation = idleBackground.get(sessionID)
  const owner = idleBackgroundOwners.get(sessionID)
  return () =>
    idleBackground.get(sessionID) === observation &&
    idleBackgroundOwners.get(sessionID) === owner &&
    (observer === undefined || observer === owner)
}

/** Stores only the public experimental idle-hook report, not a complete resource inventory. */
export function observeNativeIdleBackground(
  sessionID: string,
  background: readonly NativeIdleBackgroundWork[],
  lineage: NativeIdleBackgroundLineage,
  observedAt = Date.now(),
  observer?: symbol,
) {
  if (observer) idleBackgroundOwners.set(sessionID, observer)
  else idleBackgroundOwners.delete(sessionID)
  const kinds = { shell: 0, subagent: 0, image: 0 }
  for (const work of background) kinds[work.kind]++
  idleBackground.set(sessionID, {
    state: "observed",
    source: "experimental.idle",
    observedAt,
    ...lineage,
    count: background.length,
    kinds,
  })
}

export function markNativeIdleBackgroundUnknown(
  sessionID: string,
  reason: string,
  observer?: symbol,
) {
  if (observer) idleBackgroundOwners.set(sessionID, observer)
  else idleBackgroundOwners.delete(sessionID)
  idleBackground.set(sessionID, {
    state: "unknown",
    source: "experimental.idle",
    reason,
    observedAt: Date.now(),
  })
}

export function confirmNativeIdleBackgroundSuccess(
  sessionID: string,
  lineage: NativeIdleBackgroundLineage,
  terminalSequence: number,
  observer?: symbol,
) {
  const current = idleBackground.get(sessionID)
  if (
    (observer !== undefined && idleBackgroundOwners.get(sessionID) !== observer) ||
    current?.state !== "observed" ||
    current.inputID !== lineage.inputID ||
    current.executionStartSequence !== lineage.executionStartSequence ||
    current.eventSequence !== lineage.eventSequence ||
    terminalSequence <= current.eventSequence
  )
    return false
  idleBackground.set(sessionID, { ...current, terminalSequence })
  return true
}

export function noteStaleNativeIdleBackgroundEvent(
  sessionID: string,
  sequence: number,
  observer?: symbol,
) {
  if (observer !== undefined && idleBackgroundOwners.get(sessionID) !== observer) return
  const current = idleBackground.get(sessionID)
  if (current?.state !== "observed") return
  idleBackground.set(sessionID, { ...current, staleEventSequence: sequence })
}

export function invalidateNativeIdleObserver(observer: symbol, reason: string) {
  for (const [sessionID, owner] of idleBackgroundOwners) {
    if (owner !== observer) continue
    markNativeIdleBackgroundUnknown(sessionID, reason, observer)
    idleBackgroundOwners.delete(sessionID)
  }
}

function nativeIdleBackgroundObservation(sessionID: string): HostBackgroundObservation {
  return (
    idleBackground.get(sessionID) ?? {
      state: "unknown",
      source: "experimental.idle",
      reason: "No experimental.idle background report was observed in this host process",
    }
  )
}

class NativeProcessMismatchError extends Error {}

async function assertNativeProcess(
  ctx: Plugin.Context,
  client: NativeInboxClient,
  dependencies: NativeInboxDependencies,
) {
  const info = await client.server.info()
  if (info.pid !== dependencies.processID() || info.version !== ctx.app.version)
    throw new NativeProcessMismatchError(
      "Native outcome inbox service is not this OpenCode host process",
    )
}

type NativeWorkerObservation = {
  active: boolean
  pendingInput: boolean
  inbox: string
  pendingPermissions: number
  permissionRequests: string
  pendingForms: number
  forms: string
}

async function workerObservation(
  client: NativeInboxClient,
  sessionID: string,
  directory?: string,
): Promise<NativeWorkerObservation> {
  const [active, inbox, permissions, forms] = await Promise.all([
    client.session.active(),
    client.session.inbox.list({ sessionID }),
    directory
      ? client.permission.request.list({ location: { directory } })
      : Promise.resolve(undefined),
    directory ? client.form.list({ location: { directory } }) : Promise.resolve(undefined),
  ])
  if (
    !active ||
    typeof active !== "object" ||
    Array.isArray(active) ||
    !Array.isArray(inbox) ||
    (permissions !== undefined && !Array.isArray(permissions.data)) ||
    (forms !== undefined && !Array.isArray(forms.data))
  )
    throw new Error("Native worker execution inventory is unavailable")
  if (
    directory &&
    (!permissions ||
      !forms ||
      permissions.location.directory !== directory ||
      forms.location.directory !== directory)
  )
    throw new Error("Native worker approval inventory did not match its assigned location")
  const permissionIDs = (permissions?.data ?? [])
    .filter((entry) => entry.sessionID === sessionID)
    .map((entry) => entry.id)
    .sort()
  const formIDs = (forms?.data ?? [])
    .filter((entry) => entry.sessionID === sessionID)
    .map((entry) => entry.id)
    .sort()
  return {
    active: Object.prototype.hasOwnProperty.call(active, sessionID),
    pendingInput: inbox.length > 0,
    inbox: inbox
      .map((entry) => `${entry.id}:${entry.type}:${entry.delivery}`)
      .sort()
      .join("\n"),
    pendingPermissions: permissionIDs.length,
    permissionRequests: permissionIDs.join("\n"),
    pendingForms: formIDs.length,
    forms: formIDs.join("\n"),
  }
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
  let connected: NativeInboxClient | undefined
  let connecting: Promise<NativeInboxClient> | undefined
  const invalidate = (client: NativeInboxClient) => {
    if (connected === client) connected = undefined
  }
  const connectedClient = async () => {
    if (connected) return connected
    if (connecting) return connecting
    connecting = (async () => {
      const endpoint = await dependencies.discover({ version: ctx.app.version })
      if (!endpoint)
        throw new Error(`Native outcome inbox is unavailable for OpenCode ${ctx.app.version}`)
      const client = dependencies.make(endpoint)
      await assertNativeProcess(ctx, client, dependencies)
      return client
    })()
    try {
      connected = await connecting
      return connected
    } finally {
      connecting = undefined
    }
  }
  const runNative = async <A>(client: NativeInboxClient, operation: () => Promise<A>) => {
    try {
      return await operation()
    } catch (error) {
      invalidate(client)
      throw error
    }
  }
  const observeWorker = (client: NativeInboxClient, sessionID: string, directory?: string) =>
    runNative(client, () => workerObservation(client, sessionID, directory))
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
      const client = await connectedClient()
      const readSession = () =>
        runNative(client, () =>
          Effect.runPromise(
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
          ),
        )
      const session = await readSession()
      if (!session) {
        const before = await observeWorker(client, id)
        if (before.active || before.pendingInput)
          throw new Error("Native worker session is absent while execution or input is observed")
        return null
      }
      const backgroundBefore = nativeIdleBackgroundObservation(id)
      const before = await observeWorker(client, id, session.location.directory)
      const messages = options?.messages
        ? await runNative(client, () =>
            Effect.runPromise(ctx.session.context({ sessionID: session.id })),
          )
        : []
      const latest = options?.messages ? await readSession() : session
      const after = options?.messages
        ? await observeWorker(client, id, latest?.location.directory ?? session.location.directory)
        : before
      const backgroundAfter = nativeIdleBackgroundObservation(id)
      if (!latest) {
        if (before.active || after.active || before.pendingInput || after.pendingInput)
          throw new Error("Native worker session disappeared during execution observation")
        return null
      }

      const sessionExecutionState = (value: NonNullable<typeof session>) =>
        JSON.stringify({
          busy: value.time.busy ? DateTime.toEpochMillis(value.time.busy) : 0,
          idle: value.time.idle ? DateTime.toEpochMillis(value.time.idle) : 0,
          outcome: value.outcome,
          archived: value.time.archived !== undefined,
        })
      const beforeState = sessionExecutionState(session)
      const afterState = sessionExecutionState(latest)
      const observationUnstable =
        options?.messages === true &&
        (before.active !== after.active ||
          before.inbox !== after.inbox ||
          before.permissionRequests !== after.permissionRequests ||
          before.forms !== after.forms ||
          JSON.stringify(backgroundBefore) !== JSON.stringify(backgroundAfter) ||
          session.location.directory !== latest.location.directory ||
          beforeState !== afterState)
      const active = before.active || after.active
      const pendingInput = before.pendingInput || after.pendingInput
      const pendingPermissions = Math.max(before.pendingPermissions, after.pendingPermissions)
      const pendingForms = Math.max(before.pendingForms, after.pendingForms)
      const busyAt = latest.time.busy ? DateTime.toEpochMillis(latest.time.busy) : 0
      const idleAt = latest.time.idle ? DateTime.toEpochMillis(latest.time.idle) : 0
      const lastInputIndex = options?.messages
        ? messages.reduce(
            (index, message, current) =>
              message.type === "user" || message.type === "synthetic" ? current : index,
            -1,
          )
        : -1
      const lastInput = lastInputIndex >= 0 ? messages[lastInputIndex] : undefined
      const response =
        lastInputIndex >= 0
          ? [...messages.slice(lastInputIndex + 1)]
              .reverse()
              .find((message) => message.type === "assistant")
          : undefined
      const unfinishedAssistant =
        response !== undefined &&
        (response.time.completed === undefined ||
          response.finish === "tool-calls" ||
          response.content.some(
            (part) =>
              part.type === "tool" &&
              (part.state.status === "running" || part.state.status === "streaming"),
          ))
      const pendingInteraction = pendingPermissions > 0 || pendingForms > 0
      const interrupted =
        !active &&
        !pendingInput &&
        !pendingInteraction &&
        !observationUnstable &&
        (busyAt > idleAt || unfinishedAssistant)
      const turn = options?.messages
        ? {
            inputID: lastInput?.id ?? null,
            state: (lastInput === undefined
              ? "unknown"
              : interrupted
                ? "interrupted"
                : response === undefined
                  ? "pending"
                  : unfinishedAssistant
                    ? "interrupted"
                    : "completed") as "pending" | "completed" | "interrupted" | "unknown",
          }
        : undefined
      const outcome =
        active || pendingInput || pendingInteraction || observationUnstable
          ? undefined
          : interrupted
            ? "interrupted"
            : latest.outcome
      return {
        id: latest.id,
        parentID: latest.parentID,
        projectID: latest.projectID,
        directory: latest.location.directory,
        agent: latest.agent,
        metadata: latest.metadata,
        archived: latest.time.archived !== undefined,
        busy: active,
        ...(pendingInput ? { pendingInput: true } : {}),
        ...(pendingPermissions ? { pendingPermissions } : {}),
        ...(pendingForms ? { pendingForms } : {}),
        ...(observationUnstable ? { observationUnstable: true } : {}),
        ...(turn ? { turn } : {}),
        background: backgroundAfter,
        ...(idleAt ? { idleAt } : {}),
        outcome,
        model: latest.model,
        usage: {
          input: latest.tokens.input,
          output: latest.tokens.output,
          reasoning: latest.tokens.reasoning,
          cacheRead: latest.tokens.cache.read,
          cacheWrite: latest.tokens.cache.write,
          provenance: "OpenCode 2.2.5 session.get cumulative token snapshot",
        },
        tokens:
          latest.tokens.input +
          latest.tokens.output +
          latest.tokens.reasoning +
          latest.tokens.cache.read +
          latest.tokens.cache.write,
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
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, sessionID))
      const entries = await runNative(client, () => client.session.inbox.list({ sessionID }))
      return entries.map(inboxEntry)
    },
    async architectInputPage(sessionID, cursor): Promise<ArchitectInputPage> {
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, sessionID))
      const [inbox, page] = await Promise.all([
        runNative(client, () => client.session.inbox.list({ sessionID })),
        runNative(client, () =>
          client.message.list({
            sessionID,
            limit: 100,
            ...(cursor ? { cursor } : { order: "asc" }),
          }),
        ),
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
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, input.sessionID))
      const entry = (
        await runNative(client, () => client.session.inbox.list({ sessionID: input.sessionID }))
      )
        .map(inboxEntry)
        .find((candidate) => candidate.id === input.inboxID)
      if (!entry || !isOwnedQueuedOutcome(entry, input.ownership))
        throw new Error("Owned outcome is no longer queued; cancellation was not confirmed")
      await runNative(client, () =>
        client.session.inbox.cancel({ sessionID: input.sessionID, inboxID: input.inboxID }),
      )
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
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, input.sessionID))
      let updateError: unknown
      try {
        await client.session.update({ sessionID: input.sessionID, archived: input.archived })
      } catch (error) {
        updateError = error
      }
      let readback: Awaited<ReturnType<typeof client.session.get>>
      try {
        readback = await runNative(client, () => client.session.get({ sessionID: input.sessionID }))
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
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, input.sessionID))
      await runNative(client, () =>
        client.session.synthetic({
          sessionID: Session.ID.make(input.sessionID),
          id: SessionMessage.ID.make(input.id),
          text: input.text,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          resume: input.resume,
          delivery: "queue",
          description: "LAZERS task outcome",
        }),
      )
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
