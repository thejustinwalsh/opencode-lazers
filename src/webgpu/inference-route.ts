export type ChatRoute = "liquid" | "runntime"
export type ModelKind = "chat" | "audio" | "decision"
export type InferenceMode = "text" | "transcribe" | "speak" | "systemone"

export const DEFAULT_OMNI_ROUTE: ChatRoute = "runntime"

/** Speech routing can be overridden per session. */
export const sessionAudioRoute = (route: ChatRoute | undefined): ChatRoute =>
  route ?? DEFAULT_OMNI_ROUTE

export const modelKindForInference = (mode: InferenceMode, route: ChatRoute): ModelKind =>
  mode === "systemone"
    ? "decision"
    : route === "runntime" && (mode === "transcribe" || mode === "speak")
      ? "audio"
      : "chat"
