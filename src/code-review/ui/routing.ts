import { createEffect, createRoot, on } from "solid-js"

/** Resolves once `current()` reads `sessionID`, or when `signal` aborts first. */
export function whenRouted(
  current: () => string | undefined,
  sessionID: string,
  signal: AbortSignal,
): Promise<void> {
  if (current() === sessionID || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    createRoot((dispose) => {
      const finish = () => {
        signal.removeEventListener("abort", finish)
        dispose()
        resolve()
      }
      signal.addEventListener("abort", finish, { once: true })
      createEffect(on(current, (id) => id === sessionID && finish()))
    })
  })
}
