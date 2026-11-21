import { expect, test } from "bun:test"
import { modelDisplayLabeler } from "./catalog-inputs.ts"
import { modelDisplayLabel } from "./comparison-presentation.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"

test("the labeler gives modelDisplayLabel's label for every route, shared names included", () => {
  const candidate = (
    providerID: string,
    modelID: string,
    name: string | null,
    variant: string | null = null,
  ) =>
    ({ identity: { providerID, modelID, variant }, native: { name } }) as unknown as ModelCandidate
  const candidates = [
    candidate("openai", "gpt-5", "GPT-5"),
    candidate("openai", "gpt-5", "GPT-5", "high"),
    candidate("openrouter", "openai/gpt-5", "GPT-5"),
    candidate("anthropic", "claude", "Claude"),
    candidate("anthropic", "claude", "Claude 2", "x"),
    candidate("xai", "grok", null),
  ]
  const catalog = [
    { providerID: "xai", id: "grok", name: "Grok" },
    { providerID: "other", id: "m", name: "M" },
  ]
  const routes = [
    ...candidates.map((item) => ({ ...item.identity, variant: null })),
    { providerID: "other", modelID: "m", variant: "v" },
    { providerID: "missing", modelID: "nothing", variant: null },
  ]
  const label = modelDisplayLabeler(routes, candidates, catalog)
  const asked = [...routes, { providerID: "openai", modelID: "gpt-5", variant: "high" }]
  expect(asked.map((route) => label(route))).toEqual(
    asked.map((route) => modelDisplayLabel(route, routes, candidates, catalog)),
  )
  expect(label({ providerID: "openai", modelID: "gpt-5", variant: null })).toBe(
    "GPT-5 · openai / gpt-5",
  )
})
