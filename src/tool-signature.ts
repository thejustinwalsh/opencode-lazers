import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Plugin } from "@opencode/plugin/effect"
import { z } from "zod"
import { leanInputSchema, SOURCE } from "./tool-input.ts"

/**
 * Keywords that constrain a value without telling a caller what it is. In a result type they only
 * cost prompt tokens: the tool already produced a valid value, and OpenCode renders each as a doc
 * tag on every field.
 */
const RESULT_NOISE = new Set([
  "$schema",
  "title",
  "description",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "multipleOf",
  "default",
  "additionalProperties",
])

/** A result schema's JSON Schema with the validation keywords removed; shape and enums stay. */
export function leanResultSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(leanResultSchema)
  if (typeof schema !== "object" || schema === null) return schema
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      // `properties` and `$defs` are maps of names to schemas, not keywords: keep every key.
      .filter(([key]) => !RESULT_NOISE.has(key))
      .map(([key, value]) => [
        key,
        key === "properties" || key === "$defs" || key === "definitions"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([name, child]) => [
                name,
                leanResultSchema(child),
              ]),
            )
          : leanResultSchema(value),
      ]),
  )
}

/**
 * The same schema for the host's output validation, with a leaner JSON Schema for the signature
 * Code Mode shows a model. Validation is Zod's own, unchanged.
 */
export function leanResult<S extends z.ZodType>(schema: S): S {
  const standard = schema["~standard"] as StandardSchemaV1.Props & {
    jsonSchema: { input: (o: object) => object; output: (o: object) => object }
  }
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: standard.jsonSchema.input,
        output: (options: object) => leanResultSchema(standard.jsonSchema.output(options)),
      },
    },
  } as unknown as S
}

/** The same schema for host input validation, with the redundant Zod additions left out of the signature. */
export function leanInput<S extends z.ZodType>(schema: S): S {
  const standard = schema["~standard"] as StandardSchemaV1.Props & {
    jsonSchema: { input: (o: object) => object; output: (o: object) => object }
  }
  const lean = {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: (options: object) => leanInputSchema(standard.jsonSchema.input(options)),
        output: standard.jsonSchema.output,
      },
    },
  }
  // The usage on a wrong call needs the Zod schema behind the wrapper.
  Object.defineProperty(lean, SOURCE, { value: schema })
  return lean as unknown as S
}

type Slimmable = { name: string; input?: unknown; output?: unknown }

/** A registered tool with its input and result types slimmed for the signature; anything else is unchanged. */
export function slimTool<T extends Slimmable>(tool: T): T {
  if (!tool.name.startsWith("lz-")) return tool
  return {
    ...tool,
    ...(tool.input instanceof z.ZodType ? { input: leanInput(tool.input) } : {}),
    ...(tool.output instanceof z.ZodType ? { output: leanResult(tool.output) } : {}),
  }
}

/** Slim every `lz-*` input and result type once all tools are registered. Validation is untouched. */
export function registerToolSignatures(ctx: Pick<Plugin.Context, "tool">) {
  return ctx.tool.transform((editor) => {
    for (const tool of editor.list()) {
      if (!tool.name.startsWith("lz-")) continue
      const slim = slimTool(tool)
      if (slim.input === tool.input && slim.output === tool.output) continue
      editor.update(tool.id, (entry) => {
        entry.input = slim.input
        entry.output = slim.output
      })
    }
  })
}
