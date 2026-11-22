import { createEffect, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import {
  MODEL_PRICE_SOURCES,
  ModelPriceSourcePolicySchema,
  type ModelPriceSource,
  type ModelPriceSourcePolicy,
  type ModelPriceSourceWriteOutput,
} from "./price-source-settings.ts"

type PricePolicyRead = {
  policy?: ModelPriceSourcePolicy
  error?: string
}

/** Reactive draft and CAS lifecycle for the stream-backed price-source order editor. */
export function createPriceSourceOrderState(input: {
  read(): PricePolicyRead
  projectKey: Accessor<string | undefined>
  refresh(): void
  configure(
    expectedRevision: number,
    sources: ModelPriceSource[],
  ): Promise<ModelPriceSourceWriteOutput>
}) {
  const [draft, setDraft] = createSignal<ModelPriceSource[]>([...MODEL_PRICE_SOURCES])
  const [feedback, setFeedback] = createSignal<{
    status: "saving" | "verifying" | "saved" | "conflict" | "failed"
    message: string
    revision?: number
    sources?: ModelPriceSource[]
  }>()

  let lastProjectKey: string | undefined
  let lastPolicyKey = ""
  createEffect(() => {
    const projectKey = input.projectKey()
    const { policy } = input.read()
    if (projectKey !== lastProjectKey) {
      lastProjectKey = projectKey
      lastPolicyKey = ""
      setFeedback(undefined)
    }
    if (!policy) return

    const policyKey = JSON.stringify([projectKey, policy.revision, policy.sources])
    if (policyKey !== lastPolicyKey) {
      lastPolicyKey = policyKey
      setDraft([...policy.sources])
      if (feedback()?.status === "saved") setFeedback(undefined)
    }

    const currentFeedback = feedback()
    if (
      currentFeedback?.status !== "verifying" ||
      currentFeedback.revision === undefined ||
      policy.revision < currentFeedback.revision
    )
      return
    const confirmed =
      policy.revision === currentFeedback.revision &&
      JSON.stringify(policy.sources) === JSON.stringify(currentFeedback.sources)
    setFeedback(
      confirmed
        ? { status: "saved", message: "Saved and confirmed by the current policy stream." }
        : {
            status: "conflict",
            message:
              "The saved order changed before stream confirmation. Review the current order.",
          },
    )
  })

  const policy = () => input.read().policy
  const order = () => {
    const current = policy()
    return current
      ? { sources: [...current.sources], revision: current.revision, configured: true }
      : { sources: [...MODEL_PRICE_SOURCES], revision: undefined, configured: false }
  }
  const dirty = () =>
    order().configured && JSON.stringify(draft()) !== JSON.stringify(order().sources)
  const busy = () => feedback()?.status === "saving" || feedback()?.status === "verifying"
  const canSave = () => {
    const current = policy()
    return Boolean(
      current &&
      dirty() &&
      !input.read().error &&
      !busy() &&
      feedback()?.status !== "conflict" &&
      ModelPriceSourcePolicySchema.safeParse({
        schemaVersion: 1,
        revision: current.revision,
        sources: draft(),
        fallback: "whole-model",
      }).success,
    )
  }
  const move = (source: ModelPriceSource, delta: -1 | 1) => {
    if (busy()) return
    const sources = [...draft()]
    const index = sources.indexOf(source)
    const next = index + delta
    if (index < 0 || next < 0 || next >= sources.length) return
    ;[sources[index], sources[next]] = [sources[next]!, sources[index]!]
    setDraft(sources)
    setFeedback(undefined)
  }
  const revert = () => {
    setDraft(order().sources)
    setFeedback(undefined)
  }
  const save = async () => {
    const current = policy()
    if (!current || !canSave()) return
    const sources = [...draft()]
    setFeedback({ status: "saving", message: "Saving price-source order…" })
    try {
      const result = await input.configure(current.revision, sources)
      if (result.status === "conflict") {
        setFeedback({
          status: "conflict",
          message: `Updated elsewhere (revision ${result.currentRevision}). The current order will follow the policy stream.`,
        })
        input.refresh()
        return
      }
      setFeedback({
        status: "verifying",
        message: "Write accepted; waiting for the policy stream to confirm the saved order…",
        revision: result.policy.revision,
        sources: result.policy.sources,
      })
    } catch (error) {
      setFeedback({
        status: "failed",
        message: `Could not confirm the price-source order: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    priceSourceOrder: order,
    priceSourceDraft: draft,
    priceSourceDirty: dirty,
    priceSourceCanSave: canSave,
    priceSourceBusy: busy,
    priceSourceError: () => input.read().error,
    priceSourceFeedback: feedback,
    movePriceSource: move,
    retryPriceSourcePolicy: input.refresh,
    revertPriceSourceOrder: revert,
    savePriceSourceOrder: save,
  }
}
