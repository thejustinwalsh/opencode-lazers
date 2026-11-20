import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { PlanLinkDetail } from "./links.ts"
import type { PlanningView } from "./view-model.ts"

/** Plain JSON by construction; the TypeScript types in `view-model.ts` describe it. */
const view = z.json() as unknown as z.ZodType<PlanningView | null>
const link = z.json() as unknown as z.ZodType<PlanLinkDetail>

export const PlanningRpc = Rpc.define({
  id: "lz.planning",
  events: {},
  methods: {
    /** A stored plan of this project, at `revision` or its latest; `null` when there is none. */
    get: {
      input: z.strictObject({
        planningID: z.uuid(),
        revision: z.int().positive().optional(),
      }),
      output: view,
    },
    /** Only what a link needs to decide the plan belongs to the caller's project. */
    resolve: { input: z.strictObject({ planningID: z.uuid() }), output: link },
    list: {
      input: z.strictObject({ sessionID: z.string().min(1).max(200).optional() }),
      output: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          state: z.string(),
          revision: z.number(),
          updatedAt: z.number(),
        }),
      ),
    },
  },
})
