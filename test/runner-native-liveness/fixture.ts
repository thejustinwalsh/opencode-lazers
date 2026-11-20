import { DateTime, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { TaskRepository } from "../../src/storage.ts"
import {
  nativeHost,
  type NativeInboxClient,
  type NativeInboxDependencies,
} from "../../src/runner/native.ts"

export type NativeLivenessFixtureOptions = {
  sessionID?: string
  directory?: string
  /** The worker location is not loaded in the host; default is loaded. */
  unloadedLocation?: boolean
  version?: string
  expectedPID?: () => number
  serverInfo?: (clientNumber: number) => { pid: number; version: string }
  infoError?: Error
  discoveryError?: Error
  unavailable?: boolean
  active?: Record<string, { type: "running" }>
  activeSnapshots?: Array<Record<string, { type: "running" }>>
  activeError?: Error | (() => Error | undefined)
  inbox?: Array<{ id: string; type: string; delivery: string }>
  inboxError?: Error
  permissions?: Array<{ id: string; sessionID: string }>
  forms?: Array<{ id: string; sessionID: string }>
  shells?: Array<{
    id: string
    status: string
    cwd: string
    time: { started: number; completed?: number }
  }>
  /** Other native sessions by ID, e.g. children of the worker. */
  sessions?: Record<string, { parentID?: string; directory: string }>
  messages?: unknown[]
  history?: Array<{ id: string; type: string }>
  busy?: ReturnType<typeof DateTime.nowUnsafe>
  idle?: ReturnType<typeof DateTime.nowUnsafe>
  outcome?: "succeeded" | "failed" | "interrupted"
}

export function nativeLivenessFixture(options: NativeLivenessFixtureOptions = {}) {
  const sessionID = options.sessionID ?? "ses_worker"
  const directory = options.directory ?? "/project/.worktrees/attempt"
  const version = options.version ?? "2.2.5"
  let discoveries = 0
  let clients = 0
  let activeReads = 0
  let contextReads = 0
  /** Pages the host served from its message list: the only way the runner reads a conversation. */
  const messageListCalls: Array<{
    type?: string
    order?: string
    limit?: number
    cursor?: string
  }> = []
  let identityReads = 0
  const locationReads: { kind: "permission" | "form" | "shell"; directory: string }[] = []
  const session = {
    id: sessionID,
    parentID: "ses_owner",
    projectID: "project",
    agent: "lazers-implementor",
    metadata: { lazersAttemptID: "attempt" },
    location: { directory },
    time: {
      ...(options.busy ? { busy: options.busy } : {}),
      ...(options.idle ? { idle: options.idle } : {}),
    },
    tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
    outcome: options.outcome ?? "succeeded",
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
  }
  const client = (): NativeInboxClient => {
    clients++
    const clientNumber = clients
    return {
      server: {
        info: async () => {
          identityReads++
          if (options.infoError) throw options.infoError
          return options.serverInfo?.(clientNumber) ?? { pid: 42, version }
        },
      },
      debug: {
        location: {
          list: async () => (options.unloadedLocation ? [] : [{ directory }]),
        },
      },
      form: {
        list: async ({ location }: { location?: { directory?: string } } = {}) => {
          const requestedDirectory = location?.directory ?? ""
          locationReads.push({ kind: "form", directory: requestedDirectory })
          return {
            location: { directory: requestedDirectory },
            data: options.forms ?? [],
          }
        },
      },
      shell: {
        list: async ({ location }: { location?: { directory?: string } } = {}) => {
          locationReads.push({ kind: "shell", directory: location?.directory ?? "" })
          return { location: { directory: location?.directory ?? "" }, data: options.shells ?? [] }
        },
      },
      permission: {
        request: {
          list: async ({ location }: { location?: { directory?: string } } = {}) => {
            const requestedDirectory = location?.directory ?? ""
            locationReads.push({ kind: "permission", directory: requestedDirectory })
            return {
              location: { directory: requestedDirectory },
              data: options.permissions ?? [],
            }
          },
        },
      },
      session: {
        message: {
          get: async ({ messageID }: { messageID: string }) => {
            const message = options.history?.find((entry) => entry.id === messageID)
            if (!message) throw new Error("Retained input is unavailable")
            return message
          },
        },
        active: async () => {
          const error =
            typeof options.activeError === "function" ? options.activeError() : options.activeError
          if (error) throw error
          const snapshots = options.activeSnapshots
          const observed = snapshots?.[Math.min(activeReads, snapshots.length - 1)]
          activeReads++
          return observed ?? options.active ?? {}
        },
        get: async ({ sessionID: requested }: { sessionID: string } = { sessionID }) => {
          const other = options.sessions?.[requested]
          return other && requested !== sessionID
            ? {
                ...session,
                id: requested,
                parentID: other.parentID,
                location: { directory: other.directory },
              }
            : session
        },
        synthetic: async () => ({ id: "msg_synthetic" }),
        inbox: {
          list: async () => {
            if (options.inboxError) throw options.inboxError
            return options.inbox ?? []
          },
          cancel: async () => {},
        },
        update: async () => {},
      },
      message: {
        list: async (input: { type?: string; cursor?: string; order?: string; limit?: number }) => {
          if (input.type !== "user" && input.type !== "synthetic") {
            messageListCalls.push({
              type: input.type,
              order: input.order,
              limit: input.limit,
              cursor: input.cursor,
            })
            // Durable order: history before compaction, then the retained window. Cursors are
            // offsets into the requested order.
            const durable = [...(options.history ?? []), ...(options.messages ?? [])] as {
              type?: string
            }[]
            const filtered = input.type
              ? durable.filter((entry) => entry.type === input.type)
              : durable
            const ordered = input.order === "desc" ? [...filtered].reverse() : filtered
            const limit = input.limit ?? 50
            const start = input.cursor ? Number(input.cursor) : 0
            const next = start + limit < ordered.length ? String(start + limit) : undefined
            return {
              data: ordered.slice(start, start + limit),
              cursor: { ...(next ? { next } : {}) },
            }
          }
          const history = options.history ?? []
          const boundary = input.cursor
            ? history.findIndex((entry) => entry.id === input.cursor)
            : -1
          const entries = history.filter(
            (entry, index) => entry.type === input.type && (!input.cursor || index > boundary),
          )
          const entry = entries.at(-1)
          return { data: entry ? [entry] : [], cursor: { previous: entry?.id } }
        },
      },
    } as unknown as NativeInboxClient
  }
  const dependencies = {
    discover: async () => {
      discoveries++
      if (options.discoveryError) throw options.discoveryError
      if (options.unavailable) return undefined
      return { url: "https://opencode.localhost", auth: undefined }
    },
    make: () => client(),
    processID: () => options.expectedPID?.() ?? 42,
  } as NativeInboxDependencies
  const ctx = {
    app: { version },
    location: { directory: "/project", project: { id: "project" } },
    session: {
      get: () => Effect.succeed(session),
      context: () =>
        Effect.sync(() => {
          contextReads++
          return (options.messages ?? []) as never
        }),
    },
  } as unknown as Plugin.Context
  const host = nativeHost(ctx, { projectDirectory: "/project" } as TaskRepository, dependencies)
  return {
    host,
    session,
    get discoveries() {
      return discoveries
    },
    get clients() {
      return clients
    },
    get activeReads() {
      return activeReads
    },
    get contextReads() {
      return contextReads
    },
    messageListCalls,
    get identityReads() {
      return identityReads
    },
    locationReads,
  }
}
