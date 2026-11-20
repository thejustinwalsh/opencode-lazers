import { expect, test } from "bun:test"
import type { HostSession } from "./host.ts"
import type { AttemptRow } from "./store.ts"
import { VerificationReview } from "./verification-review.ts"

const attempt = { session_id: "ses_worker", message_id: "msg_in" } as AttemptRow

function review(messages: HostSession["messages"], turnAssistants: number) {
  const reads = { session: 0, earlier: [] as number[] }
  const host = {
    session: async () => {
      reads.session++
      return { messages, turnAssistants, turn: { inputID: "msg_in", state: "completed" } }
    },
    earlierAssistantText: async (_session: string, skip: number) => {
      reads.earlier.push(skip)
      return "earlier words"
    },
  }
  const ask = () => VerificationReview.prototype.workerFinalMessage.call({ host } as never, attempt)
  return { ask, reads }
}

test("the worker's final message is the current turn's reply, with no extra read", async () => {
  const { ask, reads } = review(
    [
      { id: "msg_in", text: "Implement it" },
      { id: "msg_out", text: "All done" },
    ],
    1,
  )
  expect(await ask()).toBe("All done")
  expect(reads).toEqual({ session: 1, earlier: [] })
})

test("a turn without words reaches the reply before it with one bounded read", async () => {
  const { ask, reads } = review(
    [
      { id: "msg_in", text: "Implement it" },
      { id: "msg_tools", text: "" },
    ],
    1,
  )
  expect(await ask()).toBe("earlier words")
  // Skip the one assistant message this turn already holds.
  expect(reads).toEqual({ session: 1, earlier: [1] })
})
