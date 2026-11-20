import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { Retention } from "./contract.ts"
import type { RetentionService } from "./service.ts"

/** One typed command with a dry run; there is no model tool because no agent needs one. */
export function registerRetention(ctx: Pick<Plugin.Context, "rpc">, service: RetentionService) {
  return timedRpc(ctx.rpc).register(Retention, {
    status: () => Effect.promise(() => service.status()),
    preview: (input) => Effect.promise(() => service.preview(input)),
    retire: (input) =>
      Effect.promise(() =>
        service.retire({
          days: input.days,
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
          ...(input.runID === undefined ? {} : { runID: input.runID }),
        }),
      ),
    setAuto: (input) => Effect.sync(() => service.setAuto(input.days)),
  })
}
