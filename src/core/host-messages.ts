import type { OpenCode } from "@opencode/client"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * Host cursor mirror: read a session's messages by cursor instead of `session.context`.
 *
 * Each session keeps one durable `anchor`: the opaque host cursor of the last page read.
 * `newMessages` pages forward from the anchor and moves it after each page the caller has
 * consumed. The final page has no `next` cursor, so its anchor is kept; the next call re-reads
 * that one page (at most `pageSize` messages) plus anything newer. That bounds every check to
 * one page, never the whole conversation, and re-delivers the tail messages that may still be
 * streaming, so consumers must treat delivery as at-least-once and diff by message id.
 *
 * `session.context` stays reserved for building model prompts.
 */
export type HostMessageClient = {
  message: Pick<ReturnType<typeof OpenCode.make>["message"], "list">
}
export type HostMessage = Awaited<ReturnType<HostMessageClient["message"]["list"]>>["data"][number]

export const HOST_MESSAGE_PAGE_SIZE = 50

export function installHostMessageSchema(repository: TaskRepository) {
  const module = schemaModules["host-messages"]
  repository.installSchema("host-messages", module.generation, module.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_message_cursors (
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        anchor TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory, session_id)
      ) WITHOUT ROWID;
    `)
  })
}

export function hostMessageAnchor(repository: TaskRepository, sessionID: string) {
  return repository.read(
    (db) =>
      db
        .query<{ anchor: string | null }, [string, string]>(
          "SELECT anchor FROM host_message_cursors WHERE project_directory=? AND session_id=?",
        )
        .get(repository.projectDirectory, sessionID)?.anchor ?? undefined,
  )
}

function setAnchor(repository: TaskRepository, sessionID: string, anchor: string | undefined) {
  repository.atomic((db) => {
    db.query(
      `INSERT INTO host_message_cursors(project_directory,session_id,anchor,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(project_directory,session_id)
       DO UPDATE SET anchor=excluded.anchor,updated_at=excluded.updated_at`,
    ).run(repository.projectDirectory, sessionID, anchor ?? null, Date.now())
  })
}

/** Drop a session's cursor, for example when its conversation is deleted or rewritten. */
export function forgetHostMessages(repository: TaskRepository, sessionID: string) {
  repository.atomic((db) => {
    db.query("DELETE FROM host_message_cursors WHERE project_directory=? AND session_id=?").run(
      repository.projectDirectory,
      sessionID,
    )
  })
}

/**
 * Pages of messages at and after the stored anchor, oldest first. The anchor advances only
 * after the consumer asks for the following page, so a consumer that throws re-reads its page.
 */
export async function* newMessages(
  repository: TaskRepository,
  client: HostMessageClient,
  sessionID: string,
  pageSize = HOST_MESSAGE_PAGE_SIZE,
): AsyncGenerator<readonly HostMessage[], void, void> {
  let cursor = hostMessageAnchor(repository, sessionID)
  const seen = new Set<string>()
  for (;;) {
    const page = await client.message.list({
      sessionID: sessionID as never,
      limit: pageSize,
      ...(cursor ? { cursor } : { order: "asc" as const }),
    })
    if (page.data.length > 0) yield page.data
    const next = page.cursor.next
    if (!next || next === cursor || seen.has(next)) {
      // End of history: keep this page's anchor so the tail is re-read next time.
      if (cursor !== hostMessageAnchor(repository, sessionID))
        setAnchor(repository, sessionID, cursor)
      return
    }
    seen.add(next)
    cursor = next
    setAnchor(repository, sessionID, cursor)
  }
}

/** The latest message of a session: one descending page of one. */
export async function latestTurn(
  client: HostMessageClient,
  sessionID: string,
): Promise<HostMessage | undefined> {
  const page = await client.message.list({
    sessionID: sessionID as never,
    order: "desc",
    limit: 1,
  })
  return page.data[0]
}

/** The newest `limit` messages of a session, oldest first: one descending page. */
export async function latestMessages(
  client: HostMessageClient,
  sessionID: string,
  limit = HOST_MESSAGE_PAGE_SIZE,
): Promise<readonly HostMessage[]> {
  const page = await client.message.list({
    sessionID: sessionID as never,
    order: "desc",
    limit,
  })
  return [...page.data].reverse()
}
