import { expect, test } from "bun:test"
import { sessionMessageText } from "./server.ts"

test("a quoted message is one point read, and an absent one is undefined", async () => {
  const reads: Array<[string, string]> = []
  const text = sessionMessageText(async (sessionID, messageID) => {
    reads.push([sessionID, messageID])
    return messageID === "msg_here" ? { text: "the quoted words" } : undefined
  })
  expect(await text("ses_architect", "msg_here")).toBe("the quoted words")
  expect(await text("ses_architect", "msg_gone")).toBeUndefined()
  // Before: one whole `session.context` per check. Now: one read each.
  expect(reads).toEqual([
    ["ses_architect", "msg_here"],
    ["ses_architect", "msg_gone"],
  ])
})
