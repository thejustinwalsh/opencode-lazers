export interface DisposableModel {
  dispose(): Promise<void>
}

/** A failed load whose allocated GPU resource could not be proven clean. */
export class CleanupUncertainError extends Error implements DisposableModel {
  constructor(
    private readonly model: DisposableModel,
    readonly cleanupError: unknown,
    cause: unknown,
  ) {
    super(`GPU cleanup failed; ownership is retained: ${String(cleanupError)}`, { cause })
    this.name = "CleanupUncertainError"
  }

  dispose() {
    return this.model.dispose()
  }
}

/** Serializes disposal and allocation. A failed disposal never permits a second GPU allocation. */
export class ExclusiveModels<M extends Record<string, DisposableModel>> {
  private entry: { kind: keyof M; value: DisposableModel } | undefined
  private transition: Promise<unknown> = Promise.resolve()
  private tainted = false

  get<K extends keyof M>(kind: K): M[K] | undefined {
    return !this.tainted && this.entry?.kind === kind ? (this.entry.value as M[K]) : undefined
  }

  isTainted() {
    return this.tainted
  }

  current(): keyof M | undefined {
    return this.entry?.kind
  }

  private async evict() {
    if (!this.entry) return
    try {
      await this.entry.value.dispose()
    } catch (error) {
      this.tainted = true
      throw error
    }
    this.entry = undefined
    this.tainted = false
  }

  ensure<K extends keyof M>(
    kind: K,
    load: () => Promise<M[K]>,
    signal: AbortSignal,
  ): Promise<M[K]> {
    const operation = this.transition
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted()
        const existing = this.get(kind)
        if (existing) return existing
        await this.evict()
        signal.throwIfAborted()
        let value: M[K]
        try {
          value = await load()
        } catch (error) {
          if (error instanceof CleanupUncertainError) {
            this.entry = { kind, value: error }
            this.tainted = true
          }
          throw error
        }
        this.entry = { kind, value }
        if (signal.aborted) {
          await this.evict()
          signal.throwIfAborted()
        }
        return value
      })
    this.transition = operation
    return operation
  }

  release() {
    const operation = this.transition.catch(() => {}).then(() => this.evict())
    this.transition = operation
    return operation
  }
}

const recoverable = (error: unknown) =>
  /device.{0,20}lost|GPU device|disconnect|transport|network|fetch failed|download failed: (429|5\d\d)/i.test(
    String(error),
  )

/** One retry for transient loading failures, with an abortable backoff. Inference is never replayed. */
export async function retryLoad<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  retry: (message: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      return await run()
    } catch (error) {
      if (
        attempt >= 1 ||
        signal.aborted ||
        error instanceof CleanupUncertainError ||
        !recoverable(error)
      )
        throw error
      retry("Retrying model load (2/2)")
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        }
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort)
          resolve()
        }, 750)
        signal.addEventListener("abort", abort, { once: true })
      })
    }
  }
}
