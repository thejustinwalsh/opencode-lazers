import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import type { RunnerStore } from "./store.ts"
import { sourceGuardMatches, type SourceGuardRegistration } from "./source-quarantine.ts"

/** Read-only location activation; never a persisted installation certificate. */
export const SourceFence = Rpc.define({
  id: "lz.source-fence",
  events: {},
  methods: {
    status: {
      input: z.strictObject({}),
      output: z.strictObject({
        pid: z.int().positive(),
        projectID: z.string(),
        directory: z.string(),
        databasePath: z.string(),
        registrationID: z.uuid(),
      }),
    },
  },
})

export function registerSourceFence(
  ctx: Plugin.Context,
  store: RunnerStore,
  guard: SourceGuardRegistration,
) {
  return ctx.rpc.register(SourceFence, {
    status: () =>
      Effect.sync(() => {
        if (!sourceGuardMatches(store, ctx.location.directory, guard.registrationID))
          throw new Error(
            "Native source guard is not installed in this current location generation",
          )
        return {
          pid: process.pid,
          projectID: ctx.location.project.id,
          directory: ctx.location.directory,
          databasePath: store.repository.path,
          registrationID: guard.registrationID,
        }
      }),
  })
}
