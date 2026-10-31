import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { registerTaskReviewTool } from "./review-tool.ts"
import { TaskReviewer } from "./task-review.ts"
import { validProposal } from "../../test/proposal.ts"

test("the native review tool checks permission before reading review state and returns next-step guidance", async () => {
  let tool: Parameters<ToolEditor["add"]>[0] | undefined
  let reads = 0
  let denied = true
  const reviewer = new TaskReviewer(
    {
      get: async () => {
        reads++
        return undefined
      },
      set: async () => {},
    },
    { systemOne: async () => ({ error: "Test GPU unavailable" }) },
  )
  await Effect.runPromise(
    Effect.scoped(
      registerTaskReviewTool(
        {
          location: { project: { canonical: "/synthetic/project" } } as Plugin.Context["location"],
          permission: {
            assert: () => (denied ? Effect.die(new Error("Denied review")) : Effect.void),
          },
          tool: {
            transform: (callback) =>
              Effect.sync(() => {
                callback({
                  add: (value) => {
                    tool = value
                  },
                  list: () => [],
                  get: () => undefined,
                  namespace: () => {},
                  update: () => {},
                  remove: () => {},
                })
                return { dispose: Effect.void }
              }),
          },
        },
        reviewer,
      ),
    ),
  )
  const context = {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make("architect"),
    messageID: SessionMessage.ID.create(),
    id: Tool.CallID.make("review-call"),
    progress: () => Effect.void,
  }
  const input = { task: validProposal(), request: "Keep submitted tasks after restart" }
  await expect(Effect.runPromise(tool!.execute(input, context))).rejects.toThrow("Denied review")
  expect(reads).toBe(0)
  denied = false
  const result = JSON.parse(
    String((await Effect.runPromise(tool!.execute(input, context))).content),
  )
  expect(result.status).toBe("unavailable")
  expect(result.next.tool).toBe("lazers_verify_task")
  expect(result.round).toBe(1)
  expect(reads).toBe(1)
})
