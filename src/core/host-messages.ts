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
        tool_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_directory, session_id)
      ) WITHOUT ROWID;
    `)
    // Generation 1 had no tally. The check runs on every generation bump, so a reload that
    // loads a newer bundle upgrades an older table the same way a restart does.
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(host_message_cursors)").all()
    if (!columns.some((column) => column.name === "tool_count"))
      db.exec("ALTER TABLE host_message_cursors ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0")
  })
}

/**
 * A reader's row key. The default reader owns the bare session ID; another reader (for example
 * the tool tally) keeps its own cursor so two consumers never move each other's anchor.
 */
function rowKey(sessionID: string, reader?: string) {
  return reader ? `${reader}:${sessionID}` : sessionID
}

type CursorRow = { anchor: string | undefined; tools: number }

function readRow(repository: TaskRepository, key: string): CursorRow {
  const row = repository.read((db) =>
    db
      .query<{ anchor: string | null; tool_count: number }, [string, string]>(
        "SELECT anchor,tool_count FROM host_message_cursors WHERE project_directory=? AND session_id=?",
      )
      .get(repository.projectDirectory, key),
  )
  return { anchor: row?.anchor ?? undefined, tools: row?.tool_count ?? 0 }
}

export function hostMessageAnchor(repository: TaskRepository, sessionID: string, reader?: string) {
  return readRow(repository, rowKey(sessionID, reader)).anchor
}

function setRow(
  repository: TaskRepository,
  key: string,
  anchor: string | undefined,
  tools: number,
) {
  repository.atomic((db) => {
    db.query(
      `INSERT INTO host_message_cursors(project_directory,session_id,anchor,updated_at,tool_count)
       VALUES(?,?,?,?,?)
       ON CONFLICT(project_directory,session_id)
       DO UPDATE SET anchor=excluded.anchor,updated_at=excluded.updated_at,tool_count=excluded.tool_count`,
    ).run(repository.projectDirectory, key, anchor ?? null, Date.now(), tools)
  })
}

/** Drop a session's cursor, for example when its conversation is deleted or rewritten. */
export function forgetHostMessages(repository: TaskRepository, sessionID: string, reader?: string) {
  repository.atomic((db) => {
    db.query("DELETE FROM host_message_cursors WHERE project_directory=? AND session_id=?").run(
      repository.projectDirectory,
      rowKey(sessionID, reader),
    )
  })
}

/** Tool parts of the assistant messages in a page. */
export function toolsIn(messages: readonly HostMessage[]): number {
  let tools = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) if (part.type === "tool") tools++
  }
  return tools
}

/**
 * Pages of messages at and after the stored anchor, oldest first. The anchor advances only
 * after the consumer asks for the following page, so a consumer that throws re-reads its page.
 *
 * The row also keeps `tool_count`: the tool parts of every message before the anchor page. It
 * moves with the anchor, so the tail page that is delivered again is never counted twice, and
 * the generator returns the session's cumulative total (`base + tail page`).
 */
export async function* newMessages(
  repository: TaskRepository,
  client: HostMessageClient,
  sessionID: string,
  pageSize = HOST_MESSAGE_PAGE_SIZE,
  reader?: string,
): AsyncGenerator<readonly HostMessage[], { tools: number }, void> {
  const key = rowKey(sessionID, reader)
  const stored = readRow(repository, key)
  let cursor = stored.anchor
  let base = stored.tools
  const seen = new Set<string>()
  for (;;) {
    const page = await client.message.list({
      sessionID: sessionID as never,
      limit: pageSize,
      ...(cursor ? { cursor } : { order: "asc" as const }),
    })
    if (page.data.length > 0) yield page.data
    const here = toolsIn(page.data)
    const next = page.cursor.next
    if (!next || next === cursor || seen.has(next)) {
      // End of history: keep this page's anchor so the tail is re-read next time.
      const current = readRow(repository, key)
      if (cursor !== current.anchor || base !== current.tools) setRow(repository, key, cursor, base)
      return { tools: base + here }
    }
    seen.add(next)
    base += here
    cursor = next
    setRow(repository, key, cursor, base)
  }
}

/**
 * Cumulative tool calls of a session: one cursor pass of the tool reader. It keeps its own
 * cursor, so it costs the tail page when nothing is new and never moves another reader's anchor.
 */
export async function sessionToolCount(
  repository: TaskRepository,
  client: HostMessageClient,
  sessionID: string,
): Promise<number> {
  const pages = newMessages(repository, client, sessionID, HOST_MESSAGE_PAGE_SIZE, "tools")
  for (;;) {
    const step = await pages.next()
    if (step.done) return step.value.tools
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

/**
 * The assistant messages at the end of a session, oldest first: the steps of the last
 * execution. Read newest page first and stop at the first message that is not an assistant's,
 * so a reply costs its own pages, never the conversation.
 */
export async function trailingAssistants(
  client: HostMessageClient,
  sessionID: string,
  pageSize = HOST_MESSAGE_PAGE_SIZE,
): Promise<readonly Extract<HostMessage, { type: "assistant" }>[]> {
  const newestFirst: Extract<HostMessage, { type: "assistant" }>[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await client.message.list({
      sessionID: sessionID as never,
      order: "desc",
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    })
    for (const message of page.data) {
      if (message.type !== "assistant") return newestFirst.reverse()
      newestFirst.push(message)
    }
    const next = page.cursor.next
    if (!next || seen.has(next)) return newestFirst.reverse()
    seen.add(next)
    cursor = next
  }
}

/**
 * Whether message `earlierID` (accepted by `isEarlier`) comes before message `laterID` in the
 * session's order. Reads newest page first: the later message is normally at the tail, so the
 * check costs the pages between the two, never the conversation. False when either is missing.
 */
export async function precedesInSession(
  client: HostMessageClient,
  sessionID: string,
  earlier: (message: HostMessage) => boolean,
  laterID: string,
  pageSize = HOST_MESSAGE_PAGE_SIZE,
): Promise<boolean> {
  let seenLater = false
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await client.message.list({
      sessionID: sessionID as never,
      order: "desc",
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    })
    for (const message of page.data) {
      if (message.id === laterID) seenLater = true
      else if (earlier(message)) return seenLater
    }
    const next = page.cursor.next
    if (!next || seen.has(next)) return false
    seen.add(next)
    cursor = next
  }
}
