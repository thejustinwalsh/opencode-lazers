import type { ObservationNode, ObservationPlan } from "./projection.ts"

const nonEmpty = (value: string | null | undefined) => value?.trim() || undefined

/** A plan's persisted title, or its stable sequence label when the title is absent. */
export function planPickerLabel(plan: Pick<ObservationPlan, "sequence" | "title">) {
  return nonEmpty(plan.title) ?? (plan.sequence === null ? "Plan" : `Plan ${plan.sequence}`)
}

/** The task's state and stored reference; never substitute an abbreviated task id. */
export function nodePickerLabel(node: Pick<ObservationNode, "reference" | "state">) {
  const reference = nonEmpty(node.reference)
  return reference ? `${node.state} · ${reference}` : node.state
}
