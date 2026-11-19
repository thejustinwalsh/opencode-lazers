import type { LabelTone } from "./tone.ts"

export type ProgressState = "passed" | "current" | "later"
export type ProgressStep = { label: string; state: ProgressState; tone?: LabelTone }

/**
 * Maps an ordered list of step names and the index of the current one to display steps. Earlier
 * steps are passed, later ones are later. The current step carries `tone`; green (success) is
 * allowed only on the final step, so a non-final success tone is shown as interactive. A current
 * index below zero means nothing has started; at or past the end clamps to the final step.
 */
export function progressSteps(
  labels: readonly string[],
  current: number,
  tone: LabelTone = "interactive",
): ProgressStep[] {
  const last = labels.length - 1
  const at = Math.min(current, last)
  return labels.map((label, index) => {
    if (index < at) return { label, state: "passed" }
    if (index > at) return { label, state: "later" }
    return {
      label,
      state: "current",
      tone: index === last || tone !== "success" ? tone : "interactive",
    }
  })
}
