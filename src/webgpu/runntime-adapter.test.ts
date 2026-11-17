import { expect, test } from "bun:test"
import { MAX_READ_BYTES, MODEL_FILES, MODEL_REVISION } from "./manifest.ts"
import { cachedModelRangeSource } from "./runntime-adapter.ts"
import { runntimeSpeechVoice } from "./speech.ts"

const encode = (bytes: Uint8Array) => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  return btoa(binary)
}

test("ruNNtime ranges use only the verified model cache and preserve half-open byte bounds", async () => {
  const bytes = Uint8Array.from({ length: MAX_READ_BYTES + 8 }, (_, index) => index % 251)
  const calls: { id: string; offset: number; length: number }[] = []
  const source = cachedModelRangeSource(
    "projector",
    async (id, offset, length) => {
      calls.push({ id, offset, length })
      return encode(bytes.subarray(offset, offset + length))
    },
    new AbortController().signal,
  )

  const begin = 0
  const end = MAX_READ_BYTES + 8
  const result = await source.read(begin, end)

  expect(Array.from(result)).toEqual(Array.from(bytes.subarray(begin, end)))
  expect(calls).toEqual([
    { id: "projector", offset: begin, length: MAX_READ_BYTES },
    { id: "projector", offset: MAX_READ_BYTES, length: 8 },
  ])
  expect(MODEL_REVISION).toBe("3d29af2ad166f8299c2d820937e47dc0add20ffc")
  expect(MODEL_FILES.map(({ name, sha256 }) => [name, sha256])).toEqual([
    [
      "LFM3-Omni-2B-Q4_K_M.gguf",
      "9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2",
    ],
    [
      "mmproj-LFM3-Omni-2B-Q8_0.gguf",
      "8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1",
    ],
  ])
})

test("ruNNtime range reads reject invalid and cancelled requests before cache access", async () => {
  let reads = 0
  const controller = new AbortController()
  const source = cachedModelRangeSource(
    "model",
    async () => {
      reads++
      return ""
    },
    controller.signal,
  )

  await expect(source.read(2, 1)).rejects.toThrow("Invalid ruNNtime model byte range")
  await expect(source.read(0, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
    "Invalid ruNNtime model byte range",
  )
  await expect(source.read(1, 1)).resolves.toEqual(new Uint8Array())
  controller.abort(new Error("route changed"))
  await expect(source.read(0, 0)).rejects.toThrow("route changed")
  expect(reads).toBe(0)
})

test("LAZERS voice keys map to ruNNtime's typed speech voice", () => {
  expect(runntimeSpeechVoice("american-female")).toEqual({
    language: "American English",
    gender: "female",
  })
  expect(runntimeSpeechVoice("british-female")).toEqual({
    language: "British English",
    gender: "female",
  })
  expect(runntimeSpeechVoice("british-male")).toEqual({
    language: "British English",
    gender: "male",
  })
})
