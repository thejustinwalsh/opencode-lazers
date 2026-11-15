import { expect, test } from "bun:test"
import { modelKindForInference } from "./inference-route.ts"

test("chat, dictation and audible speech route independently of d1", () => {
  expect(modelKindForInference("text", "runntime")).toBe("audio")
  expect(modelKindForInference("transcribe", "runntime")).toBe("audio")
  expect(modelKindForInference("speak", "runntime")).toBe("audio")
  expect(modelKindForInference("systemone", "runntime")).toBe("decision")
})
