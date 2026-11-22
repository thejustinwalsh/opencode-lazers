import { z } from "zod"

/**
 * What the Tasks pane shows of the latest attempt: when it was last active, one tick per tool
 * call (failed ones flagged) and the files it edited, composed from the attempt's progress
 * display rows (`tasks.attemptCalls`, `detail-read.ts`).
 */
export const AttemptSummary = z.strictObject({
  /** Epoch ms of the attempt's newest recorded progress; absent when none was recorded. */
  lastActivityAt: z.number().finite().optional(),
  /** Tool-call times in order. */
  ticks: z.array(z.strictObject({ at: z.number().finite(), failed: z.literal(true).optional() })),
  /** Distinct files the attempt edited or patched; absent when none. */
  files: z.int().positive().optional(),
})
export type AttemptSummary = z.infer<typeof AttemptSummary>

/** The attempt's model as `provider/id` parts, from its recorded policy; absent when unrecorded. */
export const AttemptModel = z.strictObject({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
})
export type AttemptModel = z.infer<typeof AttemptModel>

export function attemptModel(policy: string): AttemptModel | undefined {
  try {
    const model = (JSON.parse(policy) as { model?: unknown } | null)?.model
    const parsed = AttemptModel.safeParse(model)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
