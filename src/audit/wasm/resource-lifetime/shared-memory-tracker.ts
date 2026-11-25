export type SharedMemorySnapshot = {
  live: number
  pendingFinalizers: number
}

/** Track weak reachability separately from FinalizationRegistry callback delivery. */
export function createSharedMemoryTracker(): {
  track(memory: WebAssembly.Memory): void
  snapshot(): SharedMemorySnapshot
} {
  const pendingFinalizers = new Set<number>()
  const references = new Map<number, WeakRef<WebAssembly.Memory>>()
  const registry = new FinalizationRegistry<number>((id) => pendingFinalizers.delete(id))
  let nextID = 0

  return {
    track(memory) {
      const id = nextID++
      pendingFinalizers.add(id)
      references.set(id, new WeakRef(memory))
      registry.register(memory, id)
    },
    snapshot() {
      let live = 0
      for (const [id, reference] of references) {
        if (reference.deref() === undefined) references.delete(id)
        else live++
      }
      return { live, pendingFinalizers: pendingFinalizers.size }
    },
  }
}
