function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Format public RPC errors without coercing objects or exposing arbitrary fields. */
export function panelErrorMessage(value: unknown, fallback = "Request failed."): string {
  const error = object(value)
  const data = object(error?.data)
  const nested = object(error?.error)
  const message = [
    error?.message,
    data?.message,
    data?.reason,
    nested?.message,
    typeof value === "string" ? value : undefined,
  ].find((candidate) => typeof candidate === "string" && candidate.trim())
  if (typeof message !== "string") return fallback
  const text =
    typeof data?.recovery === "string" ? `${message} Recovery: ${data.recovery}.` : message
  let safe = ""
  for (const character of text) {
    const code = character.codePointAt(0)!
    safe += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character
  }
  return safe.trim().slice(0, 320) || fallback
}
