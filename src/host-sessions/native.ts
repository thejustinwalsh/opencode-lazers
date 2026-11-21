import type { Plugin } from "@opencode/plugin/effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect } from "effect"
import { hostPage } from "../core/host-page.ts"
import type { RunnerHost } from "../runner/host.ts"
import type { HostSessionRecord, HostSessionSource } from "./state.ts"

type SessionInfo = Pick<
  Session.Info,
  | "id"
  | "parentID"
  | "projectID"
  | "agent"
  | "title"
  | "model"
  | "time"
  | "location"
  | "tokens"
  | "outcome"
>

/** Sessions per inventory page. */
const LIST_PAGE = 100

const millis = (value: DateTime.Utc | undefined) =>
  value === undefined ? null : DateTime.toEpochMillis(value)

/** The stored facts of one host session record: its own fields only, no message text. */
function sessionRecord(info: SessionInfo): HostSessionRecord {
  const busyAt = millis(info.time.busy)
  const idleAt = millis(info.time.idle)
  return {
    id: info.id,
    projectID: info.projectID,
    parentID: info.parentID ?? null,
    agent: info.agent ?? null,
    title: info.title ?? null,
    directory: info.location.directory,
    archived: info.time.archived !== undefined,
    busy: busyAt !== null && busyAt > (idleAt ?? 0),
    busyAt,
    idleAt,
    outcome: info.outcome ?? null,
    model: info.model
      ? {
          providerID: info.model.providerID,
          id: info.model.id,
          variant: info.model.variant ?? null,
        }
      : null,
    tokensIn: info.tokens.input,
    tokensOut: info.tokens.output,
    tokensReasoning: info.tokens.reasoning,
    tokensCacheRead: info.tokens.cache.read,
    tokensCacheWrite: info.tokens.cache.write,
    createdAt: millis(info.time.created),
    updatedAt: DateTime.toEpochMillis(info.time.updated),
  }
}

const notFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SessionNotFoundError"

/**
 * The fold's host reads: `session.get` and `session.list` from the plugin context (one call
 * each), and the pending counts from the runner host's metadata read (`RunnerHost.session`
 * without messages: the inbox, permission, form and active-session reads it makes for workers).
 */
export function nativeHostSessionSource(
  ctx: Pick<Plugin.Context, "session">,
  runner: Pick<RunnerHost, "session">,
): HostSessionSource {
  return {
    async get(sessionID) {
      const info = await Effect.runPromise(
        ctx.session
          .get({ sessionID: Session.ID.make(sessionID) })
          .pipe(
            Effect.catch((error) => (notFound(error) ? Effect.succeed(null) : Effect.fail(error))),
          ),
      )
      return info ? sessionRecord(info) : null
    },
    async pending(sessionID) {
      const session = await runner.session(sessionID, { messages: false })
      if (!session) return null
      // Counts the host could not read steadily are omitted: read again rather than store a guess.
      if (session.observationUnstable)
        throw new Error("Native session observation changed during the read")
      return {
        busy: session.busy,
        pendingInput: session.pendingInput ?? false,
        pendingPermissions: session.pendingPermissions ?? 0,
        pendingForms: session.pendingForms ?? 0,
        outcome: session.outcome ?? null,
      }
    },
    async list(projectID, cursor) {
      const page = await Effect.runPromise(
        ctx.session.list({
          project: Project.ID.make(projectID),
          archived: false,
          limit: LIST_PAGE,
          ...hostPage("desc", cursor as Session.ListCursor | undefined),
        }),
      )
      return {
        records: page.data.map(sessionRecord),
        ...(page.cursor.next ? { next: String(page.cursor.next) } : {}),
      }
    },
  }
}
