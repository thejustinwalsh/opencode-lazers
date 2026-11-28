import { z } from "zod"

export const DIFFTASTIC_VERSION = "0.71.0"

const RepoPathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/)

export const StructuralCompareRequestSchema = z
  .object({
    path: RepoPathSchema,
    previousPath: RepoPathSchema.optional(),
    /** null represents a file absent at that revision; an empty string is an existing empty file. */
    base: z.string().nullable(),
    /** null represents a file absent at that revision; an empty string is an existing empty file. */
    head: z.string().nullable(),
    binary: z.boolean().default(false),
    limits: z
      .object({
        byteLimit: z.number().int().nonnegative().default(1_000_000),
        graphLimit: z.number().int().nonnegative().default(3_000_000),
        parseErrorLimit: z.number().int().nonnegative().default(0),
      })
      .strict()
      .default({ byteLimit: 1_000_000, graphLimit: 3_000_000, parseErrorLimit: 0 }),
  })
  .strict()

export type StructuralCompareRequest = z.input<typeof StructuralCompareRequestSchema>
export type ValidStructuralCompareRequest = z.output<typeof StructuralCompareRequestSchema>
export const StructuralDiffIdentitySchema = z
  .object({
    /** Stable task/comparison key; a newer source for this key replaces an older run. */
    comparisonID: z.string().min(1),
    /** Opaque immutable source revision key supplied by the review producer. */
    sourceID: z.string().min(1),
  })
  .strict()
export type StructuralDiffIdentity = z.infer<typeof StructuralDiffIdentitySchema>

export const StructuralDegradedReasonSchema = z.enum([
  "parse-error",
  "byte-limit",
  "graph-limit",
  "timeout",
  "unsupported-language",
  "binary",
  "analysis-failure",
])
export type StructuralDegradedReason = z.infer<typeof StructuralDegradedReasonSchema>

const TokenSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    highlight: z.enum([
      "comment",
      "delimiter",
      "keyword",
      "normal",
      "string",
      "type",
      "parse-error",
    ]),
  })
  .strict()
  .refine((token) => token.end > token.start)
export type DiffToken = z.infer<typeof TokenSchema>

const DiffRowSideSchema = z
  .object({
    line: z.number().int().positive(),
    tokens: z.array(TokenSchema),
  })
  .strict()
export type DiffRowSide = z.infer<typeof DiffRowSideSchema>

const DiffRowSchema = z
  .object({
    base: DiffRowSideSchema.optional(),
    head: DiffRowSideSchema.optional(),
  })
  .strict()
  .refine((row) => row.base !== undefined || row.head !== undefined)
export type DiffRow = z.infer<typeof DiffRowSchema>

const LineIndexSchema = z.number().int().positive().nullable()

export const StructuralDiffSchema = z
  .object({
    path: RepoPathSchema,
    previousPath: RepoPathSchema.optional(),
    engineVersion: z.literal(DIFFTASTIC_VERSION),
    status: z.enum(["changed", "created", "deleted", "unchanged"]),
    language: z.string(),
    engine: z.enum(["difftastic", "line"]),
    degraded: StructuralDegradedReasonSchema.optional(),
    alignedLines: z.array(z.tuple([LineIndexSchema, LineIndexSchema])),
    hunks: z.array(z.array(DiffRowSchema)),
    comments: z
      .array(
        z
          .tuple([
            z.number().int().positive(),
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
          ])
          .refine(([, start, end]) => end > start),
      )
      .optional(),
  })
  .strict()

export type StructuralDiff = z.infer<typeof StructuralDiffSchema>

export const StructuralComparisonInputSchema = z
  .object({
    identity: StructuralDiffIdentitySchema,
    request: StructuralCompareRequestSchema,
  })
  .strict()
export type StructuralComparisonInput = z.input<typeof StructuralComparisonInputSchema>

export const StructuralComparisonResultSchema = z
  .object({
    identity: StructuralDiffIdentitySchema,
    diff: StructuralDiffSchema,
  })
  .strict()
export type StructuralComparisonResult = z.infer<typeof StructuralComparisonResultSchema>
