/**
 * Bounded, content-free diagnostics for local inference.
 *
 * This deliberately records execution facts rather than prompts, audio, or
 * generated text. Runtime adapters can send the events to their diagnostics
 * surface without making the inference path depend on a logging backend.
 */

export type TraceStage =
  | "queued"
  | "tokenize"
  | "inputs-ready"
  | "run"
  | "readback"
  | "session-create"
  | "session-ready"
  | "dispose"
  | "renderer-lag"
  | "polled"
  | "loading"
  | "prefill"
  | "generate"
  | "complete"
  | "cancelled"
  | "context-overflow"
  | "device-lost"
  | "error"

export type TraceProvider = "webgpu" | "wasm" | "unknown"

export type TraceMode = "text" | "transcribe" | "speak" | "systemone"

export type TraceFeature = "questions" | "decisions" | "review" | "dictation" | "readAloud"

export type InferenceTraceEvent = {
  requestID: string
  jobID?: string
  mode?: TraceMode
  feature?: TraceFeature
  stage: TraceStage
  /** Monotonic elapsed time from the request start, not a wall-clock value. */
  elapsedMs: number
  /** Monotonic time since the preceding event. */
  deltaMs: number
  inputChars?: number
  questionCount?: number
  rendererLagMs?: number
  jsHeapBytes?: number
  heapLimitBytes?: number
  queueDepth?: number
  active?: boolean
  configuredEP: TraceProvider
  observedEP: TraceProvider
  contextCapacityTokens?: number
  configuredMaxTokens?: number
  actualInputTokens?: number
  outputGeneratedTokens?: number
  inputShape?: readonly number[]
  outputShape?: readonly number[]
  error?: {
    kind: "cancelled" | "context-overflow" | "device-lost" | "deadline" | "unknown"
    name?: string
    requiredTokens?: number
    capacityTokens?: number
  }
}

export type InferenceTraceSink = (event: InferenceTraceEvent) => void

export type InferenceTraceStart = {
  requestID: string
  jobID?: string
  mode?: TraceMode
  feature?: TraceFeature
  configuredEP?: TraceProvider
  observedEP?: TraceProvider
  contextCapacityTokens?: number
  configuredMaxTokens?: number
}

export type InferenceTraceMark = {
  inputChars?: number
  questionCount?: number
  rendererLagMs?: number
  jsHeapBytes?: number
  heapLimitBytes?: number
  queueDepth?: number
  active?: boolean
  actualInputTokens?: number
  outputGeneratedTokens?: number
  inputShape?: readonly number[]
  outputShape?: readonly number[]
  configuredEP?: TraceProvider
  observedEP?: TraceProvider
  contextCapacityTokens?: number
}

const MAX_ID_LENGTH = 100
const MAX_EVENTS = 128
const MAX_DIMENSIONS = 8
const MAX_DIMENSION = 1_000_000_000
const MAX_QUEUE_DEPTH = 10_000
const MAX_TOKEN_COUNT = 10_000_000
const MAX_TIME = 86_400_000

const boundedInteger = (value: number | undefined, maximum: number) => {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(maximum, Math.max(0, Math.trunc(value)))
}

const boundedID = (value: string, fallback: string) =>
  value.length > 0 ? value.slice(0, MAX_ID_LENGTH) : fallback

const dimensions = (value: readonly number[] | undefined) => {
  if (!value) return undefined
  return value
    .slice(0, MAX_DIMENSIONS)
    .map((dimension) => boundedInteger(dimension, MAX_DIMENSION) ?? 0)
}

const provider = (value: TraceProvider | undefined): TraceProvider =>
  value === "webgpu" || value === "wasm" ? value : "unknown"

const errorName = (error: unknown) => {
  if (!error || typeof error !== "object") return undefined
  const name = "name" in error && typeof error.name === "string" ? error.name : undefined
  return name?.slice(0, 80)
}

const errorNumber = (error: unknown, key: "required" | "capacity") => {
  if (!error || typeof error !== "object" || !(key in error)) return undefined
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "number" ? boundedInteger(value, MAX_TOKEN_COUNT) : undefined
}

/** Classify errors without retaining an error message, which could contain user content. */
export const classifyInferenceError = (
  error: unknown,
): NonNullable<InferenceTraceEvent["error"]> => {
  const name = errorName(error)
  const normalized = name?.toLowerCase() ?? ""
  const kind = normalized.includes("contextoverflow")
    ? "context-overflow"
    : normalized.includes("abort") || normalized.includes("cancel")
      ? "cancelled"
      : normalized.includes("device") || normalized.includes("gpu")
        ? "device-lost"
        : normalized.includes("deadline") || normalized.includes("timeout")
          ? "deadline"
          : "unknown"
  const requiredTokens = errorNumber(error, "required")
  const capacityTokens = errorNumber(error, "capacity")
  return {
    kind,
    ...(name ? { name } : {}),
    ...(requiredTokens === undefined ? {} : { requiredTokens }),
    ...(capacityTokens === undefined ? {} : { capacityTokens }),
  }
}

const cleanMark = (mark: InferenceTraceMark | undefined) => ({
  ...(mark?.inputChars === undefined
    ? {}
    : { inputChars: boundedInteger(mark.inputChars, MAX_TOKEN_COUNT) }),
  ...(mark?.questionCount === undefined
    ? {}
    : { questionCount: boundedInteger(mark.questionCount, MAX_QUEUE_DEPTH) }),
  ...(mark?.rendererLagMs === undefined
    ? {}
    : { rendererLagMs: boundedInteger(mark.rendererLagMs, MAX_TIME) }),
  ...(mark?.jsHeapBytes === undefined
    ? {}
    : { jsHeapBytes: boundedInteger(mark.jsHeapBytes, Number.MAX_SAFE_INTEGER) }),
  ...(mark?.heapLimitBytes === undefined
    ? {}
    : { heapLimitBytes: boundedInteger(mark.heapLimitBytes, Number.MAX_SAFE_INTEGER) }),
  ...(mark?.contextCapacityTokens === undefined
    ? {}
    : { contextCapacityTokens: boundedInteger(mark.contextCapacityTokens, MAX_TOKEN_COUNT) }),
  ...(mark?.queueDepth === undefined
    ? {}
    : { queueDepth: boundedInteger(mark.queueDepth, MAX_QUEUE_DEPTH) }),
  ...(mark?.active === undefined ? {} : { active: mark.active }),
  ...(mark?.actualInputTokens === undefined
    ? {}
    : { actualInputTokens: boundedInteger(mark.actualInputTokens, MAX_TOKEN_COUNT) }),
  ...(mark?.outputGeneratedTokens === undefined
    ? {}
    : { outputGeneratedTokens: boundedInteger(mark.outputGeneratedTokens, MAX_TOKEN_COUNT) }),
  ...(mark?.inputShape === undefined ? {} : { inputShape: dimensions(mark.inputShape) }),
  ...(mark?.outputShape === undefined ? {} : { outputShape: dimensions(mark.outputShape) }),
  ...(mark?.configuredEP === undefined ? {} : { configuredEP: provider(mark.configuredEP) }),
  ...(mark?.observedEP === undefined ? {} : { observedEP: provider(mark.observedEP) }),
})

export class InferenceTraceBuffer {
  readonly #events: InferenceTraceEvent[] = []
  readonly #limit: number

  constructor(limit = MAX_EVENTS) {
    this.#limit = Math.max(1, Math.min(MAX_EVENTS, Math.trunc(limit)))
  }

  record(event: InferenceTraceEvent) {
    this.#events.push(structuredClone(event))
    if (this.#events.length > this.#limit) this.#events.shift()
  }

  snapshot(): readonly InferenceTraceEvent[] {
    return structuredClone(this.#events)
  }

  clear() {
    this.#events.length = 0
  }
}

export class InferenceTraceSpan {
  readonly #start: number
  #last: number
  #finished = false

  constructor(
    readonly request: InferenceTraceStart,
    readonly sink: InferenceTraceSink,
    readonly now: () => number = () => performance.now(),
  ) {
    this.#start = now()
    this.#last = this.#start
    this.mark("queued")
  }

  mark(stage: TraceStage, mark?: InferenceTraceMark) {
    if (this.#finished) return
    this.#emit(stage, mark)
  }

  #emit(stage: TraceStage, mark?: InferenceTraceMark, error?: InferenceTraceEvent["error"]) {
    const current = this.now()
    const event: InferenceTraceEvent = {
      requestID: boundedID(this.request.requestID, "unknown-request"),
      ...(this.request.jobID ? { jobID: boundedID(this.request.jobID, "unknown-job") } : {}),
      ...(this.request.mode ? { mode: this.request.mode } : {}),
      ...(this.request.feature ? { feature: this.request.feature } : {}),
      stage,
      elapsedMs: boundedInteger(current - this.#start, MAX_TIME) ?? 0,
      deltaMs: boundedInteger(current - this.#last, MAX_TIME) ?? 0,
      configuredEP: provider(mark?.configuredEP ?? this.request.configuredEP),
      observedEP: provider(mark?.observedEP ?? this.request.observedEP),
      ...(this.request.contextCapacityTokens === undefined
        ? {}
        : {
            contextCapacityTokens:
              boundedInteger(this.request.contextCapacityTokens, MAX_TOKEN_COUNT) ?? 0,
          }),
      ...(this.request.configuredMaxTokens === undefined
        ? {}
        : {
            configuredMaxTokens:
              boundedInteger(this.request.configuredMaxTokens, MAX_TOKEN_COUNT) ?? 0,
          }),
      ...cleanMark(mark),
      ...(error ? { error } : {}),
    }
    this.#last = current
    this.sink(event)
  }

  finish(mark?: InferenceTraceMark) {
    this.mark("complete", mark)
    this.#finished = true
  }

  fail(error: unknown, mark?: InferenceTraceMark) {
    if (this.#finished) return
    const info = classifyInferenceError(error)
    this.#emit(
      info.kind === "context-overflow"
        ? "context-overflow"
        : info.kind === "device-lost"
          ? "device-lost"
          : info.kind === "cancelled"
            ? "cancelled"
            : "error",
      mark,
      info,
    )
    this.#finished = true
  }
}

export const startInferenceTrace = (
  request: InferenceTraceStart,
  sink: InferenceTraceSink,
  now?: () => number,
) => new InferenceTraceSpan(request, sink, now)
