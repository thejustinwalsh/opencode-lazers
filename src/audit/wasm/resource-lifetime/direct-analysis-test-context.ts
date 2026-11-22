import { AsyncLocalStorage } from "node:async_hooks"

class DirectAnalysisTestExpiredError extends Error {
  constructor() {
    super("direct Fallow test body is no longer active")
    this.name = "DirectAnalysisTestExpiredError"
  }
}

class DirectAnalysisTestLifetime {
  private expired = false
  private resolveExpired!: () => void
  private readonly pendingOperations = new Set<Promise<unknown>>()
  private readonly expiredSignal = new Promise<void>((resolve) => {
    this.resolveExpired = resolve
  })

  close(): void {
    if (this.expired) return
    this.expired = true
    this.resolveExpired()
  }

  assertActive(): void {
    if (this.expired) throw new DirectAnalysisTestExpiredError()
  }

  waitForBodyCompletion(completion: Promise<unknown>): Promise<unknown> {
    return Promise.race([completion, this.expiredSignal.then(() => undefined)])
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pendingOperations.add(operation)
    void operation.then(
      () => this.pendingOperations.delete(operation),
      () => this.pendingOperations.delete(operation),
    )
    return operation
  }

  async drain(): Promise<void> {
    while (this.pendingOperations.size > 0) await Promise.allSettled([...this.pendingOperations])
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    this.assertActive()
    const outcome = await Promise.race([
      operation.then(
        (value) => ({ kind: "complete" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      this.expiredSignal.then(() => ({ kind: "expired" as const })),
    ])
    if (outcome.kind === "expired") throw new DirectAnalysisTestExpiredError()
    if (outcome.kind === "failed") {
      this.assertActive()
      throw outcome.error
    }
    this.assertActive()
    return outcome.value
  }
}

const testLifetimeStorage = new AsyncLocalStorage<DirectAnalysisTestLifetime>()

export function currentDirectAnalysisTestLifetime(): DirectAnalysisTestLifetime | undefined {
  return testLifetimeStorage.getStore()
}

export function runWithDirectAnalysisTestLifetime<T>(
  lifetime: DirectAnalysisTestLifetime,
  callback: () => T,
): T {
  return testLifetimeStorage.run(lifetime, callback)
}

export function createDirectAnalysisTestLifetime(): DirectAnalysisTestLifetime {
  return new DirectAnalysisTestLifetime()
}
