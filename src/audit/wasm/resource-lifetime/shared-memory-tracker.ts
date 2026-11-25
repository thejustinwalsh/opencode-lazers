/** Track allocated shared memories without dereferencing WeakRefs and pinning the prior run. */
export function createSharedMemoryTracker(): (memory: WebAssembly.Memory) => number {
  const unfinalized = new Set<number>()
  const registry = new FinalizationRegistry<number>((id) => unfinalized.delete(id))
  let nextID = 0

  return (memory) => {
    const priorAllocations = unfinalized.size
    const id = nextID++
    unfinalized.add(id)
    registry.register(memory, id)
    return priorAllocations
  }
}
