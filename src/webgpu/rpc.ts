import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import { DecisionRequest, DecisionResult } from "./decisions.ts"
import { SystemOneRequest, SystemOneResult } from "./system-one.ts"
import { voiceKeys } from "./speech.ts"
import { FeatureSettings, FeaturePatch } from "./features.ts"

const portable = Schema.toStandardSchemaV1
const ownerToken = Schema.String.check(Schema.isBetweenLength(1, 100))
export const GENERATION_RESULT_CONTRACT_REVISION = "webgpu-generation-result-nullable-usage-v1"
const generationContract = portable(
  Schema.Struct({ revision: Schema.String.check(Schema.isBetweenLength(1, 100)) }),
)
const rendererAttachment = portable(
  Schema.Struct({
    owner: ownerToken,
    contractRevision: Schema.String.check(Schema.isBetweenLength(1, 100)),
  }),
)
export const Request = Schema.Struct({
  prompt: Schema.String.check(Schema.isBetweenLength(1, 8_000)),
  maxTokens: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 512 })),
  timeoutMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 120_000 }),
  ),
})
export type InferenceRequest = typeof Request.Type
export const SpeechRequest = Schema.Struct({
  ...Request.fields,
  voice: Schema.optionalKey(Schema.Literals(voiceKeys)),
})
export const TranscriptionRequest = Schema.Struct({
  audioBase64: Schema.String.check(Schema.isBetweenLength(4, 1_280_000)),
  requestID: Schema.String.check(Schema.isBetweenLength(1, 100)),
  timeoutMs: Request.fields.timeoutMs,
})
export const GenerationResult = Schema.Struct({
  ok: Schema.Boolean,
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  error: Schema.String.check(Schema.isMaxLength(2_000)),
  promptTokens: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  completionTokens: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  audioBase64: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000_000))),
})
export type InferenceResult = typeof GenerationResult.Type
const Job = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  maxTokens: Schema.Number,
  timeoutMs: Schema.Number,
  mode: Schema.Literals(["text", "transcribe", "speak", "systemone"]),
  audioBase64: Schema.String,
  requestID: Schema.String,
  voice: Schema.Literals(voiceKeys),
  feature: Schema.Literals(["questions", "decisions", "review", "dictation", "readAloud"]),
})
export type InferenceJob = typeof Job.Type
const nothing = portable(Schema.Struct({}))

/** Shared location/renderer inference surface; the renderer mailbox adds ownership primitives. */
const sharedInferenceMethods = {
  settings: { input: nothing, output: FeatureSettings },
  configure: { input: FeaturePatch, output: FeatureSettings },
  review: { input: SystemOneRequest, output: SystemOneResult },
  ask: { input: portable(Request), output: portable(GenerationResult) },
  speak: { input: portable(SpeechRequest), output: portable(GenerationResult) },
  decide: { input: portable(DecisionRequest), output: portable(DecisionResult) },
  systemOne: { input: SystemOneRequest, output: SystemOneResult },
  transcribe: { input: portable(TranscriptionRequest), output: portable(GenerationResult) },
}

export const LocalInference = Rpc.define({
  id: "lazers.webgpu",
  events: {},
  methods: { ...sharedInferenceMethods },
})

export const rendererOwnershipLostType = "renderer_ownership_lost"
export const isRendererOwnershipLost = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "type" in error &&
  error.type === rendererOwnershipLostType

/** Renderer mailbox is deliberately separate from location-scoped public entry points. */
export const RendererInference = Rpc.define({
  id: "lazers.webgpu-worker",
  events: {},
  methods: {
    ...sharedInferenceMethods,
    demand: { input: nothing, output: portable(Schema.Struct({ requested: Schema.Boolean })) },
    contract: { input: nothing, output: generationContract },
    attach: { input: rendererAttachment, output: nothing },
    detach: {
      input: portable(
        Schema.Struct({
          owner: ownerToken,
          error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
        }),
      ),
      output: nothing,
    },
    poll: {
      input: portable(Schema.Struct({ owner: ownerToken, available: Schema.Boolean })),
      errors: { [rendererOwnershipLostType]: nothing },
      output: portable(
        Schema.Struct({ job: Schema.NullOr(Job), cancelID: Schema.NullOr(Schema.String) }),
      ),
    },
    complete: {
      input: portable(
        Schema.Struct({ owner: ownerToken, id: ownerToken, result: GenerationResult }),
      ),
      output: nothing,
    },
  },
})
