import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPriceSourceOrderState } from "./price-source-order-state.ts"
import type {
  ModelPriceSourcePolicy,
  ModelPriceSourceWriteOutput,
} from "./price-source-settings.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const policy = (revision: number, sources: ModelPriceSourcePolicy["sources"]) => ({
  schemaVersion: 1 as const,
  revision,
  sources,
  fallback: "whole-model" as const,
})

const switchCases = [
  {
    name: "a lower-revision policy cannot leave the new project's editor busy",
    nextPolicy: policy(0, ["openrouter", "opencode"]),
  },
  {
    name: "a coincident revision and order cannot confirm another project's write",
    nextPolicy: policy(4, ["opencode", "openrouter"]),
  },
] as const

for (const scenario of switchCases) {
  test(`price-source order: ${scenario.name}`, async () => {
    const result = deferred<ModelPriceSourceWriteOutput>()
    const root = createRoot((dispose) => {
      const [projectKey, setProjectKey] = createSignal<string | undefined>("project-a")
      const [currentPolicy, setCurrentPolicy] = createSignal(policy(2, ["openrouter", "opencode"]))
      const state = createPriceSourceOrderState({
        read: () => ({ policy: currentPolicy() }),
        projectKey,
        refresh: () => {},
        configure: () => result.promise,
      })
      return { dispose, projectKey: setProjectKey, policy: setCurrentPolicy, state }
    })

    try {
      root.state.revertPriceSourceOrder()
      root.state.movePriceSource("openrouter", 1)
      expect(root.state.priceSourceCanSave()).toBe(true)
      const save = root.state.savePriceSourceOrder()
      expect(root.state.priceSourceFeedback()?.status).toBe("saving")

      root.projectKey("project-b")
      root.policy(scenario.nextPolicy)
      root.state.priceSourceFeedback()
      root.state.revertPriceSourceOrder()
      expect(root.state.priceSourceFeedback()).toBeUndefined()

      result.resolve({
        status: "updated",
        policy: policy(4, ["opencode", "openrouter"]),
      })
      await save

      expect(root.state.priceSourceFeedback()).toBeUndefined()
      root.state.movePriceSource(root.state.priceSourceOrder().sources[0]!, 1)
      expect(root.state.priceSourceCanSave()).toBe(true)
      expect(root.state.priceSourceBusy()).toBe(false)
    } finally {
      root.dispose()
    }
  })
}
