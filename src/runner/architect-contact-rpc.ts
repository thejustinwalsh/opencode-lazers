import { timedRpc } from "../diagnostics/stall-probe.ts"
import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import type { RunnerStore } from "./store.ts"

const State = z.enum(["enabled", "paused"])
const Setting = z.strictObject({
  state: State,
  reason: z.string(),
  updatedAt: z.number().nullable(),
})

/**
 * Operator control for project-wide Architect contact.
 * Call: `client.rpc(ArchitectContact).set({ state: "paused", reason }, { location: { directory } })`
 * and `.get({}, { location: { directory } })`.
 */
const ArchitectContact = Rpc.define({
  id: "lz.architect-contact",
  events: {},
  methods: {
    get: { input: z.strictObject({}), output: Setting },
    set: {
      input: z.strictObject({ state: State, reason: z.string().max(500).optional() }),
      output: Setting,
    },
  },
})

export function registerArchitectContact(
  ctx: Plugin.Context,
  store: RunnerStore,
  wake: () => void,
) {
  return timedRpc(ctx.rpc).register(ArchitectContact, {
    get: () => Effect.sync(() => store.architectContact()),
    set: (input) =>
      Effect.sync(() => {
        const setting = store.setArchitectContact(input.state, input.reason ?? "")
        // Unpausing lets queued notices deliver on the next tick.
        if (input.state === "enabled") wake()
        return setting
      }),
  })
}
