type Renderer = {
  isDestroyed(): boolean
  getBackgroundThrottling(): boolean
  setBackgroundThrottling(allowed: boolean): void
}

/** Keep the inference mailbox responsive while a relayed request is outstanding. */
export class RendererActivity {
  private active = false
  private readonly previous = new Map<Renderer, boolean>()

  constructor(private readonly renderers: () => readonly Renderer[]) {}

  watch(renderer: Renderer) {
    if (!this.active || this.previous.has(renderer) || renderer.isDestroyed()) return
    const previous = renderer.getBackgroundThrottling()
    renderer.setBackgroundThrottling(false)
    this.previous.set(renderer, previous)
  }

  set(active: boolean) {
    this.active = active
    if (active) {
      for (const renderer of this.renderers()) this.watch(renderer)
      return
    }
    for (const [renderer, previous] of this.previous) {
      if (!renderer.isDestroyed()) renderer.setBackgroundThrottling(previous)
    }
    this.previous.clear()
  }
}
