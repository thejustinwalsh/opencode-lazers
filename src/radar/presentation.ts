/** Restore independent pane scrolling only after its current content has mounted. */
export class ScrollRestoration {
  private generation = 0
  private key = ""
  private applied = ""

  constructor(
    private readonly schedule: (callback: () => void) => void = (callback) =>
      queueMicrotask(callback),
  ) {}

  restored(key: string) {
    return Boolean(key) && this.applied === key
  }

  restore(key: string, ready: boolean, element: { scrollTop: number } | undefined, top: number) {
    if (key !== this.key || !ready) this.applied = ""
    this.key = key
    const generation = ++this.generation
    if (!key || !ready || !element || this.restored(key)) return
    this.schedule(() => {
      if (generation !== this.generation) return
      element.scrollTop = top
      this.applied = key
    })
  }
}
