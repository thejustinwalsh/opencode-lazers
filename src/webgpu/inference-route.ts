export type ChatRoute = "liquid" | "runntime"
export type ModelKind = "audio" | "decision"
export type InferenceMode = "text" | "transcribe" | "speak" | "systemone"

export const modelKindForInference = (mode: InferenceMode, _route?: ChatRoute): ModelKind =>
  mode === "systemone" ? "decision" : "audio"
