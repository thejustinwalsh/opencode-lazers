import { unavailable } from "./contract.ts"
import type { Usage } from "./contract.ts"

/** One polling lease per live client, shared by all active visible headers. */
export class SharedUsage {
  private listeners = new Set<(value: Usage) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private watchController: AbortController | undefined
  private value = unavailable("Loading provider usage…")
  constructor(
    private read: (signal: AbortSignal) => Promise<Usage>,
    private interval: number | (() => number) = 60_000,
    private watch?: (invalidate: () => void, signal: AbortSignal) => Promise<void>,
  ) {}
  subscribe(listener: (value: Usage) => void) {
    this.listeners.add(listener)
    listener(this.value)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.watchController = new AbortController()
      void this.watch?.(() => this.invalidate(), this.watchController.signal).catch(() => {})
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearTimeout(this.timer)
        this.controller?.abort()
        this.controller = undefined
        this.watchController?.abort()
        this.value = unavailable("Loading provider usage…")
      }
    }
  }
  private invalidate() {
    clearTimeout(this.timer)
    this.controller?.abort()
    if (this.listeners.size) void this.refresh()
  }
  private async refresh() {
    const controller = new AbortController()
    this.controller = controller
    this.value = unavailable("Refreshing provider usage…")
    for (const listener of this.listeners) listener(this.value)
    let value: Usage
    try {
      value = await this.read(controller.signal)
    } catch {
      value = unavailable()
    }
    if (controller.signal.aborted || this.controller !== controller) return
    this.value = value
    for (const listener of this.listeners) listener(value)
    if (this.listeners.size)
      this.timer = setTimeout(
        () => void this.refresh(),
        typeof this.interval === "number" ? this.interval : this.interval(),
      )
  }
}
