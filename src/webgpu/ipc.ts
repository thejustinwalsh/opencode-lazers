import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"
import type { InferenceTraceEvent } from "./inference-trace.ts"

const traceID = Schema.String.check(Schema.isBetweenLength(1, 100))
const traceCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 10_000_000 }),
)
const traceTime = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 86_400_000 }),
)
const traceBytes = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }),
)
const traceShape = Schema.Array(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
).check(Schema.isBetweenLength(0, 8))
const TraceError = Schema.Struct({
  kind: Schema.Literals(["cancelled", "context-overflow", "device-lost", "deadline", "unknown"]),
  name: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 80))),
  requiredTokens: Schema.optionalKey(traceCount),
  capacityTokens: Schema.optionalKey(traceCount),
})
export const InferenceTrace = Schema.Struct({
  requestID: traceID,
  jobID: Schema.optionalKey(traceID),
  mode: Schema.optionalKey(Schema.Literals(["text", "transcribe", "speak", "systemone"])),
  feature: Schema.optionalKey(
    Schema.Literals(["questions", "decisions", "review", "dictation", "readAloud"]),
  ),
  stage: Schema.Literals([
    "queued",
    "polled",
    "loading",
    "tokenize",
    "inputs-ready",
    "session-create",
    "session-ready",
    "prefill",
    "run",
    "generate",
    "readback",
    "dispose",
    "renderer-lag",
    "complete",
    "cancelled",
    "context-overflow",
    "device-lost",
    "error",
  ]),
  elapsedMs: traceTime,
  deltaMs: traceTime,
  queueDepth: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
  active: Schema.optionalKey(Schema.Boolean),
  configuredEP: Schema.Literals(["webgpu", "wasm", "unknown"]),
  observedEP: Schema.Literals(["webgpu", "wasm", "unknown"]),
  contextCapacityTokens: Schema.optionalKey(traceCount),
  configuredMaxTokens: Schema.optionalKey(traceCount),
  inputChars: Schema.optionalKey(traceCount),
  questionCount: Schema.optionalKey(traceCount),
  actualInputTokens: Schema.optionalKey(traceCount),
  outputGeneratedTokens: Schema.optionalKey(traceCount),
  rendererLagMs: Schema.optionalKey(traceTime),
  jsHeapBytes: Schema.optionalKey(traceBytes),
  heapLimitBytes: Schema.optionalKey(traceBytes),
  inputShape: Schema.optionalKey(traceShape),
  outputShape: Schema.optionalKey(traceShape),
  error: Schema.optionalKey(TraceError),
})
export type InferenceTrace = InferenceTraceEvent

export const CacheStatus = Schema.Struct({
  phase: Schema.String,
  cachedBytes: Schema.Number,
  totalBytes: Schema.Number,
  downloadedBytes: Schema.Number,
  directory: Schema.String,
  error: Schema.String,
  occupied: Schema.Boolean,
})
export const ModelFiles = Ipc.define({
  id: "lazers.webgpu-files",
  methods: {
    status: { output: CacheStatus },
    decisionStatus: { output: CacheStatus },
    acquire: { output: Schema.String },
    ensure: { input: Schema.Struct({ owner: Schema.String }) },
    decisionEnsure: { input: Schema.Struct({ owner: Schema.String }) },
    decisionRead: {
      input: Schema.Struct({
        owner: Schema.String,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    read: {
      input: Schema.Struct({
        owner: Schema.String,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    release: { input: Schema.Struct({ owner: Schema.String }) },
    cancel: { input: Schema.Struct({ owner: Schema.String }) },
    trace: { input: InferenceTrace },
    clear: {},
  },
})
