export const MODEL_REPOSITORY = "LiquidAI/LFM3-Omni-2B-GGUF"
export const MODEL_REVISION = "3d29af2ad166f8299c2d820937e47dc0add20ffc"
export const ENGINE_REVISION = "9c2fb176f4c222da394e8037d3c0d0837f70b978"
export const ENGINE_SHA256 = "77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb"
export const ENGINE_URL = `https://huggingface.co/spaces/LiquidAI/LFM3-Omni-2B-WebGPU/resolve/${ENGINE_REVISION}/Lfm3OmniForConditionalGeneration.js`
export const RUNNTIME_REVISION = "4bec7104f2e70290982864963f6b194e6d5439fe"
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

export const DECISION_REPOSITORY = "LiquidAI/d1-Omni-2B-ONNX"
export const DECISION_REVISION = "2552a495cd0fc6d82f7911110f07bca7a05c11c6"
export const MODEL_SHORT_NAMES = {
  chat: "LFM3",
  decision: "d1",
} as const
export const DECISION_FILES = [
  {
    id: "decoder",
    name: "decoder_q4f16.onnx",
    bytes: 276_444,
    sha256: "59bed92a6ec5df6462aa02ad8ac5be342afecfa8525539852a9a5deb48d7f221",
  },
  {
    id: "weights",
    name: "decoder_q4f16.onnx_data",
    bytes: 1_567_474_688,
    sha256: "bf8a038340291e07e6864243016eae55e9c183523d446fca608b5d82acceed1f",
  },
  {
    id: "tokenizer",
    name: "tokenizer.json",
    bytes: 17_908_634,
    sha256: "41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44",
  },
  {
    id: "tokenizerConfig",
    name: "tokenizer_config.json",
    bytes: 625,
    sha256: "3cff70d801d7c2086ffa2979046051b2727f160acb2eaeb3a77512be41c6a29e",
  },
  {
    id: "calibration",
    name: "calibration.json",
    bytes: 4_819,
    sha256: "182270f679ee9b8ead5d2d3f37ea5f297839126baaced22e4cd57d48cfaf1772",
  },
] as const
export const DECISION_BYTES = DECISION_FILES.reduce((sum, file) => sum + file.bytes, 0)
export const decisionURL = (name: string) =>
  `https://huggingface.co/${DECISION_REPOSITORY}/resolve/${DECISION_REVISION}/${name.startsWith("decoder_") ? "onnx/" : ""}${name}`
