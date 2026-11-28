import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { TaskReferenceSchema } from "../../task.ts"
import { encodeProjectID } from "../../tasks/links.ts"
import { CodeReviewSourceIdentitySchema } from "../contract.ts"

export const CodeReviewRangeSchema = z
  .strictObject({
    startLine: z.int().positive(),
    endLine: z.int().positive(),
    startCol: z.int().nonnegative(),
    endCol: z.int().nonnegative(),
  })
  .refine(
    (range) =>
      range.endLine > range.startLine ||
      (range.endLine === range.startLine && range.endCol > range.startCol),
  )
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewRange = z.infer<typeof CodeReviewRangeSchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewSymbolIdentitySchema = z.strictObject({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(512),
  kind: z.string().min(1).max(128),
  startLine: z.int().positive(),
  endLine: z.int().positive(),
})
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewSymbolIdentity = z.infer<typeof CodeReviewSymbolIdentitySchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewAnchorSchema = z.strictObject({
  id: z.string().uuid(),
  source: CodeReviewSourceIdentitySchema,
  range: CodeReviewRangeSchema,
  excerpt: z.string().max(2_000_000),
  symbol: CodeReviewSymbolIdentitySchema.optional(),
  createdAt: z.int().nonnegative(),
})
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewAnchor = z.infer<typeof CodeReviewAnchorSchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewThreadSchema = z.strictObject({
  id: z.string().uuid(),
  projectID: z.string().min(1).max(256),
  taskID: z.string().uuid(),
  anchor: CodeReviewAnchorSchema,
  state: z.enum(["open", "resolved"]),
  revision: z.int().positive(),
  correctionTaskID: z.string().uuid().nullable(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
})
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewThread = z.infer<typeof CodeReviewThreadSchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewCommentSchema = z.strictObject({
  id: z.string().uuid(),
  threadID: z.string().uuid(),
  body: z.string().min(1).max(100_000),
  authorSessionID: z.string().min(1).max(256),
  createdAt: z.int().nonnegative(),
})
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewComment = z.infer<typeof CodeReviewCommentSchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewReferenceSchema = z
  .strictObject({
    kind: z.literal("code-review"),
    threadID: z.string().uuid(),
    comparisonID: z.string().regex(/^[0-9a-f]{64}$/),
    source: CodeReviewSourceIdentitySchema,
    range: CodeReviewRangeSchema,
    taskReference: TaskReferenceSchema,
    href: z.string().min(1).max(2048),
    label: z.string().min(1).max(512),
  })
  .superRefine((reference, ctx) => {
    if (reference.comparisonID !== reference.source.comparisonID)
      ctx.addIssue({
        code: "custom",
        path: ["comparisonID"],
        message: "Review reference comparison must match its pinned source",
      })
    const expectedHref = `.lazers/tasks/${encodeProjectID(reference.source.projectID)}/${reference.taskReference}?review=${reference.threadID}&comparison=${reference.comparisonID}`
    if (reference.href !== expectedHref)
      ctx.addIssue({
        code: "custom",
        path: ["href"],
        message: "Review reference href must use its issued task route",
      })
  })
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewReference = z.infer<typeof CodeReviewReferenceSchema>

const CodeReviewArchitectSessionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), sessionID: z.string().min(1).max(256) }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["no-architect", "session-unavailable"]),
  }),
])

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewDraftSchema = z.strictObject({
  session: CodeReviewArchitectSessionSchema,
  reference: CodeReviewReferenceSchema,
  quote: z.string().max(2_000_000),
  note: z.string().min(1).max(10_000),
})
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewDraft = z.infer<typeof CodeReviewDraftSchema>

// fallow-ignore-next-line unused-export -- consumed by LZ-286
export const CodeReviewAnchorLocationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("located"),
    source: CodeReviewSourceIdentitySchema,
    range: CodeReviewRangeSchema,
  }),
  z.strictObject({ status: z.literal("outdated") }),
  z.strictObject({ status: z.literal("ambiguous") }),
  z.strictObject({ status: z.literal("unavailable") }),
])
// fallow-ignore-next-line unused-type -- consumed by LZ-286
export type CodeReviewAnchorLocation = z.infer<typeof CodeReviewAnchorLocationSchema>

const CodeReviewNavigationSchema = z.strictObject({
  threadID: z.string().uuid(),
  correctionTaskID: z.string().uuid().nullable(),
  updatedAt: z.int().nonnegative(),
})

const CodeReviewThreadUpdateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("updated"), thread: CodeReviewThreadSchema }),
  z.strictObject({ status: z.literal("conflict"), current: CodeReviewThreadSchema }),
])

export const CodeReviewDiscussions = Rpc.define({
  id: "lazers.codeReviewDiscussions",
  events: {},
  methods: {
    createThread: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        source: CodeReviewSourceIdentitySchema,
        range: CodeReviewRangeSchema,
        comment: z.string().min(1).max(100_000).optional(),
        requestID: z.string().min(1).max(256),
      }),
      output: CodeReviewThreadSchema,
    },
    getThread: {
      input: z.strictObject({ sessionID: z.string().min(1).max(256), threadID: z.string().uuid() }),
      output: CodeReviewThreadSchema,
    },
    appendComment: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        threadID: z.string().uuid(),
        body: z.string().min(1).max(100_000),
        requestID: z.string().min(1).max(256),
      }),
      output: CodeReviewCommentSchema,
    },
    setThreadState: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        threadID: z.string().uuid(),
        state: z.enum(["open", "resolved"]),
        expectedRevision: z.int().positive(),
        requestID: z.string().min(1).max(256),
      }),
      output: CodeReviewThreadUpdateSchema,
    },
    prepareDraft: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        threadID: z.string().uuid(),
        intent: z.enum(["ask", "request-fix"]),
      }),
      output: CodeReviewDraftSchema,
    },
    locateThread: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        threadID: z.string().uuid(),
        targetComparisonID: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      output: CodeReviewAnchorLocationSchema,
    },
    linkCorrection: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        threadID: z.string().uuid(),
        correctionTaskID: z.string().uuid(),
        requestID: z.string().min(1).max(256),
      }),
      output: CodeReviewNavigationSchema,
    },
  },
})
