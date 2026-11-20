import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import {
  hostMessageAnchor,
  installHostMessageSchema,
  latestTurn,
  newMessages,
  sessionToolCount,
  type HostMessageClient,
} from "./host-messages.ts"

/** Opaque cursors: the cursor is the offset of the first message of the page it selects. */
function fakeHost(messages: { id: string }[]) {
  const calls: Array<{ cursor?: string; order?: string; limit?: number }> = []
  const client = {
    message: {
      list: async (input: { cursor?: string; order?: string; limit?: number }) => {
        calls.push({ cursor: input.cursor, order: input.order, limit: input.limit })
        const limit = input.limit ?? 50
        if (input.order === "desc") return { data: messages.slice(-limit).reverse(), cursor: {} }
        const start = input.cursor ? Number(input.cursor) : 0
        const data = messages.slice(start, start + limit)
        const next = start + limit < messages.length ? String(start + limit) : undefined
        return { data, cursor: { ...(next ? { next } : {}) } }
      },
    },
  } as unknown as HostMessageClient
  return { client, calls, messages }
}

async function drain(iterator: AsyncGenerator<readonly { id: string }[]>) {
  const ids: string[] = []
  for await (const page of iterator) ids.push(...page.map((message) => message.id))
  return ids
}

test("reads each page once, then only the tail page and newer messages", async () => {
  const fixture = makeFixture()
  try {
    const repository = fixture.store.repository
    installHostMessageSchema(repository)
    const host = fakeHost(Array.from({ length: 120 }, (_, index) => ({ id: `m${index}` })))
    expect((await drain(newMessages(repository, host.client, "ses", 50))).length).toBe(120)
    expect(host.calls.length).toBe(3)

    host.calls.length = 0
    host.messages.push({ id: "m120" })
    const second = await drain(newMessages(repository, host.client, "ses", 50))
    // One page: the 20-message tail plus the new message; never the first 100.
    expect(second).toEqual(host.messages.slice(100).map((message) => message.id))
    expect(host.calls.length).toBe(1)
    expect(hostMessageAnchor(repository, "ses")).toBe("100")
  } finally {
    fixture.close()
  }
})

test("a consumer that stops early keeps its page for the next read", async () => {
  const fixture = makeFixture()
  try {
    const repository = fixture.store.repository
    installHostMessageSchema(repository)
    const host = fakeHost(Array.from({ length: 120 }, (_, index) => ({ id: `m${index}` })))
    const iterator = newMessages(repository, host.client, "ses", 50)
    await iterator.next()
    await iterator.return({ tools: 0 })
    expect(hostMessageAnchor(repository, "ses")).toBeUndefined()
  } finally {
    fixture.close()
  }
})

test("latestTurn is one descending page of one", async () => {
  const host = fakeHost([{ id: "a" }, { id: "b" }])
  expect((await latestTurn(host.client, "ses"))?.id).toBe("b")
  expect(host.calls).toEqual([{ cursor: undefined, order: "desc", limit: 1 }])
})

test("the tool tally counts each message once though the tail page is delivered again", async () => {
  const fixture = makeFixture()
  try {
    const repository = fixture.store.repository
    installHostMessageSchema(repository)
    const tool = { type: "tool" }
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `m${index}`,
      type: "assistant",
      content: index % 2 === 0 ? [tool, tool] : [],
    }))
    const host = fakeHost(messages)
    expect(await sessionToolCount(repository, host.client, "ses")).toBe(120)
    expect(await sessionToolCount(repository, host.client, "ses")).toBe(120)
    host.messages.push({ id: "m120", type: "assistant", content: [tool] } as never)
    expect(await sessionToolCount(repository, host.client, "ses")).toBe(121)
    // The tally keeps its own cursor: the default reader still starts from the beginning.
    expect(hostMessageAnchor(repository, "ses")).toBeUndefined()
  } finally {
    fixture.close()
  }
})

test("a generation 1 cursor table gains the tool tally column and keeps its rows", () => {
  const fixture = makeFixture()
  try {
    const repository = fixture.store.repository
    repository.atomic((db) => {
      db.exec(`
        DROP TABLE IF EXISTS host_message_cursors;
        CREATE TABLE host_message_cursors (
          project_directory TEXT NOT NULL, session_id TEXT NOT NULL, anchor TEXT,
          updated_at INTEGER NOT NULL, PRIMARY KEY(project_directory, session_id)
        ) WITHOUT ROWID;
        INSERT INTO host_message_cursors VALUES('${repository.projectDirectory}','old','50',1);
        UPDATE schema_modules SET generation=1 WHERE module='host-messages';
      `)
    })
    installHostMessageSchema(repository)
    expect(hostMessageAnchor(repository, "old")).toBe("50")
    const columns = repository.read((db) =>
      db.query<{ name: string }, []>("PRAGMA table_info(host_message_cursors)").all(),
    )
    expect(columns.map((column) => column.name)).toContain("tool_count")
  } finally {
    fixture.close()
  }
})
