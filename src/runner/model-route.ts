import type { ModelPolicy } from "./schema.ts"

/** OpenCode may read an omitted effort back as its explicit default sentinel. */
export function sameNativeModel(
  actual: ModelPolicy | null | undefined,
  expected: ModelPolicy | null | undefined,
): boolean {
  return Boolean(
    actual &&
    expected &&
    actual.providerID === expected.providerID &&
    actual.id === expected.id &&
    (actual.variant ?? "default") === (expected.variant ?? "default"),
  )
}
