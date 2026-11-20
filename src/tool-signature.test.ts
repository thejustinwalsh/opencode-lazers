import { expect, test } from "bun:test"
import { Effect } from "effect"
import { z } from "zod"
import { collectTools } from "../test/tool-inventory.ts"
import { leanInputSchema, zodInput } from "./tool-input.ts"
import { leanResultSchema, registerToolSignatures, slimTool } from "./tool-signature.ts"

const raw = await collectTools({ raw: true })
const slim = await collectTools()

type Standard = {
  "~standard": {
    validate: (value: unknown) => { issues?: unknown[] } | Promise<{ issues?: unknown[] }>
    jsonSchema: Record<"input" | "output", (o: object) => unknown>
  }
}
const standardOf = (value: unknown) => (value as Standard)["~standard"]

test("slimming leaves validation exactly as it was", async () => {
  let slimmed = 0
  for (const [name, original] of raw) {
    const after = slim.get(name)!
    for (const key of ["input", "output"] as const) {
      const before = original[key]
      const now = after[key]
      if (!(before instanceof z.ZodType)) {
        expect(now, `${name}.${key} unchanged`).toEqual(before)
        continue
      }
      slimmed++
      for (const probe of [{}, null, "text", [], { message: 1 }]) {
        const was = before.safeParse(probe).success
        const result = await standardOf(now).validate(probe)
        expect(result.issues === undefined, `${name}.${key} accepts what it accepted`).toBe(was)
      }
    }
  }
  expect(slimmed).toBeGreaterThan(40)
})

test("a slimmed schema still describes the same fields and keeps the usage source", () => {
  const before = raw.get("lz-get-task")!
  const after = slim.get("lz-get-task")!
  const fields = (schema: unknown) =>
    Object.keys(
      (
        standardOf(schema).jsonSchema.input({ target: "draft-2020-12" }) as {
          properties: Record<string, unknown>
        }
      ).properties,
    )
  expect(fields(after.input)).toEqual(fields(before.input))
  expect(zodInput(after.input)).toBeInstanceOf(z.ZodType)
})

test("results drop validation keywords and inputs drop only what Zod adds by itself", () => {
  const result = leanResultSchema({
    type: "object",
    description: "a note",
    properties: {
      id: { type: "string", format: "uuid", pattern: "^x$", description: "id" },
      description: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  })
  expect(result).toEqual({
    type: "object",
    properties: { id: { type: "string" }, description: { type: "string" } },
    required: ["id"],
  })
  const input = leanInputSchema({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", pattern: "^uuid$", description: "kept" },
      slug: { type: "string", pattern: "^[a-z]+$" },
      n: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
  })
  expect(input).toEqual({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", description: "kept" },
      slug: { type: "string", pattern: "^[a-z]+$" },
      n: { type: "integer", minimum: 1 },
    },
  })
})

test("the rendered signatures no longer carry the uuid regex", () => {
  for (const [name, tool] of slim) {
    for (const key of ["input", "output"] as const) {
      const value = tool[key]
      const json = JSON.stringify(
        typeof value === "object" && value !== null && "~standard" in value
          ? standardOf(value).jsonSchema[key]({ target: "draft-2020-12" })
          : value,
      )
      expect(json ?? "", `${name}.${key}`).not.toContain("[0-9a-fA-F]{8}")
    }
  }
})

test("the transform slims lz tools in place and leaves other tools alone", () => {
  const updated: string[] = []
  const tools = [
    {
      id: "lz-get-task",
      name: "lz-get-task",
      input: raw.get("lz-get-task")!.input,
      output: raw.get("lz-get-task")!.output,
    },
    { id: "shell", name: "shell", input: z.object({}), output: z.object({}) },
  ]
  const editor = {
    list: () => tools,
    update: (id: string, change: (entry: Record<string, unknown>) => void) => {
      updated.push(id)
      change(tools.find((tool) => tool.id === id) as never)
    },
  }
  const ctx = {
    tool: {
      transform: (callback: (editor: never) => void) =>
        Effect.sync(() => callback(editor as never)),
    },
  }
  Effect.runSync(registerToolSignatures(ctx as never) as never)
  expect(updated).toEqual(["lz-get-task"])
  expect(slimTool({ name: "shell", input: tools[1]!.input })).toEqual({
    name: "shell",
    input: tools[1]!.input,
  })
})

test("pinned tools are the read paths used on most sessions; the rarest are found through search", () => {
  const pinned = [...raw.values()]
    .filter((tool) => tool.options?.pinned === true)
    .map((tool) => tool.name)
  expect(pinned.sort()).toEqual([
    "lz-get-task",
    "lz-inspect-trajectory",
    "lz-project-index",
    "lz-project-read",
    "lz-project-refresh",
    "lz-query-tasks",
    "lz-repo-snapshot",
  ])
})
