import { expect, test } from "bun:test"
import { inspectTrajectory } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { HOST_MESSAGE_PAGE_SIZE } from "../core/host-messages.ts"
import type { MessageSink, TrajectoryHost, TrajectorySession } from "./native.ts"
import { makeFixture, cursorSecret, taskID } from "../../test/trajectory/fixture.ts"

/** The whole event projection in one read: `inspectTrajectory` with every event (the old capture). */
const captureTrajectoryHistory = (
  store: Parameters<typeof inspectTrajectory>[0],
  host: Parameters<typeof inspectTrajectory>[1],
  projectID: string,
  input: Parameters<typeof inspectTrajectory>[3],
  cursorSecret: Uint8Array,
  options: NonNullable<Parameters<typeof inspectTrajectory>[5]> = {},
) => inspectTrajectory(store, host, projectID, input, cursorSecret, { ...options, allEvents: true })

/** 500 messages per session: the fixture's own, then numbered clones with varied models. */
function expand(sessions: Iterable<TrajectorySession>, count: number) {
  for (const session of sessions) {
    const base = [...(session.messages ?? [])] as Array<Record<string, unknown>>
    const messages: unknown[] = [...base]
    for (let index = base.length; index < count; index++) {
      const source = base[index % base.length]!
      const model = source.model as { id: string } | undefined
      messages.push({
        ...source,
        id: `${String(source.id)}-${index}`,
        time: { created: 2000 + index },
        ...(model ? { model: { ...model, id: `${model.id}-${index % 7}` } } : {}),
      })
    }
    session.messages = messages as never
  }
}

/** The host a real adapter is: pages go to the sink, and the session it returns holds none. */
function pagingHost(
  sessions: Map<string, TrajectorySession>,
  held: { peak: number; pages: number },
): TrajectoryHost {
  return {
    session: async (id, _attempt, sink?: MessageSink) => {
      const session = sessions.get(id)
      if (!session) return null
      const all = session.messages ?? []
      for (let start = 0; start < all.length; start += HOST_MESSAGE_PAGE_SIZE) {
        const page = all.slice(start, start + HOST_MESSAGE_PAGE_SIZE)
        held.peak = Math.max(held.peak, page.length)
        held.pages++
        sink!(page)
      }
      return { ...session, messages: null }
    },
  }
}

test("a 500-message transcript folded page by page reports exactly what the whole array did", async () => {
  const fixture = makeFixture()
  try {
    expand(fixture.sessions.values(), 500)
    const input = InspectTrajectoryInput.parse({ taskID, limit: 50 })
    const held = { peak: 0, pages: 0 }
    const paged = pagingHost(fixture.sessions, held)

    const wholeFirst = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      input,
      cursorSecret,
    )
    const pagedFirst = await inspectTrajectory(fixture.store, paged, "project", input, cursorSecret)
    expect(pagedFirst).toEqual(wholeFirst)

    const wholeAll = await captureTrajectoryHistory(
      fixture.store,
      fixture.host,
      "project",
      input,
      cursorSecret,
    )
    const pagedAll = await captureTrajectoryHistory(
      fixture.store,
      paged,
      "project",
      input,
      cursorSecret,
    )
    expect(pagedAll).toEqual(wholeAll)
    expect(wholeAll.trajectory.events.length).toBeGreaterThan(500)
    // What came from the folds: the models seen across all 500 messages.
    expect(JSON.stringify(pagedAll)).toContain("gpt-6-luna-3")
    // Peak messages handed over at once: one page, where the array path held all 500
    // (and a long history held up to 10,001).
    expect(held.peak).toBe(HOST_MESSAGE_PAGE_SIZE)
    expect(held.pages).toBeGreaterThanOrEqual(2 * Math.ceil(500 / HOST_MESSAGE_PAGE_SIZE))
  } finally {
    fixture.close()
  }
})

test("a continuation cursor is bound to the transcript through its digest", async () => {
  const fixture = makeFixture()
  try {
    const input = InspectTrajectoryInput.parse({ taskID, limit: 2 })
    const host = () => pagingHost(fixture.sessions, { peak: 0, pages: 0 })
    const first = await inspectTrajectory(fixture.store, host(), "project", input, cursorSecret)
    const cursor = first.trajectory.nextCursor!
    expect(cursor).toBeTruthy()
    const next = await inspectTrajectory(
      fixture.store,
      host(),
      "project",
      { ...input, cursor },
      cursorSecret,
    )
    expect(next.trajectory.events.length).toBeGreaterThan(0)
    // A transcript that changed between pages is a stale cursor.
    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...session.messages!,
      { id: "later", type: "user", time: { created: 5 } },
    ] as never
    await expect(
      inspectTrajectory(fixture.store, host(), "project", { ...input, cursor }, cursorSecret),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
  }
})
