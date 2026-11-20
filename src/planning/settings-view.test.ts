import { expect, test } from "bun:test"
import { chooseDecisionModel, planningSettingsView } from "./settings-view.ts"

test("default settings show Local (D1), the default slicer and the switch on", () => {
  expect(
    planningSettingsView({ decisionModel: { kind: "local" }, decisionSlicer: "windows" }),
  ).toEqual({
    model: { value: "local", label: "Local (D1)" },
    slicer: { value: "windows", label: "Sentence windows (default)" },
    autoDispatch: true,
  })
})

test("an external model is labelled as sending the ask off the machine", () => {
  const view = planningSettingsView({
    decisionModel: { kind: "external", providerID: "openrouter", modelID: "m" },
    decisionSlicer: "uncertainty",
    planningAutoDispatch: false,
  })
  expect(view.external).toEqual({
    providerID: "openrouter",
    modelID: "m",
    notice: "Sends the ask text to openrouter.",
  })
  expect(view).toMatchObject({ slicer: { label: "Uncertainty" }, autoDispatch: false })
})

test("choosing External without a model keeps the old value and says why", () => {
  expect(chooseDecisionModel("external", { providerID: "openrouter", modelID: " " })).toEqual({
    ok: false,
    message: "Name a provider and a model to use an external decision model.",
  })
  expect(chooseDecisionModel("external", { providerID: " p ", modelID: "m" })).toEqual({
    ok: true,
    value: { kind: "external", providerID: "p", modelID: "m" },
  })
  expect(chooseDecisionModel("architect", { providerID: "", modelID: "" })).toEqual({
    ok: true,
    value: { kind: "architect" },
  })
})
