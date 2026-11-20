/** What the scripted runtime reports: the signals `InferenceIndicator` reads. */
export interface LocalData {
  /** Session title shown at the left of the header strip (host chrome, not LAZERS UI). */
  session: string
  /** The indicator is shown only while a local feature is on (see `usesGPU` in gui.tsx). */
  visible: boolean
  phase: "disabled" | "unloaded" | "loading" | "downloading" | "ready" | "busy" | "error"
  /** `d1` while the decision model is resident, `ruNNtime Omni` for the audio model. */
  model?: string
  detail?: string
}
export const reads = () => []
