import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { ProgressStaleness } from "./progress/stale-reminder.ts"
import { toolObservationScope } from "./progress/tool-observation.ts"
import { isWorkerAgent } from "./runner/worker-agent.ts"
import { explainInvalidInput } from "./tool-input.ts"

/** The alias note OpenCode's input-repair plugin appends to a failure; keep it when rewriting. */
const REPAIR_NOTE = /\n\nThere is no "[^"\n]*" tool, so this ran as[^\n]*$/

function appendNote(result: { content?: unknown; output?: unknown }, note: string) {
  const content = result.content
  result.content =
    typeof content === "string"
      ? `${content}\n\n${note}`
      : [
          ...(Array.isArray(content) && content.length > 0
            ? content
            : result.output === undefined
              ? []
              : [{ type: "text", text: JSON.stringify(result.output) }]),
          { type: "text", text: note },
        ]
  // Code Mode hands a script `output` when a tool declares one, so the note rides there too.
  const output = result.output
  if (typeof output === "string") result.output = `${output}\n\n${note}`
  else if (typeof output === "object" && output !== null && !Array.isArray(output))
    result.output = { ...output, reminder: note }
}

/**
 * Two things a LAZERS tool result can carry, both added after the tool has run, in one place:
 *
 * - On a failed call whose arguments do not match the tool's input, the failure becomes the plain
 *   list of what was wrong plus the tool's full usage. OpenCode has already repaired what it can
 *   (text to numbers, stray keys dropped) before this runs, so this only explains what remains.
 *   A correct call gets nothing added.
 * - A worker whose last progress report is far behind its activity gets one reminder line on its
 *   next LAZERS tool result.
 */
export function registerToolResults(
  ctx: Pick<Plugin.Context, "tool" | "session" | "location">,
  projectID: string,
  staleness = new ProgressStaleness(),
) {
  const scope = toolObservationScope(ctx, projectID, ctx.location.directory)
  return ctx.tool.hook("execute.after", (event) =>
    Effect.gen(function* () {
      const lazers = event.tool.startsWith("lz-")
      if (event.status === "error" && lazers) {
        const tools = yield* ctx.tool.list()
        const registered = tools.find((tool) => tool.id === event.tool)
        const explained =
          registered === undefined
            ? undefined
            : explainInvalidInput(event.tool, registered.input, event.input)
        if (explained !== undefined) {
          const note = REPAIR_NOTE.exec(event.error.message)?.[0] ?? ""
          event.error = new Tool.Error({
            message: `${explained}${note}`,
            ...(event.error.error === undefined ? {} : { error: event.error.error }),
            ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
          })
        }
      }
      // The Code Mode wrapper is not a call of the worker's own.
      if (event.tool === "execute" || !isWorkerAgent(event.agent)) return
      if (!(yield* Effect.promise(() => scope.owns(event.sessionID)))) return
      staleness.record(event.sessionID, event.tool, event.status === "completed")
      if (!lazers) return
      const reminder = staleness.due(event.sessionID)
      if (reminder === undefined) return
      if (event.status === "completed") appendNote(event.result, reminder)
      else
        event.error = new Tool.Error({
          message: `${event.error.message}\n\n${reminder}`,
          ...(event.error.error === undefined ? {} : { error: event.error.error }),
          ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
        })
    }),
  )
}
