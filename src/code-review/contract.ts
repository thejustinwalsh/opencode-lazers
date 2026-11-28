import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const CODE_REVIEW_CONTRACT_VERSION = 1

export type CodeReviewMode = "task" | "attempt" | "since" | "live" | "plan"
const CODE_REVIEW_MODES = [
  "task",
  "attempt",
  "since",
  "live",
  "plan",
] as const satisfies readonly CodeReviewMode[]
const CodeReviewModeSchema = z.enum(CODE_REVIEW_MODES)

const CodeReviewSideSchema = z.enum(["base", "head", "staged", "unstaged", "untracked"])
export type CodeReviewSide = z.infer<typeof CodeReviewSideSchema>

const Revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/)
const RelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Source paths must be normalized project-relative paths",
  )

export const CodeReviewSourceIdentitySchema = z.strictObject({
  version: z.literal(CODE_REVIEW_CONTRACT_VERSION),
  projectID: z.string().min(1).max(256),
  taskID: z.uuid(),
  planID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  comparisonID: z.string().regex(/^[0-9a-f]{64}$/),
  mode: CodeReviewModeSchema,
  side: CodeReviewSideSchema,
  path: RelativePath,
  revision: Revision,
})
export type CodeReviewSourceIdentity = z.infer<typeof CodeReviewSourceIdentitySchema>

const CodeReviewHunkSchema = z.strictObject({
  baseStart: z.int().nonnegative(),
  baseEnd: z.int().nonnegative(),
  headStart: z.int().nonnegative(),
  headEnd: z.int().nonnegative(),
})
export type CodeReviewHunk = z.infer<typeof CodeReviewHunkSchema>

const CodeReviewFileStatusSchema = z.enum([
  "unchanged",
  "added",
  "deleted",
  "modified",
  "conflicted",
])
export type CodeReviewFileStatus = z.infer<typeof CodeReviewFileStatusSchema>

const CodeReviewFileKindSchema = z.enum([
  "text",
  "binary",
  "symlink",
  "submodule",
  "absent",
  "unknown",
])
export type CodeReviewFileKind = z.infer<typeof CodeReviewFileKindSchema>

const CodeReviewAttributionSchema = z.enum([
  "committed",
  "assigned-workspace",
  "shared-workspace-unowned",
])

const CodeReviewComparisonIdentitySchema = z.strictObject({
  version: z.literal(CODE_REVIEW_CONTRACT_VERSION),
  comparisonID: z.string().regex(/^[0-9a-f]{64}$/),
  projectID: z.string().min(1).max(256),
  taskID: z.uuid(),
  planID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  mode: CodeReviewModeSchema,
  baseRevision: Revision.nullable(),
  headRevision: Revision.nullable(),
  snapshotID: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  capturedAt: z.int().nonnegative().nullable(),
  attribution: CodeReviewAttributionSchema,
})
export type CodeReviewComparisonIdentity = z.infer<typeof CodeReviewComparisonIdentitySchema>

export const CodeReviewComparisonSchema = z.strictObject({
  identity: CodeReviewComparisonIdentitySchema,
  available: z.boolean(),
  unavailableReason: z.string().max(1000).nullable(),
  fileCount: z.int().nonnegative(),
  changedCount: z.int().nonnegative(),
  sides: z.array(CodeReviewSideSchema),
  sourceName: z.literal("codeReview.files"),
  taskReference: z.string().max(64),
  taskTitle: z.string().max(120),
  planContext: z
    .strictObject({
      taskIDs: z.array(z.uuid()),
      dependencies: z.array(z.strictObject({ prerequisite: z.uuid(), successor: z.uuid() })),
      taskFiles: z.record(z.string(), z.array(z.string())),
    })
    .nullable(),
})
export type CodeReviewComparison = z.infer<typeof CodeReviewComparisonSchema>

export const CodeReviewResolveInputSchema = z
  .strictObject({
    sessionID: z.string().min(1).max(256),
    taskID: z.uuid(),
    mode: CodeReviewModeSchema,
    planID: z.uuid().optional(),
    attemptID: z.uuid().optional(),
    baseAttemptID: z.uuid().optional(),
    headAttemptID: z.uuid().optional(),
  })
  .superRefine((input, ctx) => {
    const require = (condition: boolean, field: string) => {
      if (!condition)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for ${input.mode} comparisons`,
        })
    }
    if (input.mode === "attempt") require(input.attemptID !== undefined, "attemptID")
    if (input.mode === "since") {
      require(input.baseAttemptID !== undefined, "baseAttemptID")
      require(input.headAttemptID !== undefined, "headAttemptID")
    }
    if (input.mode === "plan") require(input.planID !== undefined, "planID")
  })
export type CodeReviewResolveInput = Omit<z.infer<typeof CodeReviewResolveInputSchema>, "mode"> & {
  mode: CodeReviewMode
}

const CodeReviewHistoryCursorSchema = z.strictObject({
  startedAt: z.int().nonnegative(),
  attemptNumber: z.int().positive(),
  attemptID: z.uuid(),
})

export const CodeReviewHistoryInputSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  taskID: z.uuid(),
  limit: z.int().min(1).max(200).optional(),
  cursor: CodeReviewHistoryCursorSchema.optional(),
})
export type CodeReviewHistoryInput = z.infer<typeof CodeReviewHistoryInputSchema>

const CodeReviewHistorySchema = z.strictObject({
  taskID: z.uuid(),
  revisions: z.array(
    z.strictObject({
      planID: z.uuid(),
      attemptID: z.uuid(),
      attemptNumber: z.int().positive(),
      state: z.string().min(1),
      baseRevision: Revision,
      artifactRevision: Revision.nullable(),
      startedAt: z.int().nonnegative(),
    }),
  ),
  nextCursor: CodeReviewHistoryCursorSchema.nullable(),
})
export type CodeReviewHistory = z.infer<typeof CodeReviewHistorySchema>

export const CodeReviewSourceShapeInputSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  source: CodeReviewSourceIdentitySchema,
})
export type CodeReviewSourceShapeInput = z.infer<typeof CodeReviewSourceShapeInputSchema>

const CodeReviewSourceShapeSchema = z.strictObject({
  source: CodeReviewSourceIdentitySchema,
  exists: z.boolean(),
  kind: CodeReviewFileKindSchema,
  size: z.int().nonnegative().nullable(),
  lineCount: z.int().nonnegative().nullable(),
  status: CodeReviewFileStatusSchema,
  changed: z.boolean(),
  hunks: z.array(CodeReviewHunkSchema),
  attributionTaskIDs: z.array(z.uuid()),
})
export type CodeReviewSourceShape = z.infer<typeof CodeReviewSourceShapeSchema>

export const CodeReviewSourceWindowInputSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  source: CodeReviewSourceIdentitySchema,
  startLine: z.int().positive(),
  endLine: z.int().positive(),
})

const CodeReviewSourceWindowSchema = z.strictObject({
  source: CodeReviewSourceIdentitySchema,
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  lineCount: z.int().nonnegative(),
  text: z.string(),
})
export type CodeReviewSourceWindow = z.infer<typeof CodeReviewSourceWindowSchema>
export type CodeReviewSourceWindowInput = z.infer<typeof CodeReviewSourceWindowInputSchema>

export const CodeReview = Rpc.define({
  id: "lazers.codeReview",
  events: {},
  methods: {
    resolve: {
      input: CodeReviewResolveInputSchema,
      output: CodeReviewComparisonSchema,
    },
    history: {
      input: CodeReviewHistoryInputSchema,
      output: CodeReviewHistorySchema,
    },
    shape: {
      input: CodeReviewSourceShapeInputSchema,
      output: CodeReviewSourceShapeSchema,
    },
    source: {
      input: CodeReviewSourceWindowInputSchema,
      output: CodeReviewSourceWindowSchema,
    },
  },
})
