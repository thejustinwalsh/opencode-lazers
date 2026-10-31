/** Main-process ownership stays reserved until outstanding cache work has drained. */
export class ModelLease {
  private owner: { window: number; token: string } | undefined
  private retiring: Promise<void> | undefined
  private clearing = false
  constructor(private readonly drain: () => Promise<void>) {}
  occupied() {
    return Boolean(this.owner || this.retiring || this.clearing)
  }
  acquire(window: number) {
    if (this.occupied()) throw new Error("The model cache is owned or being cleaned up")
    this.owner = { window, token: crypto.randomUUID() }
    return this.owner.token
  }
  assert(window: number, token: string) {
    if (this.retiring || this.owner?.window !== window || this.owner.token !== token)
      throw new Error("This window does not own the WebGPU model")
  }
  release(window: number, token: string) {
    this.assert(window, token)
    return this.retire()
  }
  lost(window: number) {
    return this.owner?.window === window ? this.retire() : Promise.resolve()
  }
  private retire() {
    if (this.retiring) return this.retiring
    // Defer drain so the retirement barrier is installed before callbacks run.
    const operation = Promise.resolve().then(async () => {
      await this.drain()
      this.owner = undefined
    })
    this.retiring = operation
    return operation.finally(() => {
      this.retiring = undefined
    })
  }
  async clear(run: () => Promise<void>) {
    if (this.occupied()) throw new Error("Unload the model before removing cached files")
    this.clearing = true
    try {
      await run()
    } finally {
      this.clearing = false
    }
  }
}
