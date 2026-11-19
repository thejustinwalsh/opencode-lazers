import { z } from "zod"

/**
 * The refusal a submit or start command returns when the project has no Fallow config. Zod only,
 * so the Tasks panel contract can import it without the storage layer.
 */
export const FALLOW_CONFIG_REQUIRED = "FALLOW_CONFIG_REQUIRED"

export const FallowConfigRequired = z.strictObject({
  status: z.literal("refused"),
  code: z.literal(FALLOW_CONFIG_REQUIRED),
  /** The canonical project root that has no config. */
  project: z.string().min(1),
  missing: z.string().min(1),
  /** Always true: the refusal happens before anything is stored or queued. */
  nothingQueued: z.literal(true),
  /** The tools to use next, in order. */
  next: z.array(z.string().min(1)),
  guidance: z.string().min(1),
})
export type FallowConfigRequired = z.infer<typeof FallowConfigRequired>

/** What the Tasks panel shows: what is missing, what to run, and that nothing was queued. */
export function refusalMessage(refusal: FallowConfigRequired): string {
  return `${refusal.missing} Ask the Architect to run ${refusal.next.join(", then ")}. Nothing was queued.`
}

/** Thrown by a command whose result type cannot carry the refusal; the RPC layer returns it typed. */
export class FallowConfigRequiredError extends Error {
  constructor(readonly refusal: FallowConfigRequired) {
    super(`${FALLOW_CONFIG_REQUIRED}: ${refusal.missing} ${refusal.guidance}`)
  }
}
