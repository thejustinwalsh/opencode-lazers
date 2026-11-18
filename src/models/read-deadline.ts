/** How long a Models read may take before the panel shows its failed state with Retry. */
export const READ_DEADLINE_MS = 30_000

/**
 * Runs `read` under a deadline. The request is aborted at the deadline and the returned promise
 * rejects with a timeout, even when the transport ignores the abort signal.
 */
export function withReadDeadline<T>(
  parent: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
  ms = READ_DEADLINE_MS,
): Promise<T> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([parent, deadline.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Timed out waiting for the LAZERS service")
      deadline.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([read(signal), expired]).finally(() => clearTimeout(timer))
}
