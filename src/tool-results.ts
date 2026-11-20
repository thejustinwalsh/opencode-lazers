import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { explainInvalidInput } from "./tool-input.ts"

/** The alias note OpenCode's input-repair plugin appends to a failure; keep it when rewriting. */
const REPAIR_NOTE = /\n\nThere is no "[^"\n]*" tool, so this ran as[^\n]*$/

/**
 * What a LAZERS tool result can carry beyond the tool's own answer, added after the tool has run,
 * in one place.
 *
 * On a failed call whose arguments do not match the tool's input, the failure becomes the plain
 * list of what was wrong plus the tool's full usage. OpenCode has already repaired what it can
 * (text to numbers, stray keys dropped) before this runs, so this only explains what remains.
 * A correct call gets nothing added.
 */
export function registerToolResults(ctx: Pick<Plugin.Context, "tool">) {
  return ctx.tool.hook("execute.after", (event) =>
    Effect.gen(function* () {
      if (event.status !== "error" || !event.tool.startsWith("lz-")) return
      const tools = yield* ctx.tool.list()
      const registered = tools.find((tool) => tool.id === event.tool)
      if (registered === undefined) return
      const explained = explainInvalidInput(event.tool, registered.input, event.input)
      if (explained === undefined) return
      const note = REPAIR_NOTE.exec(event.error.message)?.[0] ?? ""
      event.error = new Tool.Error({
        message: `${explained}${note}`,
        ...(event.error.error === undefined ? {} : { error: event.error.error }),
        ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
      })
    }),
  )
}
