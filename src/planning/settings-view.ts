import type { z } from "zod"
import type { DecisionModelSchema, DecisionSlicerSchema } from "../projects/setting-schemas.ts"

type DecisionModel = z.infer<typeof DecisionModelSchema>
type Slicer = z.infer<typeof DecisionSlicerSchema>

/** One small control each: a select. Anything wider goes in the row's description. */
export const MODEL_CHOICES: readonly { value: DecisionModel["kind"]; label: string }[] = [
  { value: "local", label: "Local (D1)" },
  { value: "external", label: "External model" },
  { value: "architect", label: "Architect decides" },
]
export const SLICER_CHOICES: readonly { value: Slicer; label: string }[] = [
  { value: "windows", label: "Sentence windows (default)" },
  { value: "uncertainty", label: "Uncertainty" },
  { value: "whole", label: "Whole text" },
  { value: "pre-slice", label: "Pre-sliced" },
]

export type PlanningSettingsView = {
  model: { value: DecisionModel["kind"]; label: string }
  /** Shown under the row when an external model is chosen: the ask leaves the machine. */
  external?: { providerID: string; modelID: string; notice: string }
  slicer: { value: Slicer; label: string }
  autoDispatch: boolean
}

export function planningSettingsView(input: {
  decisionModel: DecisionModel
  decisionSlicer: Slicer
  planningAutoDispatch?: boolean
}): PlanningSettingsView {
  const model = MODEL_CHOICES.find((choice) => choice.value === input.decisionModel.kind)!
  const slicer = SLICER_CHOICES.find((choice) => choice.value === input.decisionSlicer)!
  return {
    model: { value: model.value, label: model.label },
    ...(input.decisionModel.kind === "external"
      ? {
          external: {
            providerID: input.decisionModel.providerID,
            modelID: input.decisionModel.modelID,
            notice: `Sends the ask text to ${input.decisionModel.providerID}.`,
          },
        }
      : {}),
    slicer: { value: slicer.value, label: slicer.label },
    autoDispatch: input.planningAutoDispatch ?? true,
  }
}

/**
 * What a choice of decision model would store. An external model needs a provider and a model:
 * without them the old value stays and the message shows beside the field.
 */
export function chooseDecisionModel(
  kind: DecisionModel["kind"],
  external: { providerID: string; modelID: string },
): { ok: true; value: DecisionModel } | { ok: false; message: string } {
  if (kind !== "external") return { ok: true, value: { kind } }
  const providerID = external.providerID.trim()
  const modelID = external.modelID.trim()
  if (!providerID || !modelID)
    return { ok: false, message: "Name a provider and a model to use an external decision model." }
  return { ok: true, value: { kind: "external", providerID, modelID } }
}
