import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { Ui as HostUi } from "@opencode/plugin/gui"
import { PanelStatus, createPanelStatus } from "../panel-status.tsx"

const ui = {
  Icon: () => null,
  Button: (props: { onClick?: () => void; children?: unknown }) => (
    <button type="button" onClick={props.onClick}>
      {props.children as never}
    </button>
  ),
} as unknown as HostUi

/** A failing panel whose status flips through loading, as a refresh does. */
export function mountStatus(container: HTMLElement) {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("Trajectory history exceeds the size")
  const dispose = render(() => {
    const status = createPanelStatus(() => ({
      subject: "this trajectory",
      hasContent: false,
      loading: loading(),
      error: loading() ? "" : error(),
    }))
    return <PanelStatus ui={ui} status={status} onRetry={() => {}} />
  }, container)
  return { dispose, setLoading, setError }
}
