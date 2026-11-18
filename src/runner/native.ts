import { sameNativeModel } from "./model-route.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import { Cause, DateTime, Effect, Exit } from "effect"
import type {
  ArchitectInputPage,
  ArchitectSourceResult,
  HostMessage,
  RunnerHost,
  WorktreeLocationRetirement,
} from "./host.ts"
import type { TaskRepository } from "../storage.ts"
import { basename, dirname, resolve } from "node:path"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"
import { retainedNativeInputID, resolveNativeInputID } from "./native-input.ts"
import { SourceFence } from "./source-fence-rpc.ts"
import { sourceGuardMatches, sourceReviewBinding } from "./source-quarantine.ts"
import { reviewMetadata } from "./review-input.ts"
import { ModelPolicy } from "./schema.ts"
import { NativeWorktreeCreationFailure, nativeWorktreeFailureEvidence } from "./startup-recovery.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { sameProject } from "../project-key.ts"

export type NativeInboxEndpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>
export type NativeInboxClient = {
  location?: Pick<ReturnType<typeof OpenCode.make>["location"], "get">
  rpc: ReturnType<typeof OpenCode.make>["rpc"]
  server: Pick<ReturnType<typeof OpenCode.make>["server"], "info">
  form: Pick<ReturnType<typeof OpenCode.make>["form"], "list">
  permission: Pick<ReturnType<typeof OpenCode.make>["permission"], "request">
  session: Pick<
    ReturnType<typeof OpenCode.make>["session"],
    "active" | "get" | "synthetic" | "inbox" | "update" | "list" | "message"
  > & {
    message: Pick<ReturnType<typeof OpenCode.make>["session"]["message"], "get">
  }
  experimental: {
    session: Pick<ReturnType<typeof OpenCode.make>["experimental"]["session"], "log">
  }
  message: Pick<ReturnType<typeof OpenCode.make>["message"], "list">
  shell: Pick<ReturnType<typeof OpenCode.make>["shell"], "list">
  debug: Pick<ReturnType<typeof OpenCode.make>["debug"], "location">
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
  locationPendingPermissions: number
  permissionRequests: string
  pendingForms: number
  locationPendingForms: number
  forms: string
  shells: string
  runningShells: number
}

function isMissingNativeSession(
  error: unknown,
  sessionID: string,
): error is { _tag: "Session.NotFoundError" | "SessionNotFoundError"; sessionID: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "Session.NotFoundError" || error._tag === "SessionNotFoundError") &&
    "sessionID" in error &&
    error.sessionID === sessionID
  )
}

function pathInside(path: string, directory: string) {
  const base = resolve(directory)
  const target = resolve(path)
  return target === base || target.startsWith(`${base}/`)
}

async function workerObservation(
  client: NativeInboxClient,
  sessionID: string,
  directory?: string,
  requireLocationShells = true,
  confirmedAbsent = false,
): Promise<NativeWorkerObservation> {
  // Location-scoped reads boot an unloaded location (plugin instantiation,
  // watchers) and it is evicted right after. A location that is not loaded has no
  // permission requests, forms or shells, so read them only when it is loaded.
  const inspectLocation =
    directory !== undefined &&
    (await client.debug.location.list()).some(
      (location) => resolve(location.directory) === resolve(directory),
    )
  if (inspectLocation && requireLocationShells && typeof client.shell?.list !== "function")
    throw new Error("Native worker location shell inventory is unavailable")
  const [active, inbox, permissions, forms, shells] = await Promise.all([
    client.session.active(),
    client.session.inbox.list({ sessionID }).catch((error: unknown) => {
      // Only the already-absent session path can treat its absent inbox as empty.
      // Present-worker reads must retain every inventory failure as unknown.
      if (
        confirmedAbsent &&
        isMissingNativeSession(error, sessionID) &&
        error._tag === "SessionNotFoundError"
      )
        return []
      throw error
    }),
    inspectLocation
      ? client.permission.request.list({ location: { directory } })
      : Promise.resolve(undefined),
    inspectLocation ? client.form.list({ location: { directory } }) : Promise.resolve(undefined),
    inspectLocation && typeof client.shell?.list === "function"
      ? client.shell.list({ location: { directory } })
      : Promise.resolve(undefined),
  ])
  if (
    !active ||
    typeof active !== "object" ||
    Array.isArray(active) ||
    !Array.isArray(inbox) ||
    (permissions !== undefined && !Array.isArray(permissions.data)) ||
    (forms !== undefined && !Array.isArray(forms.data)) ||
    (shells !== undefined && !Array.isArray(shells.data))
  )
    throw new Error("Native worker execution inventory is unavailable")
  if (
    inspectLocation &&
    (!permissions ||
      !forms ||
      permissions.location.directory !== directory ||
      forms.location.directory !== directory ||
      (requireLocationShells && (!shells || shells.location.directory !== directory)))
  )
    throw new Error("Native worker approval inventory did not match its assigned location")
  const permissionEntries = permissions?.data ?? []
  const formEntries = forms?.data ?? []
  const permissionIDs = permissionEntries
    .filter((entry) => entry.sessionID === sessionID)
    .map((entry) => entry.id)
    .sort()
  const formIDs = formEntries
    .filter((entry) => entry.sessionID === sessionID)
    .map((entry) => entry.id)
    .sort()
  const shellEntries = (shells?.data ?? []).map((entry) => {
    if (
      typeof entry.id !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.cwd !== "string" ||
      typeof entry.time?.started !== "number"
    )
      throw new Error("Native worker shell inventory is unavailable")
    return `${entry.id}:${entry.status}:${entry.cwd}:${entry.time.started}:${entry.time.completed ?? ""}`
  })
  const runningShells = (shells?.data ?? []).filter(
    (entry) => entry.status === "running" && (!directory || pathInside(entry.cwd, directory)),
  ).length
  return {
    active: Object.prototype.hasOwnProperty.call(active, sessionID),
    pendingInput: inbox.length > 0,
    inbox: inbox
      .map((entry) => `${entry.id}:${entry.type}:${entry.delivery}`)
      .sort()
      .join("\n"),
    pendingPermissions: permissionIDs.length,
    locationPendingPermissions: permissionEntries.length,
    permissionRequests: permissionIDs.join("\n"),
    pendingForms: formIDs.length,
    locationPendingForms: formEntries.length,
    forms: formIDs.join("\n"),
    shells: shellEntries.sort().join("\n"),
    runningShells,
  }
}

async function activeSessionLineage(
  client: NativeInboxClient,
  rootSessionID: string,
  workspace: string,
): Promise<{ activeRoot: boolean; activeDescendants: string[]; activeAtWorkspace: string[] }> {
  const active = await client.session.active()
  if (!active || typeof active !== "object" || Array.isArray(active))
    throw new Error("Native active-session inventory is unavailable")
  const descendants: string[] = []
  const atWorkspace: string[] = []
  const activeIDs = Object.entries(active).sort(([a], [b]) => a.localeCompare(b))
  for (const [activeID, status] of activeIDs) {
    if (
      !status ||
      typeof status !== "object" ||
      !["idle", "retry", "busy", "running"].includes(status.type)
    )
      throw new Error("Native active-session inventory is contradictory")
    if (activeID === rootSessionID) continue
    const visited = new Set<string>()
    let cursor = await client.session.get({ sessionID: Session.ID.make(activeID) })
    if (resolve(cursor.location.directory) === resolve(workspace)) atWorkspace.push(activeID)
    let descendant = false
    for (let depth = 0; cursor.parentID && depth < 32; depth++) {
      if (cursor.parentID === rootSessionID) {
        descendant = true
        break
      }
      if (visited.has(cursor.parentID))
        throw new Error("Native active-session lineage contains a cycle")
      visited.add(cursor.parentID)
      cursor = await client.session.get({ sessionID: Session.ID.make(cursor.parentID) })
    }
    if (!descendant && cursor.parentID)
      throw new Error("Native active-session lineage exceeds the safe inspection depth")
    if (descendant) descendants.push(activeID)
  }
  return {
    activeRoot: Object.prototype.hasOwnProperty.call(active, rootSessionID),
    activeDescendants: descendants,
    activeAtWorkspace: atWorkspace,
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
  return target
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
): RunnerHost & {
  ownsCurrentWorkspace(directory: string): Promise<boolean>
  retainedInputID(sessionID: string): Promise<string | undefined>
} {
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
  const observeWorker = (
    client: NativeInboxClient,
    sessionID: string,
    directory?: string,
    confirmedAbsent = false,
  ) =>
    runNative(client, () => workerObservation(client, sessionID, directory, true, confirmedAbsent))
  const retainedInputID = async (sessionID: string) => {
    const client = await connectedClient()
    return runNative(client, () => retainedNativeInputID(client, sessionID))
  }
  const host: RunnerHost & {
    ownsCurrentWorkspace(directory: string): Promise<boolean>
    retainedInputID(sessionID: string): Promise<string | undefined>
  } = {
    retainedInputID,
    async ownsCurrentWorkspace(directory) {
      const client = await connectedClient()
      const location = client.location
      if (!location) return false
      return runNative(client, async () => {
        await assertNativeProcess(ctx, client, dependencies)
        const current = await location.get({
          location: { directory: AbsolutePath.make(directory) },
        })
        return (
          current.directory === directory &&
          current.project.id === ctx.location.project.id &&
          current.project.canonical === repository.projectDirectory
        )
      })
    },
    async workerModel(agentID = "lazers-implementor") {
      const agent = await Effect.runPromise(ctx.agent.get({ agentID: Agent.ID.make(agentID) }))
      return agent.data.model
    },
    async worktree(input) {
      const create = {
        projectID: ctx.location.project.id,
        // Worktree creation belongs to the canonical project even when this
        // plugin invocation is hosted from a disposable participant tree.
        from: AbsolutePath.make(repository.projectDirectory),
        branch: input.base,
        directory: AbsolutePath.make(dirname(input.directory)),
        name: basename(input.directory),
      }
      let operation: ReturnType<typeof ctx.worktree.create>
      try {
        operation = ctx.worktree.create(create)
      } catch (error) {
        throw new Error(error instanceof Error ? error.message || String(error) : String(error), {
          cause: error,
        })
      }
      const exit = await Effect.runPromiseExit(operation)
      if (Exit.isSuccess(exit)) return exit.value.directory
      const [reason] = exit.cause.reasons
      if (exit.cause.reasons.length === 1 && reason && Cause.isFailReason(reason)) {
        const evidence = nativeWorktreeFailureEvidence(reason.error)
        if (evidence) throw new NativeWorktreeCreationFailure(evidence)
      }
      const failure = Cause.squash(exit.cause)
      throw new Error(
        failure instanceof Error ? failure.message || String(failure) : String(failure),
        {
          cause: failure,
        },
      )
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
    async retireWorktreeLocation(directory): Promise<WorktreeLocationRetirement> {
      const target = resolve(directory)
      if (
        target === resolve(ctx.location.directory) ||
        target === resolve(repository.projectDirectory)
      )
        return "current-location"
      try {
        const client = await connectedClient()
        const loaded = await runNative(client, () => client.debug.location.list())
        if (!loaded.some((location) => resolve(location.directory) === target)) return "not-loaded"

        const active = await runNative(client, () => client.session.active())
        if (!active || typeof active !== "object" || Array.isArray(active)) return "unavailable"
        for (const [sessionID, status] of Object.entries(active)) {
          if (!status || status.type !== "running") return "unavailable"
          const session = await runNative(client, () =>
            client.session.get({ sessionID: Session.ID.make(sessionID) }),
          )
          if (resolve(session.location.directory) === target) return "active-session"
        }

        const current = await runNative(client, () => client.debug.location.list())
        if (!current.some((location) => resolve(location.directory) === target)) return "not-loaded"
        await runNative(client, () =>
          client.debug.location.evict({ location: { directory: target } }),
        )
        const after = await runNative(client, () => client.debug.location.list())
        return after.some((location) => resolve(location.directory) === target)
          ? "unavailable"
          : "evicted"
      } catch {
        return "unavailable"
      }
    },
    async session(id, options) {
      const client = await connectedClient()
      const detailed = options?.messages === true
      if (detailed) await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
      const readSession = () =>
        runNative(client, () =>
          Effect.runPromise(
            ctx.session.get({ sessionID: Session.ID.make(id) }).pipe(
              Effect.catch((error) => {
                // In-process core and HTTP protocol expose different pinned tags.
                if (isMissingNativeSession(error, id)) return Effect.succeed(null)
                return Effect.fail(error)
              }),
            ),
          ),
        )
      const session = await readSession()
      if (!session) {
        const before = await observeWorker(client, id, undefined, true)
        if (detailed) await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
        if (before.active || before.pendingInput)
          throw new Error("Native worker session is absent while execution or input is observed")
        return null
      }

      const before = await observeWorker(client, id, session.location.directory)
      const readMessages = () =>
        runNative(client, () =>
          Effect.runPromise(ctx.session.context({ sessionID: Session.ID.make(id) })),
        )
      const messagesBefore = detailed ? await readMessages() : []
      const inputBefore = detailed
        ? await resolveNativeInputID(messagesBefore, () => retainedInputID(id))
        : undefined
      const middle = detailed ? await readSession() : session
      if (!middle) {
        const after = await observeWorker(client, id, session.location.directory)
        if (before.active || after.active || before.pendingInput || after.pendingInput)
          throw new Error("Native worker session disappeared during execution observation")
        return null
      }
      const after = detailed ? await observeWorker(client, id, middle.location.directory) : before
      const messages = detailed ? await readMessages() : []
      const currentInputID = detailed
        ? await resolveNativeInputID(messages, () => retainedInputID(id))
        : undefined
      let retainedCurrentInput: HostMessage | undefined
      if (
        options?.messages &&
        isWorkerAgent(session.agent) &&
        currentInputID &&
        !messages.some((message) => message.id === currentInputID)
      ) {
        const input = await runNative(client, () =>
          client.session.message.get({
            sessionID: id,
            messageID: SessionMessage.ID.make(currentInputID),
          }),
        )
        if (input.id !== currentInputID || (input.type !== "user" && input.type !== "synthetic"))
          throw new Error("Retained current input does not match the native worker input")
        retainedCurrentInput = {
          id: input.id,
          type: input.type,
          text: input.text ?? "",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }
      }
      const latest = detailed ? await readSession() : session
      if (detailed) await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
      if (!latest) {
        if (before.active || after.active || before.pendingInput || after.pendingInput)
          throw new Error("Native worker session disappeared during execution observation")
        return null
      }

      const sessionIdentity = (value: NonNullable<typeof session>) =>
        JSON.stringify({
          id: value.id,
          parentID: value.parentID,
          projectID: value.projectID,
          agent: value.agent,
          attemptID: value.metadata?.lazersAttemptID,
          directory: value.location.directory,
          archived: value.time.archived !== undefined,
        })
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
        detailed &&
        (before.active !== after.active ||
          before.inbox !== after.inbox ||
          before.permissionRequests !== after.permissionRequests ||
          before.forms !== after.forms ||
          before.shells !== after.shells ||
          inputBefore !== currentInputID ||
          sessionIdentity(session) !== sessionIdentity(middle) ||
          sessionIdentity(middle) !== sessionIdentity(latest) ||
          beforeState !== sessionExecutionState(middle) ||
          sessionExecutionState(middle) !== afterState)
      const active = before.active || after.active
      const pendingInput = before.pendingInput || after.pendingInput
      const pendingPermissions = Math.max(before.pendingPermissions, after.pendingPermissions)
      const pendingForms = Math.max(before.pendingForms, after.pendingForms)
      const busyAt = latest.time.busy ? DateTime.toEpochMillis(latest.time.busy) : 0
      const idleAt = latest.time.idle ? DateTime.toEpochMillis(latest.time.idle) : 0
      const lastInputIndex = detailed
        ? messages.reduce(
            (index, message, current) =>
              message.id === currentInputID &&
              (message.type === "user" || message.type === "synthetic")
                ? current
                : index,
            -1,
          )
        : -1
      const response = currentInputID
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
      // Provider admission can fail before OpenCode creates an assistant message.
      const terminalMarker =
        lastInputIndex >= 0
          ? messages.slice(lastInputIndex + 1).findLast((message) => message.type === "idle")
          : undefined
      const failedBeforeResponse =
        response === undefined &&
        latest.outcome === "failed" &&
        terminalMarker?.outcome === "failed" &&
        idleAt > 0 &&
        DateTime.toEpochMillis(terminalMarker.time.created) === idleAt
      const turn = options?.messages
        ? {
            inputID: currentInputID ?? null,
            state: (currentInputID === undefined
              ? "unknown"
              : interrupted
                ? "interrupted"
                : response === undefined && !failedBeforeResponse
                  ? "pending"
                  : unfinishedAssistant
                    ? "interrupted"
                    : "completed") as "pending" | "completed" | "interrupted" | "unknown",
          }
        : undefined
      // Live background activity: read from the host now, never from a hook report.
      const runningShells = Math.max(before.runningShells, after.runningShells)
      const lineage = await runNative(client, () =>
        activeSessionLineage(client, id, latest.location.directory),
      )
      const activeChildren = lineage.activeDescendants.length
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
        ...(!observationUnstable || pendingInput ? { pendingInput } : {}),
        ...(!observationUnstable || pendingPermissions ? { pendingPermissions } : {}),
        ...(!observationUnstable || pendingForms ? { pendingForms } : {}),
        ...(observationUnstable ? { observationUnstable: true } : {}),
        ...(turn ? { turn } : {}),
        runningShells,
        activeChildren,
        ...(idleAt ? { idleAt } : {}),
        // Last model activity: request start or completion, whichever is later.
        ...(Math.max(busyAt, idleAt) > 0 ? { activityAt: Math.max(busyAt, idleAt) } : {}),
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
        // A compacted window can omit the real input's review binding. Read that
        // exact retained input without replaying history or changing turn evidence.
        messages: [
          ...(retainedCurrentInput ? [retainedCurrentInput] : []),
          ...messages.map((message) => ({
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
        ],
      }
    },
    async retireIntegratedWorker(input) {
      const client = await connectedClient()
      await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
      await runNative(client, async () => {
        const read = () => client.session.get({ sessionID: Session.ID.make(input.sessionID) })
        const observe = async () => {
          const session = await read()
          const [active, inventory] = await Promise.all([
            activeSessionLineage(client, input.sessionID, input.workspace),
            workerObservation(client, input.sessionID, input.workspace),
          ])
          const after = await read()
          if (
            session.id !== input.sessionID ||
            session.projectID !== input.projectID ||
            session.location.directory !== input.workspace ||
            session.metadata?.lazersAttemptID !== input.attemptID ||
            !isWorkerAgent(session.agent) ||
            !session.outcome ||
            !session.time.idle ||
            (session.time.busy ?? 0) >= session.time.idle ||
            JSON.stringify(session) !== JSON.stringify(after) ||
            active.activeRoot ||
            active.activeDescendants.length ||
            active.activeAtWorkspace.length ||
            inventory.active ||
            inventory.pendingInput ||
            inventory.locationPendingForms ||
            inventory.locationPendingPermissions ||
            inventory.runningShells
          )
            throw new Error(
              "Integrated worker or its workspace still has unsettled native activity",
            )
          return session
        }
        const before = await observe()
        if (before.time.archived === undefined)
          await client.session.update({ sessionID: input.sessionID, archived: true })
        const after = await observe()
        if (
          after.time.archived === undefined ||
          before.time.busy !== after.time.busy ||
          before.time.idle !== after.time.idle
        )
          throw new Error("Integrated worker archival or idle state could not be confirmed")
      })
    },
    async waitForSession(sessionID) {
      await Effect.runPromise(ctx.session.wait({ sessionID: Session.ID.make(sessionID) }))
    },
    async outcomeInbox(sessionID) {
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, sessionID))
      const entries = await runNative(client, () => client.session.inbox.list({ sessionID }))
      return entries.map(inboxEntry)
    },
    async architectInputPage(sessionID, cursor, known): Promise<ArchitectInputPage> {
      const client = await connectedClient()
      const target = await runNative(client, () => assertArchitectTarget(ctx, client, sessionID))
      const inbox = await runNative(client, () => client.session.inbox.list({ sessionID }))
      const observation = Number.isFinite(target.time.updated)
        ? {
            updatedAt: target.time.updated,
            inbox: JSON.stringify(
              inbox.map((entry) => ({
                id: entry.id,
                type: entry.type,
                delivery: "delivery" in entry ? entry.delivery : null,
              })),
            ),
          }
        : undefined
      if (
        !cursor &&
        known &&
        observation &&
        known.updatedAt === observation.updatedAt &&
        known.inbox === observation.inbox
      )
        return {
          inbox: [],
          messages: [],
          nextCursor: null,
          observation,
          unchanged: true,
          archived: target.time.archived !== undefined,
        }
      const page = await runNative(client, () =>
        client.message.list({
          sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "asc" }),
        }),
      )
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
        ...(observation ? { observation } : {}),
        archived: target.time.archived !== undefined,
      }
    },
    async architectSourceMessage(sessionID, messageID) {
      const client = await connectedClient()
      await runNative(client, () => assertArchitectTarget(ctx, client, sessionID))
      const message = await runNative(client, () =>
        client.session.message.get({ sessionID, messageID: SessionMessage.ID.make(messageID) }),
      )
      if (message.id !== messageID)
        throw new Error("Native source message read returned a different message ID")
      const privacy = privacyStats()
      if (message.type === "user" || message.type === "synthetic") {
        if (message.type === "user")
          privacy.omittedAttachments +=
            (message.files?.length ?? 0) +
            (message.agents?.length ?? 0) +
            (message.skills?.length ?? 0)
        return {
          id: message.id,
          type: message.type,
          text: safeText(message.text, privacy, 4_000),
          privacy,
        }
      }
      if (message.type !== "assistant")
        throw new Error("Selected source message is not a user, synthetic or assistant message")
      const text: string[] = []
      for (const part of message.content) {
        if (part.type === "text") text.push(part.text)
        else if (part.type === "reasoning") privacy.omittedReasoning++
        else privacy.omittedUnsupportedParts++
      }
      return {
        id: message.id,
        type: "assistant",
        text: safeText(text.join("\n"), privacy, 4_000),
        privacy,
      }
    },
    async cancelOutcome(input) {
      if (
        input.ownership.lazersSessionID !== input.sessionID ||
        input.ownership.lazersMessageID !== input.inboxID ||
        !sameProject(input.ownership.lazersProjectID, ctx.location.project.id) ||
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
    async ensureSourceGuard(input) {
      const client = await connectedClient()
      await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
      const receipt = await runNative(client, () =>
        client.rpc(SourceFence).status(
          {},
          {
            location: { directory: input.directory },
            signal: AbortSignal.timeout(10_000),
          },
        ),
      )
      await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
      if (
        receipt.pid !== dependencies.processID() ||
        input.projectID !== ctx.location.project.id ||
        receipt.projectID !== input.projectID ||
        receipt.directory !== input.directory ||
        resolve(receipt.databasePath) !== resolve(repository.path) ||
        !sourceGuardMatches({ repository }, input.directory, receipt.registrationID)
      )
        throw new Error("Native source guard is not the exact current location registration")
    },
    async archiveRetainedWorker(input) {
      const client = await connectedClient()
      const validate = async () => {
        await runNative(client, () => assertNativeProcess(ctx, client, dependencies))
        const target = await runNative(client, () =>
          client.session.get({ sessionID: input.sessionID }),
        )
        if (
          input.projectID !== ctx.location.project.id ||
          target.id !== input.sessionID ||
          target.projectID !== input.projectID ||
          !isWorkerAgent(target.agent) ||
          target.metadata?.lazersAttemptID !== input.attemptID ||
          target.location.directory !== input.directory
        )
          throw new Error("Native retained archive target is not the authorized worker assignment")
        const observed = await observeWorker(client, input.sessionID, input.directory)
        if (
          observed.active ||
          observed.pendingInput ||
          observed.pendingPermissions ||
          observed.pendingForms
        )
          throw new Error("Native retained archive worker has active input or approval work")
        const authorized = repository.atomic((db) =>
          db
            .query<
              { state: string; task_id: string; policy: string; review_input_json: string | null },
              string[]
            >(
              `SELECT a.state,a.task_id,a.policy,q.review_input_json FROM runner_source_quarantines q
            JOIN runner_attempts a ON a.id=q.attempt_id
            JOIN runner_plans p ON p.id=q.plan_id
            WHERE q.phase='pending' AND q.request_id=? AND q.plan_id=?
              AND q.attempt_id=? AND q.session_id=? AND q.assigned_message_id=?
              AND q.workspace=? AND q.requested_owner=p.owner
              AND p.project_directory=? AND a.plan_id=p.id AND a.state IN ('running','verifying')
              AND a.session_id=q.session_id AND a.message_id=q.assigned_message_id
              AND a.workspace=q.workspace`,
            )
            .get(
              input.requestID,
              input.planID,
              input.attemptID,
              input.sessionID,
              input.assignedMessageID,
              input.directory,
              repository.projectDirectory,
            ),
        )
        if (!authorized) throw new Error("Native retained archive request authority changed")
        const review = sourceReviewBinding(authorized)
        if (
          review?.inputID !== input.reviewInput?.inputID ||
          review?.requestID !== input.reviewInput?.requestID
        )
          throw new Error("Native retained archive review binding changed")
        if (
          authorized.state === "running" &&
          (await retainedNativeInputID(client, input.sessionID)) !==
            (review?.inputID ?? input.assignedMessageID)
        )
          throw new Error("Native retained archive current input changed")
        if (review) {
          const foreground = await host.session(input.sessionID, { messages: true })
          if (
            !foreground ||
            foreground.id !== input.sessionID ||
            foreground.projectID !== input.projectID ||
            foreground.directory !== input.directory ||
            !isWorkerAgent(foreground.agent) ||
            foreground.metadata?.lazersAttemptID !== input.attemptID ||
            foreground.busy ||
            foreground.observationUnstable ||
            foreground.pendingInput !== false ||
            foreground.pendingPermissions !== 0 ||
            foreground.pendingForms !== 0 ||
            foreground.outcome !== "succeeded" ||
            foreground.turn?.state !== "completed" ||
            foreground.turn.inputID !== review.inputID
          )
            throw new Error("Native retained review foreground is no longer completed and clear")
          const messages = foreground.messages.filter((message) => message.id === review.inputID)
          const metadata =
            messages.length === 1
              ? reviewMetadata(messages[0]!, {
                  taskID: authorized.task_id,
                  attemptID: input.attemptID,
                })
              : undefined
          const model = ModelPolicy.parse(JSON.parse(authorized.policy).model)
          if (metadata?.requestID !== review.requestID || !sameNativeModel(foreground.model, model))
            throw new Error("Native retained archive review metadata or route changed")
        }
        return target
      }
      if ((await validate()).time.archived !== undefined) return
      let updateError: unknown
      try {
        await client.session.update({ sessionID: input.sessionID, archived: true })
      } catch (error) {
        updateError = error
      }
      const readback = await validate()
      if (readback.time.archived === undefined)
        throw new Error(
          `Native retained worker archive lacks public readback${updateError ? `: ${String(updateError)}` : ""}`,
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
      const matchesAttempt = (session: typeof before) =>
        input.attemptID === undefined ||
        (session.id === input.sessionID &&
          session.projectID === ctx.location.project.id &&
          isWorkerAgent(session.agent) &&
          session.metadata?.lazersAttemptID === input.attemptID &&
          session.time.archived === undefined &&
          (!input.model || sameNativeModel(session.model, input.model)))
      if (!matchesAttempt(before))
        throw new Error("Worker prompt target is not the exact assigned session and route")
      if (before.location.directory !== input.directory) {
        if (input.moveIfNeeded === false)
          throw new Error("Retained worker is not in its assigned worktree; refusing to move it")
        await Effect.runPromise(
          ctx.session.move({ sessionID: id, directory: AbsolutePath.make(input.directory) }),
        )
        await Effect.runPromise(ctx.session.wait({ sessionID: id }))
      }
      const located = await Effect.runPromise(ctx.session.get({ sessionID: id }))
      if (located.location.directory !== input.directory || !matchesAttempt(located))
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
        (!sameProject(input.metadata.lazersProjectID, ctx.location.project.id) ||
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
        !isWorkerAgent(session.agent) ||
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
  return host
}
