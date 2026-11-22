import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { PlanLinkDetail } from "./links.ts"

const link = z.json() as unknown as z.ZodType<PlanLinkDetail>

export const PlanningRpc = Rpc.define({
  id: "lz.planning",
  events: {},
  methods: {
    /** Only what a link needs to decide the plan belongs to the caller's project. */
    resolve: { input: z.strictObject({ planningID: z.uuid() }), output: link },
  },
})
