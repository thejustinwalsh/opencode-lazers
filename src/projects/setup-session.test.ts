import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { startSetupSession } from "./setup-session.ts"

test("the setup session is an Architect session in the project, titled and prompted", async () => {
  const calls: { method: string; input: Record<string, any> }[] = []
  const api = {
    create: (input: Record<string, any>) =>
      Effect.sync(() => void calls.push({ method: "create", input })),
    prompt: (input: Record<string, any>) =>
      Effect.sync(() => void calls.push({ method: "prompt", input })),
  } as unknown as Pick<Plugin.Context["session"], "create" | "prompt">
  const { sessionID } = await startSetupSession(api, {
    directory: "/work/alpha",
    code: "ALP",
    projectKey: "h.com/o/alpha",
    text: "Run the setup.",
  })
  expect(calls.map((call) => call.method)).toEqual(["create", "prompt"])
  expect(calls[0]!.input).toMatchObject({
    id: sessionID,
    agent: "architect",
    location: { directory: "/work/alpha" },
    title: "ALP · Set up LAZERS",
    metadata: { lazersProjectSetup: "h.com/o/alpha" },
  })
  expect(calls[1]!.input).toMatchObject({ sessionID, text: "Run the setup." })
})
