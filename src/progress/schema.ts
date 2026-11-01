import { z } from "zod"

/** Progress is one short annotation; identity and authority are never model inputs. */
export const ProgressInput = z.strictObject({
  message: z.string().trim().min(1).max(1200),
})

export type ProgressInput = z.infer<typeof ProgressInput>
