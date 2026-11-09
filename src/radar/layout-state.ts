import { createRenderEffect, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import { panelErrorMessage } from "../panel-error.ts"
import type { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"

export type RadarLayoutClient = {
  layout(input: RadarLayoutInput, options?: { signal?: AbortSignal }): Promise<RadarLayoutResult>
}

export type RadarLayoutState = {
  key: string
  result?: RadarLayoutResult
  error?: string
  loading: boolean
}

/** Geometry-keyed request coordinator with a latest-key publication guard. */
export class RadarLayoutCoordinator {
  private readonly cache = new Map<string, RadarLayoutResult>()
  private readonly pending = new Map<
    string,
    { signal: AbortSignal; promise: Promise<RadarLayoutResult | undefined> }
  >()
  private currentKey = ""
  private generation = 0

  layout(
    input: RadarLayoutInput,
    client: RadarLayoutClient,
    signal: AbortSignal,
  ): Promise<RadarLayoutResult | undefined> {
    this.currentKey = input.key
    const cached = this.cache.get(input.key)
    if (cached) return Promise.resolve(cached)
    const existing = this.pending.get(input.key)
    if (existing && !existing.signal.aborted) return existing.promise
    if (existing) this.pending.delete(input.key)

    const generation = ++this.generation
    const request = client
      .layout(input, { signal })
      .then((result) => {
        if (
          signal.aborted ||
          generation !== this.generation ||
          this.currentKey !== input.key ||
          result.key !== input.key
        )
          return undefined
        this.cache.set(input.key, result)
        if (this.cache.size > 5) this.cache.delete(this.cache.keys().next().value!)
        return result
      })
      .finally(() => {
        if (this.pending.get(input.key)?.promise === request) this.pending.delete(input.key)
      })
    this.pending.set(input.key, { signal, promise: request })
    return request
  }
}

/** Cache measured graph geometry; publish only the latest, non-aborted ELK result. */
export function createStableRadarLayout(
  input: Accessor<RadarLayoutInput | undefined>,
  client: RadarLayoutClient,
) {
  const [state, setState] = createSignal<RadarLayoutState>({ key: "", loading: true })
  const coordinator = new RadarLayoutCoordinator()

  createRenderEffect(() => {
    const currentInput = input()
    if (!currentInput) return
    const controller = new AbortController()
    let current = true
    setState({ key: currentInput.key, loading: true })
    void coordinator
      .layout(currentInput, client, controller.signal)
      .then((result) => {
        if (!current || controller.signal.aborted) return
        if (!result) {
          setState({
            key: currentInput.key,
            error: "ELK returned an obsolete layout result.",
            loading: false,
          })
          return
        }
        setState({ key: currentInput.key, result, loading: false })
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return
        setState({ key: currentInput.key, error: panelErrorMessage(error), loading: false })
      })
    onCleanup(() => {
      current = false
      controller.abort()
    })
  })

  const current = () => {
    const currentInput = input()
    const value = state()
    return currentInput && value.key === currentInput.key ? value : undefined
  }
  return {
    state,
    current,
    result: () => current()?.result,
    error: () => current()?.error,
    loading: () => current()?.loading ?? true,
  }
}
