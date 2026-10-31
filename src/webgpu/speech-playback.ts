/** One decoded chunk ahead, with ordered playback and shared cancellation. No unbounded audio queue. */
export async function playSpeech<T>(
  segments: readonly string[],
  options: {
    signal: AbortSignal
    prepare(text: string, signal: AbortSignal): Promise<T>
    play(value: T, signal: AbortSignal): Promise<void>
    waiting(): void
  },
) {
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const prepare = (text: string) => {
    let ready = false
    const result = (async () => {
      try {
        signal.throwIfAborted()
        return { ok: true as const, value: await options.prepare(text, signal) }
      } catch (error) {
        // Capture immediately: a prefetched failure waits until current playback finishes.
        return { ok: false as const, error }
      } finally {
        ready = true
      }
    })()
    return { result, ready: () => ready }
  }
  try {
    let pending = segments[0] ? prepare(segments[0]) : undefined
    for (let i = 0; pending; i++) {
      signal.throwIfAborted()
      if (!pending.ready()) options.waiting()
      const result = await pending.result
      signal.throwIfAborted()
      if (!result.ok) throw result.error
      const next = segments[i + 1]
      pending = next ? prepare(next) : undefined
      await options.play(result.value, signal)
    }
  } finally {
    // Also stop a prefetched generation if playback fails before consuming it.
    controller.abort()
  }
}
