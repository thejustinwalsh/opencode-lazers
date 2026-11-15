export type ChatRoute = "liquid" | "runntime"
export type ModelKind = "chat" | "audio" | "decision"
export type InferenceMode = "text" | "transcribe" | "speak" | "systemone"

/** Speech routing is per-session and deliberately defaults to Liquid. */
export const sessionAudioRoute = (route: ChatRoute | undefined): ChatRoute => route ?? "liquid"

export const modelKindForInference = (mode: InferenceMode, route: ChatRoute): ModelKind =>
  mode === "systemone"
    ? "decision"
    : route === "runntime" && (mode === "transcribe" || mode === "speak")
      ? "audio"
      : "chat"
