import { z } from "zod"

/**
 * One account of what a LAZERS tool takes, used when a call is wrong.
 *
 * Tool inputs reach LAZERS in two forms: a Zod schema passed straight to `editor.add`, or a JSON
 * Schema produced from one. `declareInput` produces the JSON form and remembers the Zod source so
 * the failure path can name the fields that were wrong and render the tool's full usage.
 */
const declared = new WeakMap<object, z.ZodType>()

type JsonSchema = Record<string, unknown>

/** JSON Schema for a tool input, tied to the Zod schema that validates it. */
export function declareInput(schema: z.ZodType, options: { tolerant?: boolean } = {}): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "input" }) as JsonSchema
  // The top level stays open so a stray legacy field is not rejected host-side; the runtime parse
  // behind it stays strict.
  if (options.tolerant) delete json.additionalProperties
  declared.set(json, schema)
  return json
}

/** The Zod schema behind a registered tool input, when there is one. */
export function zodInput(input: unknown): z.ZodType | undefined {
  if (input instanceof z.ZodType) return input
  if (typeof input === "object" && input !== null) return declared.get(input)
  return undefined
}

function jsonInput(input: unknown, schema: z.ZodType): JsonSchema | undefined {
  if (typeof input === "object" && input !== null && !(input instanceof z.ZodType))
    return input as JsonSchema
  try {
    return z.toJSONSchema(schema, { io: "input" }) as JsonSchema
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// Plain-words issues

function describeValue(value: unknown): string {
  if (value === undefined) return "nothing"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  if (typeof value === "string")
    return value.length > 40
      ? `a string of ${value.length} characters`
      : `the string ${JSON.stringify(value)}`
  return `the ${typeof value} ${String(value)}`
}

function at(value: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

export function pathLabel(path: ReadonlyArray<PropertyKey>): string {
  let label = ""
  for (const key of path)
    label += typeof key === "number" ? `[${key}]` : label === "" ? String(key) : `.${String(key)}`
  return label === "" ? "(the whole input)" : label
}

function allowedAt(json: JsonSchema | undefined, path: ReadonlyArray<PropertyKey>): string[] {
  let node: unknown = json
  const defs = json?.$defs as Record<string, unknown> | undefined
  const resolve = (value: unknown): unknown => {
    const ref = (value as { $ref?: unknown } | undefined)?.$ref
    return typeof ref === "string" ? (defs?.[ref.split("/").at(-1) ?? ""] ?? value) : value
  }
  for (const key of path) {
    node = resolve(node)
    const record = node as { properties?: Record<string, unknown>; items?: unknown } | undefined
    node = typeof key === "number" ? record?.items : record?.properties?.[String(key)]
  }
  node = resolve(node)
  return Object.keys((node as { properties?: object } | undefined)?.properties ?? {})
}

/** What was wrong, one line per problem, in words a model can act on. */
export function plainIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  input: unknown,
  json?: JsonSchema,
  prefix: ReadonlyArray<PropertyKey> = [],
): string[] {
  const lines: string[] = []
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    const label = pathLabel(path)
    const received = at(input, path)
    switch (issue.code) {
      case "invalid_type":
        lines.push(
          received === undefined
            ? `${label}: required, missing.`
            : `${label}: expected ${issue.expected}, got ${describeValue(received)}.`,
        )
        break
      case "unrecognized_keys": {
        const allowed = allowedAt(json, path)
        lines.push(
          `${label}: unknown ${issue.keys.length === 1 ? "field" : "fields"} ${issue.keys
            .map((key) => JSON.stringify(key))
            .join(", ")}${allowed.length > 0 ? `; allowed: ${allowed.join(", ")}` : ""}.`,
        )
        break
      }
      case "invalid_value":
        lines.push(
          `${label}: must be one of ${issue.values.map((value) => JSON.stringify(value)).join(", ")}; got ${describeValue(received)}.`,
        )
        break
      case "too_small":
      case "too_big": {
        const small = issue.code === "too_small"
        const limit = issue.code === "too_small" ? issue.minimum : issue.maximum
        const noun =
          issue.origin === "string"
            ? "character"
            : issue.origin === "array" || issue.origin === "set"
              ? "item"
              : ""
        const unit = noun === "" ? "" : ` ${noun}${limit === 1 || limit === 1n ? "" : "s"}`
        const bound = `${small ? "at least" : "at most"} ${String(limit)}${unit}`
        lines.push(
          `${label}: must be ${bound}${received === undefined ? "" : `; got ${describeValue(received)}`}.`,
        )
        break
      }
      case "invalid_union": {
        lines.push(`${label}: matches none of the allowed forms:`)
        issue.errors.forEach((branch, index) => {
          for (const line of plainIssues(branch, input, json, path))
            lines.push(`  form ${index + 1}: ${line}`)
        })
        break
      }
      default:
        lines.push(`${label}: ${issue.message}`)
    }
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// Usage

type Node = {
  type?: unknown
  properties?: Record<string, Node>
  required?: string[]
  items?: Node
  enum?: unknown[]
  const?: unknown
  anyOf?: Node[]
  oneOf?: Node[]
  allOf?: Node[]
  $ref?: string
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  format?: string
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  additionalProperties?: Node | boolean
}

function resolver(root: JsonSchema) {
  // `$ref` is a JSON pointer into the document: `#/$defs/name`, or a path to a schema that
  // Zod reused in place.
  const lookup = (ref: string): Node | undefined => {
    if (!ref.startsWith("#/")) return undefined
    let current: unknown = root
    for (const part of ref.slice(2).split("/")) {
      if (typeof current !== "object" || current === null) return undefined
      current = (current as Record<string, unknown>)[
        part.replaceAll("~1", "/").replaceAll("~0", "~")
      ]
    }
    return current as Node | undefined
  }
  return (node: Node): Node => {
    let current = node
    for (let guard = 0; current.$ref !== undefined && guard < 8; guard++) {
      const target = lookup(current.$ref)
      if (!target) break
      const { $ref: _ref, ...rest } = current
      current = { ...target, ...rest }
    }
    return current
  }
}

function constraints(node: Node): string {
  const parts: string[] = []
  if (node.minLength !== undefined || node.maxLength !== undefined)
    parts.push(
      node.maxLength === undefined
        ? `at least ${node.minLength} character${node.minLength === 1 ? "" : "s"}`
        : `${node.minLength ?? 0}-${node.maxLength} characters`,
    )
  // The safe-integer bound Zod adds to every integer is not a rule worth printing.
  const maximum = node.maximum === Number.MAX_SAFE_INTEGER ? undefined : node.maximum
  const minimum =
    node.minimum ?? (node.exclusiveMinimum === undefined ? undefined : node.exclusiveMinimum + 1)
  if (minimum !== undefined || maximum !== undefined)
    parts.push(
      maximum === undefined
        ? `at least ${minimum}`
        : minimum === undefined
          ? `at most ${maximum}`
          : `${minimum} to ${maximum}`,
    )
  if (node.minItems !== undefined || node.maxItems !== undefined)
    parts.push(
      node.maxItems === undefined
        ? `at least ${node.minItems} items`
        : `${node.minItems ?? 0}-${node.maxItems} items`,
    )
  if (node.pattern !== undefined && node.pattern !== "\\S" && node.pattern.length <= 60)
    parts.push(`pattern ${node.pattern}`)
  if (node.default !== undefined) parts.push(`default ${JSON.stringify(node.default)}`)
  return parts.join(", ")
}

/**
 * Field-by-field usage: `name  type, required|optional  constraints — description`, nested
 * objects indented. A definition reached again inside itself prints once as `...`.
 */
function usageLines(
  root: JsonSchema,
  node: Node,
  indent: string,
  resolve: (node: Node) => Node,
  trail: ReadonlyArray<Node>,
): string[] {
  const here = resolve(node)
  // A schema that refers back to itself is cut off rather than printed forever.
  if (trail.includes(here) || trail.length > 6) return [`${indent}...`]
  const next = [...trail, here]
  const branches = here.anyOf ?? here.oneOf
  if (branches && !here.properties) {
    const objects = branches.map(resolve).filter((branch) => branch.properties)
    if (objects.length > 0)
      return objects.flatMap((branch, index) => [
        `${indent}form ${index + 1}:`,
        ...usageLines(root, branch, `${indent}  `, resolve, next),
      ])
  }
  const properties = here.properties ?? {}
  const required = new Set(here.required ?? [])
  return Object.entries(properties).flatMap(([name, raw]) => {
    const field = resolve(raw)
    const note = [constraints(field), field.description].filter(Boolean).join(" — ")
    const head = `${indent}${name}  ${typeLabel(field, resolve)}, ${required.has(name) ? "required" : "optional"}${note ? `  ${note}` : ""}`
    const item = field.items ? resolve(field.items) : undefined
    const shaped = (candidate: Node | undefined) =>
      candidate !== undefined &&
      (candidate.properties !== undefined ||
        (candidate.anyOf ?? candidate.oneOf)?.some((branch) => resolve(branch).properties))
    const inner = shaped(field) ? field : shaped(item) ? item : undefined
    return [head, ...(inner ? usageLines(root, inner, `${indent}  `, resolve, next) : [])]
  })
}

function typeLabel(node: Node, resolve: (node: Node) => Node, depth = 0): string {
  if (depth > 3) return "any"
  if (node.const !== undefined) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ")
  const union = node.anyOf ?? node.oneOf
  if (union)
    return union.map((branch) => typeLabel(resolve(branch), resolve, depth + 1)).join(" | ")
  if (Array.isArray(node.type)) return node.type.join(" | ")
  if (node.type === "array")
    return `array of ${node.items ? typeLabel(resolve(node.items), resolve, depth + 1) : "any"}`
  if (node.type === "object" || node.properties) return "object"
  if (node.type === "integer") return "integer"
  return typeof node.type === "string" ? node.type : "any"
}

// ---------------------------------------------------------------------------------------------
// Example

function sample(node: Node, resolve: (node: Node) => Node, depth: number): unknown {
  const here = resolve(node)
  if (depth > 14) return undefined
  if (here.const !== undefined) return here.const
  if (here.enum) return here.enum[0]
  const union = here.anyOf ?? here.oneOf
  if (union) {
    const first = union.map(resolve).find((branch) => branch.type !== "null") ?? union[0]
    return first ? sample(first, resolve, depth + 1) : undefined
  }
  const type = Array.isArray(here.type) ? here.type.find((entry) => entry !== "null") : here.type
  switch (type) {
    case "string":
      if (here.format === "uuid") return "123e4567-e89b-42d3-a456-426614174000"
      if (here.format === "date-time") return "2026-01-01T00:00:00.000Z"
      return "x".repeat(Math.max(here.minLength ?? 1, 1))
    case "integer":
    case "number": {
      const floor =
        here.minimum ??
        (here.exclusiveMinimum === undefined ? undefined : here.exclusiveMinimum + 1)
      return floor ?? (here.maximum !== undefined ? Math.min(1, here.maximum) : 1)
    }
    case "boolean":
      return false
    case "array": {
      const item = here.items ? sample(here.items, resolve, depth + 1) : undefined
      return item === undefined
        ? []
        : Array.from({ length: Math.max(here.minItems ?? 1, 1) }, () => item)
    }
    case "object":
    default: {
      const required = new Set(here.required ?? [])
      const out: Record<string, unknown> = {}
      if (!here.properties && typeof here.additionalProperties === "object") {
        const value = sample(here.additionalProperties, resolve, depth + 1)
        return value === undefined ? out : { x: value }
      }
      for (const [name, property] of Object.entries(here.properties ?? {})) {
        if (!required.has(name)) continue
        const value = sample(property, resolve, depth + 1)
        if (value !== undefined) out[name] = value
      }
      return out
    }
  }
}

/**
 * A minimal call that this tool accepts: its required fields filled with placeholders. Tools whose
 * required values carry rules a placeholder cannot meet give an example here by name; the usage
 * test asserts that every example passes the tool's own schema.
 */
const ID = "123e4567-e89b-42d3-a456-426614174000"
export const EXAMPLE_OVERRIDES: Record<string, unknown> = {
  "lz-inspect-trajectory": { taskID: ID },
  "lz-submit-plan": {
    requestID: "plan-1",
    objective: "Describe the outcome of the whole plan.",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    nodes: [{ taskID: ID, revision: 1 }],
    dependencies: [],
    integrationOrder: [ID],
    verification: [{ id: "verify", command: "bun run verify" }],
    acceptance: [
      {
        id: "outcome",
        assertion: "The outcome is observable.",
        evidence: [{ kind: "verification", verificationID: "verify" }],
      },
    ],
  },
}

export function rawSample(input: unknown): unknown {
  const schema = zodInput(input)
  const json = schema && jsonInput(input, schema)
  return json ? sample(json as Node, resolver(json), 0) : undefined
}

export function exampleFor(name: string, input: unknown): unknown {
  const schema = zodInput(input)
  if (!schema) return undefined
  const candidate =
    name in EXAMPLE_OVERRIDES
      ? EXAMPLE_OVERRIDES[name]
      : (() => {
          const json = jsonInput(input, schema)
          return json ? sample(json as Node, resolver(json), 0) : undefined
        })()
  return schema.safeParse(candidate).success ? candidate : undefined
}

/** The tool's full usage: its fields, whether each is required, and one valid example. */
export function usageFor(name: string, input: unknown): string | undefined {
  const schema = zodInput(input)
  if (!schema) return undefined
  const json = jsonInput(input, schema)
  if (!json) return undefined
  const resolve = resolver(json)
  const fields = usageLines(json, json as Node, "  ", resolve, [])
  const example = exampleFor(name, input)
  return [
    `Usage of ${name}, an object with these fields:`,
    ...(fields.length > 0 ? fields : ["  (no fields)"]),
    ...(example === undefined ? [] : ["Example:", `  ${JSON.stringify(example)}`]),
  ].join("\n")
}

/**
 * The failure text for a call that does not match the tool's input: what was wrong, then the full
 * usage. Undefined when the input does in fact validate (the failure was something else) or when
 * the tool's schema is not known.
 */
export function explainInvalidInput(
  name: string,
  input: unknown,
  args: unknown,
): string | undefined {
  const schema = zodInput(input)
  if (!schema) return undefined
  const parsed = schema.safeParse(args)
  if (parsed.success) return undefined
  const json = jsonInput(input, schema)
  const usage = usageFor(name, input)
  return [
    `${name} was called with arguments that do not match its input:`,
    ...plainIssues(parsed.error.issues, args, json).map((line) => `- ${line}`),
    ...(usage ? ["", usage] : []),
  ].join("\n")
}
