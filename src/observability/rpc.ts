import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { callerSession } from "../projects/read-access.ts"

type ObservationContext = Pick<Plugin.Context, "permission" | "session">

export async function authorize(
  ctx: ObservationContext,
  scope: { sessionID: string },
  projectID: string,
  projectDirectory: string,
  action: "read" | "lz-inspect-trajectory",
) {
  const session = await callerSession(ctx, scope.sessionID, projectID)
  if (!session) throw new Error("Observation scope is unavailable")
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action,
      resources: action === "read" ? [projectDirectory] : ["*"],
    }),
  )
  return session.agent
}
