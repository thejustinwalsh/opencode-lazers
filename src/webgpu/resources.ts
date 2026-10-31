/** Own partially constructed inference resources, including failures before session.run returns. */
export async function withResources<T>(
  run: (own: <R extends { dispose(): void }>(resource: R) => R) => Promise<T>,
): Promise<T> {
  const resources: { dispose(): void }[] = []
  let result: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    const value = await run((resource) => {
      resources.push(resource)
      return resource
    })
    result = { ok: true, value }
  } catch (error) {
    result = { ok: false, error }
  }
  const errors: unknown[] = []
  for (const resource of resources.reverse()) {
    try {
      resource.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length)
    throw new AggregateError(
      !result.ok ? [result.error, ...errors] : errors,
      "Inference resource cleanup failed",
    )
  if (!result.ok) throw result.error
  return result.value
}
