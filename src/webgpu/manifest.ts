export const MODEL_REPOSITORY = "LiquidAI/LFM3-Omni-2B-GGUF"
export const MODEL_REVISION = "3d29af2ad166f8299c2d820937e47dc0add20ffc"
export const RUNNTIME_REVISION = "70ab1be9c16571b777b0321073e230e1873b1a4b"
export const LFM3_TOKENIZER_REVISION = "21d75123f86c1f7ffb4bef1ea202710c4e7ebe67"
export const LFM3_TOKENIZER_URL = `https://huggingface.co/LiquidAI/LFM3-Omni-2B/resolve/${LFM3_TOKENIZER_REVISION}/tokenizer.json`

export const MODEL_FILES = [
  {
    id: "model",
    name: "LFM3-Omni-2B-Q4_K_M.gguf",
    bytes: 1_099_630_080,
    sha256: "9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2",
  },
  {
    id: "projector",
    name: "mmproj-LFM3-Omni-2B-Q8_0.gguf",
    bytes: 506_842_528,
    sha256: "8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1",
  },
] as const

export type ModelFile = {
  readonly id: string
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}
export const MODEL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0)
export const MAX_READ_BYTES = 2 * 1024 * 1024
export const modelURL = (name: string) =>
  `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${name}`

export const DECISION_REPOSITORY = "LiquidAI/d1-omni-600M"
export const DECISION_REVISION = "02b55d7076f15129e59ab3f94783f32c4b088674"
const DECISION_WEIGHT_RELEASE =
  "https://github.com/thejustinwalsh/runntime/releases/tag/lazers-d1-q8-02b55d7"
export const DECISION_FILES = [
  {
    id: "weights",
    name: "d1-omni-600m-text-q8.safetensors",
    bytes: 620_464_044,
    sha256: "a5f94915d38627f0755df90372f1cda3d30e4d489066aaff44d2eeb98d2793e5",
  },
  {
    id: "tokenizer",
    name: "tokenizer.json",
    bytes: 4_733_371,
    sha256: "1efc3a6609abf6b63b1f47188d139f3b59973a6a434dffe970a7261a51ed2711",
  },
] as const
export const DECISION_BYTES = DECISION_FILES.reduce((sum, file) => sum + file.bytes, 0)
export const decisionURL = (name: string) => {
  if (name === DECISION_FILES[0].name)
    return `${DECISION_WEIGHT_RELEASE.replace("/tag/", "/download/")}/${name}`
  if (name === "tokenizer.json")
    return `https://huggingface.co/${DECISION_REPOSITORY}/resolve/${DECISION_REVISION}/${name}`
  throw Error("Unknown D1 model file")
}
