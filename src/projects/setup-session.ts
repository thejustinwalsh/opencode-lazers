import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { sessionTitle } from "../runner/session-title.ts"

export type SetupSessionApi = Pick<Plugin.Context["session"], "create" | "prompt">

/**
 * Creates the Architect session that sets up a project's profile and prompts it with the runbook.
 * It is an ordinary native session: no machine, nothing waits on it, and an abandoned one leaves
 * the setup notice in place. It carries no continuation metadata, only the project it serves.
 */
export async function startSetupSession(
  api: SetupSessionApi,
  input: { directory: string; code: string; projectKey: string; text: string },
): Promise<{ sessionID: string }> {
  const id = Session.ID.create()
  await Effect.runPromise(
    api.create({
      id,
      location: { directory: AbsolutePath.make(input.directory) },
      agent: Agent.ID.make("architect"),
      title: sessionTitle(input.code, "Set up LAZERS"),
      metadata: { lazersProjectSetup: input.projectKey },
    }),
  )
  await Effect.runPromise(
    api.prompt({ sessionID: id, id: SessionMessage.ID.create(), text: input.text }),
  )
  return { sessionID: id }
}
