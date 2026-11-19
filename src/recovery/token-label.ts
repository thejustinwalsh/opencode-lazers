/** `92M`, `4k`, `1.2B`: a token count as a person reads it. Browser-safe, so panels can import it. */
export function tokenLabel(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}
