import { z } from "zod"

const ChangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    content: z.string(),
    highlight: z.enum([
      "comment",
      "delimiter",
      "keyword",
      "normal",
      "string",
      "tree_sitter_error",
      "type",
    ]),
  })
  .strict()
export type DifftasticChange = z.infer<typeof ChangeSchema>

const SideSchema = z
  .object({
    line_number: z.number().int().nonnegative(),
    changes: z.array(ChangeSchema),
  })
  .strict()
export type DifftasticSide = z.infer<typeof SideSchema>

const RowSchema = z
  .object({
    lhs: SideSchema.optional(),
    rhs: SideSchema.optional(),
  })
  .strict()
  .refine((row) => row.lhs !== undefined || row.rhs !== undefined)
export type DifftasticRow = z.infer<typeof RowSchema>

const DifftasticFileSchema = z
  .object({
    aligned_lines: z
      .array(
        z.tuple([
          z.number().int().nonnegative().nullable(),
          z.number().int().nonnegative().nullable(),
        ]),
      )
      .optional(),
    chunks: z.array(z.array(RowSchema)).optional(),
    language: z.string(),
    path: z.string(),
    status: z.enum(["changed", "created", "deleted", "unchanged"]),
  })
  .strict()

export type DifftasticFile = z.infer<typeof DifftasticFileSchema>

/** Parse unstable upstream JSON at the worker boundary, never in downstream consumers. */
export function parseDifftasticJson(json: string): DifftasticFile {
  const parsed: unknown = JSON.parse(json)
  return DifftasticFileSchema.parse(parsed)
}
