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

type SaveScope = {
  projectKey: string
  generation: number
  requestID: number
}

type PriceSourceFeedback = {
  status: "saving" | "verifying" | "saved" | "conflict" | "failed"
  message: string
  revision?: number
  sources?: ModelPriceSource[]
  scope?: SaveScope
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
  const [feedback, setFeedback] = createSignal<PriceSourceFeedback>()

  let lastProjectKey: string | undefined
  let lastPolicyKey = ""
  let projectGeneration = 0
  let requestSequence = 0
  let activeRequestID: number | undefined
  const currentProject = () => {
    const projectKey = input.projectKey()
    if (projectKey !== lastProjectKey) {
      lastProjectKey = projectKey
      projectGeneration++
      activeRequestID = undefined
      lastPolicyKey = ""
      setFeedback(undefined)
    }
    return { projectKey, generation: projectGeneration }
  }
  const isCurrentRequest = (scope: SaveScope) => {
    const project = currentProject()
    return (
      project.projectKey === scope.projectKey &&
      project.generation === scope.generation &&
      activeRequestID === scope.requestID
    )
  }

  createEffect(() => {
    const { projectKey, generation } = currentProject()
    const { policy } = input.read()
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
      !currentFeedback.scope ||
      currentFeedback.scope.projectKey !== projectKey ||
      currentFeedback.scope.generation !== generation ||
      currentFeedback.scope.requestID !== activeRequestID ||
      currentFeedback.revision === undefined ||
      policy.revision < currentFeedback.revision
    )
      return
    const confirmed =
      policy.revision === currentFeedback.revision &&
      JSON.stringify(policy.sources) === JSON.stringify(currentFeedback.sources)
    activeRequestID = undefined
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

  const policy = () => {
    currentProject()
    return input.read().policy
  }
  const order = () => {
    const current = policy()
    return current
      ? { sources: [...current.sources], revision: current.revision, configured: true }
      : { sources: [...MODEL_PRICE_SOURCES], revision: undefined, configured: false }
  }
  const dirty = () =>
    order().configured && JSON.stringify(draft()) !== JSON.stringify(order().sources)
  const busy = () => {
    currentProject()
    return feedback()?.status === "saving" || feedback()?.status === "verifying"
  }
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
    const project = currentProject()
    const current = policy()
    if (!project.projectKey || !current || !canSave()) return
    const sources = [...draft()]
    const scope = {
      projectKey: project.projectKey,
      generation: project.generation,
      requestID: ++requestSequence,
    }
    activeRequestID = scope.requestID
    setFeedback({ status: "saving", message: "Saving price-source order…", scope })
    try {
      const result = await input.configure(current.revision, sources)
      if (!isCurrentRequest(scope)) return
      if (result.status === "conflict") {
        activeRequestID = undefined
        setFeedback({
          status: "conflict",
          message: `Updated elsewhere (revision ${result.currentRevision}). The current order will follow the policy stream.`,
          scope,
        })
        input.refresh()
        return
      }
      setFeedback({
        status: "verifying",
        message: "Write accepted; waiting for the policy stream to confirm the saved order…",
        revision: result.policy.revision,
        sources: result.policy.sources,
        scope,
      })
    } catch (error) {
      if (!isCurrentRequest(scope)) return
      activeRequestID = undefined
      setFeedback({
        status: "failed",
        message: `Could not confirm the price-source order: ${error instanceof Error ? error.message : String(error)}`,
        scope,
      })
    }
  }

  return {
    priceSourceOrder: order,
    priceSourceDraft: draft,
    priceSourceDirty: dirty,
    priceSourceCanSave: canSave,
    priceSourceBusy: busy,
    priceSourceError: () => {
      currentProject()
      return input.read().error
    },
    priceSourceFeedback: () => {
      currentProject()
      return feedback()
    },
    movePriceSource: move,
    retryPriceSourcePolicy: input.refresh,
    revertPriceSourceOrder: revert,
    savePriceSourceOrder: save,
  }
}
