import { startInferenceTrace } from "./inference-trace.ts"
import type {
  InferenceTraceEvent,
  InferenceTraceMark,
  InferenceTraceStart,
  TraceStage,
} from "./inference-trace.ts"

export type RuntimeTraceRequest = InferenceTraceStart

export type RuntimeTraceSpan = {
  mark(stage: TraceStage, metadata?: InferenceTraceMark): void
  finish(metadata?: InferenceTraceMark): void
  fail(error: unknown, metadata?: InferenceTraceMark): void
}

/** Keeps renderer-idle events on their own clock and routes live request events to its span. */
export class RuntimeTrace {
  readonly runtimeID: string
  readonly #sink: (event: InferenceTraceEvent) => void
  readonly #now: () => number
  readonly #runtime: ReturnType<typeof startInferenceTrace>
  #active:
    | {
        span: ReturnType<typeof startInferenceTrace>
        open: boolean
      }
    | undefined

  constructor(
    sink: (event: InferenceTraceEvent) => void,
    now: () => number = () => performance.now(),
    runtimeID = `renderer:${crypto.randomUUID()}`,
  ) {
    this.runtimeID = runtimeID
    this.#sink = sink
    this.#now = now
    this.#runtime = startInferenceTrace(
      {
        requestID: runtimeID,
        configuredEP: "webgpu",
        observedEP: "unknown",
      },
      sink,
      now,
      null,
    )
  }

  get hasActiveRequest() {
    return Boolean(this.#active?.open)
  }

  begin(request: RuntimeTraceRequest): RuntimeTraceSpan {
    const current = {
      span: startInferenceTrace(request, this.#sink, this.#now),
      open: true,
    }
    this.#active = current
    const close = () => {
      current.open = false
      if (this.#active === current) this.#active = undefined
    }
    return {
      mark: (stage, metadata) => {
        if (current.open) current.span.mark(stage, metadata)
      },
      finish: (metadata) => {
        if (!current.open) return
        current.span.finish(metadata)
        close()
      },
      fail: (error, metadata) => {
        if (!current.open) return
        current.span.fail(error, metadata)
        close()
      },
    }
  }

  mark(stage: TraceStage, metadata?: InferenceTraceMark) {
    const current = this.#active
    if (current?.open) current.span.mark(stage, metadata)
    else this.#runtime.mark(stage, { active: false, ...metadata })
  }

  rendererLag(lagMs: number, metadata?: InferenceTraceMark) {
    const active = this.hasActiveRequest
    this.mark("renderer-lag", {
      ...(active ? {} : { configuredEP: "unknown" as const }),
      ...metadata,
      active,
      rendererLagMs: lagMs,
      observedEP: "unknown",
    })
  }
}
