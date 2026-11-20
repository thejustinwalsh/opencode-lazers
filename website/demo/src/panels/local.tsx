import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { InferenceIndicator } from "../../../../src/webgpu/indicator.tsx"
import { inferenceIndicatorStyles } from "../../../../src/webgpu/indicator.tsx"
import { createUi } from "../ui.tsx"
import type { LocalData } from "./local-data.ts"

/**
 * The real `InferenceIndicator` (the session-header status icon) driven by a scripted runtime:
 * the component and its styles are the product's; only the runtime's signals are replayed.
 */
export function mount(container: HTMLElement, data: () => unknown) {
  const [state, setState] = createSignal(data() as LocalData)
  const style = document.createElement("style")
  style.textContent = inferenceIndicatorStyles
  document.head.append(style)
  const ui = createUi()
  const runtime = {
    modelName: () => state().model,
    phase: () => state().phase,
    detail: () => state().detail,
  }
  const dispose = render(
    () => (
      <div class="oc-header">
        <span class="oc-grow">{state().session}</span>
        {state().visible
          ? createComponent(InferenceIndicator, {
              runtime: runtime as never,
              Tooltip: ui.Tooltip as never,
              onSettings: () => {},
            })
          : null}
      </div>
    ),
    container,
  )
  return {
    changed: (next: unknown) => setState(next as LocalData),
    dispose: () => {
      dispose()
      style.remove()
    },
  }
}
