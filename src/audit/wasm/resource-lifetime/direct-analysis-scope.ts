type DirectAnalysisMetrics = {
  queued: number
  started: number
  cancelled: number
  completed: number
  queueWaitMs: number
  executionMs: number
  terminationMs: number
  gcMs: number
  pendingHelpers: number
  peakHelpers: number
}

let analysisTail: Promise<void> = Promise.resolve()
const scopesByRoot = new Map<string, DirectAnalysisScope>()

export class DirectAnalysisScopeClosedError extends Error {
  constructor() {
    super("direct Fallow analysis scope is closed")
    this.name = "DirectAnalysisScopeClosedError"
  }
}

/**
 * Serializes direct analyses and binds their queued and running lifetime to one fixture root.
 * Closing a scope rejects queued work, drains running cleanup, and leaves a closed tombstone so
 * timed-out test bodies cannot reopen the scope by calling runOp again.
 */
class DirectAnalysisScope {
  readonly metrics: DirectAnalysisMetrics = {
    queued: 0,
    started: 0,
    cancelled: 0,
    completed: 0,
    queueWaitMs: 0,
    executionMs: 0,
    terminationMs: 0,
    gcMs: 0,
    pendingHelpers: 0,
    peakHelpers: 0,
  }

  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private closePromise: Promise<void> | undefined

  run<T>(operation: () => T | Promise<T>, afterOperation?: () => void | Promise<void>): Promise<T> {
    const queuedAt = performance.now()
    this.metrics.queued++
    if (this.closed) {
      this.metrics.cancelled++
      return this.observe(Promise.reject(new DirectAnalysisScopeClosedError()))
    }

    const completion = analysisTail.then(async () => {
      this.metrics.queueWaitMs += performance.now() - queuedAt
      if (this.closed) {
        this.metrics.cancelled++
        throw new DirectAnalysisScopeClosedError()
      }
      this.metrics.started++
      try {
        return await operation()
      } finally {
        try {
          await afterOperation?.()
        } finally {
          this.metrics.completed++
        }
      }
    })
    this.pending.add(completion)
    analysisTail = completion.then(
      () => {},
      () => {},
    )
    void completion.catch(() => {}).then(() => this.pending.delete(completion))
    return this.observe(completion)
  }

  async closeAndDrain(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true
      this.closePromise = (async () => {
        while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      })()
    }
    await this.closePromise
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private observe<T>(promise: Promise<T>): Promise<T> {
    // Test callbacks can be abandoned by Bun after their timeout; keep the underlying completion
    // observed even when the callback no longer awaits the runOp promise.
    void promise.catch(() => {})
    return promise
  }
}

export function openDirectAnalysisScope(root: string): DirectAnalysisScope {
  const scope = new DirectAnalysisScope()
  scopesByRoot.set(root, scope)
  return scope
}

export function directAnalysisScopeFor(root: string): DirectAnalysisScope {
  let scope = scopesByRoot.get(root)
  if (!scope) {
    scope = new DirectAnalysisScope()
    scopesByRoot.set(root, scope)
  }
  return scope
}

export async function closeDirectAnalysisScope(root: string): Promise<void> {
  await scopesByRoot.get(root)?.closeAndDrain()
}
