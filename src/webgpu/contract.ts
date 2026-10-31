import { Contract } from "@opencode/plugin/gui"
import type { InferenceRuntime } from "./runtime.ts"

export const LocalModel = Contract.define<InferenceRuntime, "lazers.local-model">(
  "lazers.local-model",
)
