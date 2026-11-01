import type { Plugin } from "@opencode/plugin/effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect } from "effect"

export type RadarNativeSession = {
  id: string
  projectID: string
  parentID: string | null
  directory: string
  agent: string | null
  model: { providerID: string; id: string; variant: string | null } | null
  archived: boolean
  busy: boolean | null
  createdAt: number | null
  updatedAt: number | null
}

export type RadarSessionInventory = {
  sessions: RadarNativeSession[]
  truncated: boolean
}

export type RadarSessionHost = {
  get(sessionID: string, signal: AbortSignal): Promise<RadarNativeSession | null>
  project(
    projectID: string,
    includeArchived: boolean,
    limit: number,
    signal: AbortSignal,
  ): Promise<RadarSessionInventory>
  descendants(
    projectID: string,
    rootSessionID: string,
    includeArchived: boolean,
    limit: number,
    signal: AbortSignal,
  ): Promise<RadarSessionInventory>
}

type SessionInfo = Pick<
  Session.Info,
  "id" | "parentID" | "projectID" | "agent" | "model" | "time" | "location"
>
type SessionPage = {
  data: readonly SessionInfo[]
  cursor: { next?: Session.ListCursor }
}
type SessionListRequest = {
  projectID: string
  parentID?: string
  archived: boolean
  limit: number
  cursor?: Session.ListCursor
}
type SessionSource = {
  list(request: SessionListRequest, signal: AbortSignal): Promise<SessionPage>
  get(sessionID: string, signal: AbortSignal): Promise<SessionInfo | null>
}

const PAGE_SIZE = 100
const MAX_SESSIONS = 500

function sessionLimit(limit: number) {
  return Math.min(MAX_SESSIONS, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0)
}

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SessionNotFoundError"

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError")
}

function view(session: SessionInfo): RadarNativeSession {
  const busyAt = session.time.busy ? DateTime.toEpochMillis(session.time.busy) : null
  const idleAt = session.time.idle ? DateTime.toEpochMillis(session.time.idle) : null
  return {
    id: session.id,
    projectID: session.projectID,
    parentID: session.parentID ?? null,
    directory: session.location.directory,
    agent: session.agent ?? null,
    model: session.model
      ? {
          providerID: session.model.providerID,
          id: session.model.id,
          variant: session.model.variant ?? null,
        }
      : null,
    archived: session.time.archived !== undefined,
    busy: busyAt === null ? (idleAt === null ? null : false) : busyAt > (idleAt ?? 0),
    createdAt: DateTime.toEpochMillis(session.time.created),
    updatedAt: DateTime.toEpochMillis(session.time.updated),
  }
}

/** Public session.list/get adapter with a hard page and inventory bound. */
export function createRadarSessionHost(source: SessionSource): RadarSessionHost {
  async function collect(
    projectID: string,
    parentID: string | undefined,
    includeArchived: boolean,
    limit: number,
    signal: AbortSignal,
  ): Promise<RadarSessionInventory> {
    const cap = sessionLimit(limit)
    const sessions: RadarNativeSession[] = []
    const seen = new Set<string>()
    let truncated = false
    let pages = 0
    const maxPages = Math.ceil(Math.max(1, cap) / PAGE_SIZE) + 2
    for (const archived of includeArchived ? [false, true] : [false]) {
      let cursor: Session.ListCursor | undefined
      const seenCursors = new Set<string>()
      while (true) {
        abortIfNeeded(signal)
        if (sessions.length >= cap) {
          truncated = true
          break
        }
        if (pages >= maxPages) {
          truncated = true
          break
        }
        pages++
        const page = await source.list(
          {
            projectID,
            ...(parentID ? { parentID } : {}),
            archived,
            limit: Math.min(PAGE_SIZE, cap - sessions.length),
            ...(cursor ? { cursor } : {}),
          },
          signal,
        )
        for (const info of page.data) {
          if (info.projectID !== projectID || seen.has(info.id)) continue
          seen.add(info.id)
          sessions.push(view(info))
        }
        const next = page.cursor.next
        if (!next) break
        const cursorKey = String(next)
        if (seenCursors.has(cursorKey)) {
          truncated = true
          break
        }
        seenCursors.add(cursorKey)
        cursor = next
      }
      if (sessions.length >= cap) {
        if (includeArchived && !archived) truncated = true
        break
      }
    }
    return { sessions, truncated }
  }

  return {
    async get(sessionID, signal) {
      abortIfNeeded(signal)
      try {
        const session = await source.get(sessionID, signal)
        return session ? view(session) : null
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    project(projectID, includeArchived, limit, signal) {
      return collect(projectID, undefined, includeArchived, limit, signal)
    },
    async descendants(projectID, rootSessionID, includeArchived, limit, signal) {
      const cap = sessionLimit(limit)
      const sessions: RadarNativeSession[] = []
      const visited = new Set([rootSessionID])
      const pending = [rootSessionID]
      let truncated = false
      while (pending.length) {
        abortIfNeeded(signal)
        const parentID = pending.shift()!
        const page = await collect(
          projectID,
          parentID,
          includeArchived,
          cap - sessions.length,
          signal,
        )
        truncated ||= page.truncated
        for (const session of page.sessions) {
          if (visited.has(session.id)) continue
          visited.add(session.id)
          sessions.push(session)
          pending.push(session.id)
          if (sessions.length >= cap) {
            truncated ||= pending.length > 0
            return { sessions, truncated }
          }
        }
        if (truncated && sessions.length >= cap) break
      }
      return { sessions, truncated }
    },
  }
}

export function nativeRadarSessionHost(ctx: Pick<Plugin.Context, "session">): RadarSessionHost {
  return createRadarSessionHost({
    list: async (request, signal) => {
      const result = await Effect.runPromise(
        ctx.session.list({
          project: Project.ID.make(request.projectID),
          ...(request.parentID ? { parentID: Session.ID.make(request.parentID) } : {}),
          archived: request.archived,
          order: "desc",
          limit: request.limit,
          ...(request.cursor ? { cursor: request.cursor } : {}),
        }),
        { signal },
      )
      return result
    },
    get: async (sessionID, signal) =>
      await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }), {
        signal,
      }),
  })
}
