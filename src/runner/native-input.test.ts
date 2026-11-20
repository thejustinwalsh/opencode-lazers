import { expect, test } from "bun:test"
import { assertHostListQuery } from "../../test/host-list-fake.ts"
import type { OpenCode } from "@opencode/client"
import { resolveNativeInputID, retainedNativeInputID } from "./native-input.ts"

const user = { type: "user", id: "msg_z", time: { created: 100 } }
const steering = { type: "synthetic", id: "msg_a", time: { created: 100 } }
const instructions = {
  type: "synthetic",
  id: "msg_instructions",
  metadata: { instruction: { paths: ["/project/AGENTS.md"] } },
}

const continuations = [
  "The previous response was interrupted. Continue from where you left off without repeating completed content.",
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.",
].map((text, index) => ({ type: "synthetic", id: `msg_continue_${index}`, text }))

test("pinned native continuation notes preserve the logical input in visible context", async () => {
  for (const note of continuations) {
    expect(await resolveNativeInputID([user, note], async () => undefined)).toBe(user.id)
    expect(await resolveNativeInputID([user, steering, note], async () => undefined)).toBe(
      steering.id,
    )
    for (const explicitInput of [
      { ...note, type: "user" },
      { ...note, text: `${note.text} Also change the goal.` },
      { ...note, metadata: { source: "another-plugin" } },
    ]) {
      expect(await resolveNativeInputID([user, explicitInput], async () => undefined)).toBe(
        explicitInput.id,
      )
    }
  }
})

test("instruction context does not replace user input or genuine synthetic steering", async () => {
  const retained = async () => {
    throw new Error("Visible input should not need history")
  }
  expect(await resolveNativeInputID([user, instructions], retained)).toBe(user.id)
  expect(await resolveNativeInputID([user, steering, instructions], retained)).toBe(steering.id)
  expect(await resolveNativeInputID([{ ...instructions, type: "user" }], retained)).toBe(
    instructions.id,
  )
})

test("unknown and malformed synthetic metadata remains input regardless of its prose", async () => {
  for (const metadata of [
    undefined,
    {},
    { instruction: {} },
    { instruction: { paths: [] } },
    { instruction: { paths: [7] } },
    { instruction: { paths: "AGENTS.md" } },
  ]) {
    expect(
      await resolveNativeInputID(
        [
          user,
          {
            ...steering,
            metadata,
            text: "Instructions from: /project/AGENTS.md",
            description: "Loaded AGENTS.md",
          },
        ],
        async () => undefined,
      ),
    ).toBe(steering.id)
  }
})

test("completed compaction recovers retained input when only instruction context is visible", async () => {
  let reads = 0
  const retained = async () => {
    reads++
    return user.id
  }
  expect(
    await resolveNativeInputID(
      [{ type: "compaction", status: "completed" }, instructions, { type: "idle" }],
      retained,
    ),
  ).toBe(user.id)
  expect(reads).toBe(1)
  expect(await resolveNativeInputID([instructions], retained)).toBeUndefined()
  expect(
    await resolveNativeInputID([{ type: "compaction", status: "failed" }, instructions], retained),
  ).toBeUndefined()
  expect(reads).toBe(1)
})

type Query = { sessionID: string; type?: string; order?: string; limit?: number; cursor?: string }
type Page = { data: unknown[]; cursor: { next?: string | null; previous?: string | null } }
function clientFor(pages: Record<string, Page>) {
  const queries: Query[] = []
  const client = {
    message: {
      list: async (query: Query) => {
        queries.push(query)
        assertHostListQuery(query)
        expect(query.sessionID).toBe("ses_worker")
        expect(query.limit).toBe(1)
        const page = pages[query.cursor ?? query.type ?? ""]
        if (!page) throw new Error(`Unexpected history query ${JSON.stringify(query)}`)
        return page
      },
    },
  } as unknown as Pick<ReturnType<typeof OpenCode.make>, "message">
  return { client, queries }
}

test("retained input skips all native instruction pages and falls back to the assigned user", async () => {
  const { client, queries } = clientFor({
    user: { data: [user], cursor: {} },
    synthetic: { data: [instructions], cursor: { next: "older" } },
    older: { data: [instructions], cursor: { next: null } },
  })
  expect(await retainedNativeInputID(client, "ses_worker")).toBe(user.id)
  expect(queries[2]).toEqual({
    sessionID: "ses_worker",
    type: "synthetic",
    cursor: "older",
    limit: 1,
  })
})

test("retained provider continuation notes do not replace the original assigned input", async () => {
  const { client, queries } = clientFor({
    user: { data: [user], cursor: {} },
    synthetic: { data: [continuations[1]], cursor: { next: "previous-continuation" } },
    "previous-continuation": { data: [continuations[0]], cursor: { next: "instructions" } },
    instructions: { data: [instructions], cursor: {} },
  })
  expect(await retainedNativeInputID(client, "ses_worker")).toBe(user.id)
  expect(queries).toHaveLength(4)
})

test("retained steering uses its own host-order cursor after instruction context is skipped", async () => {
  for (const newerUser of [false, true]) {
    const { client, queries } = clientFor({
      user: { data: [user], cursor: {} },
      synthetic: { data: [instructions], cursor: { next: "older", previous: "wrong-anchor" } },
      older: { data: [steering], cursor: { previous: "steering-anchor" } },
      "steering-anchor": { data: newerUser ? [user] : [], cursor: {} },
    })
    expect(await retainedNativeInputID(client, "ses_worker")).toBe(
      newerUser ? user.id : steering.id,
    )
    expect(queries[3]).toEqual({
      sessionID: "ses_worker",
      type: "user",
      cursor: "steering-anchor",
      limit: 1,
    })
  }
})

test("synthetic-only histories retain steering but never instruction-only context", async () => {
  for (const older of [[], [steering]]) {
    const { client } = clientFor({
      user: { data: [], cursor: {} },
      synthetic: { data: [instructions], cursor: { next: "older" } },
      older: { data: older, cursor: {} },
    })
    expect(await retainedNativeInputID(client, "ses_worker")).toBe(
      older.length ? steering.id : undefined,
    )
  }
})

test("non-advancing instruction history fails rather than looping or inventing input", async () => {
  const { client, queries } = clientFor({
    user: { data: [user], cursor: {} },
    synthetic: { data: [instructions], cursor: { next: "repeat" } },
    repeat: { data: [instructions], cursor: { next: "repeat" } },
  })
  await expect(retainedNativeInputID(client, "ses_worker")).rejects.toThrow(
    "cursor did not advance",
  )
  expect(queries).toHaveLength(3)
})
