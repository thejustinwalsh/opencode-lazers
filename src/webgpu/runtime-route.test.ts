import { expect, test } from "bun:test"
import { modelKindForInference, sessionAudioRoute } from "./inference-route.ts"

test("chat, dictation and audible speech route independently of d1", () => {
  expect(modelKindForInference("text", "runntime")).toBe("chat")
  expect(modelKindForInference("transcribe", "runntime")).toBe("audio")
  expect(modelKindForInference("speak", "runntime")).toBe("audio")
  expect(modelKindForInference("systemone", "runntime")).toBe("decision")
})

test("Liquid remains the default adapter for chat and speech", () => {
  expect(sessionAudioRoute(undefined)).toBe("liquid")
  expect(sessionAudioRoute("liquid")).toBe("liquid")
  expect(sessionAudioRoute("runntime")).toBe("runntime")
  expect(modelKindForInference("text", "liquid")).toBe("chat")
  expect(modelKindForInference("transcribe", "liquid")).toBe("chat")
  expect(modelKindForInference("speak", "liquid")).toBe("chat")
  expect(modelKindForInference("systemone", "liquid")).toBe("decision")
})
