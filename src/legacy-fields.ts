import { z } from "zod"

/** Drop named keys from a plain object input; anything else passes through untouched. */
export function dropFields(input: unknown, fields: readonly string[]): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input
  if (!fields.some((field) => Object.hasOwn(input, field))) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !fields.includes(key)))
}

/**
 * Model tools never supply a version or revision. An earlier prompt may still send one: drop it
 * before validation so an in-flight session keeps working. The declared schema neither lists nor
 * documents the field.
 */
export function ignoringLegacyFields<T extends z.ZodType>(schema: T, fields: readonly string[]) {
  return z.preprocess((input) => dropFields(input, fields), schema)
}

/**
 * JSON Schema for a tool whose host may validate against the declared schema: the top level stays
 * open so a stray legacy field is not rejected host-side. The runtime parse behind it is strict
 * once the legacy fields are dropped, so every other unknown field is still refused.
 */
export function tolerantJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
  delete json.additionalProperties
  return json
}
