import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { CodeReviewComparisonSchema } from "../contract.ts"

export const CodeReviewIntegrationPullRequestSchema = z.strictObject({
  id: z.string().min(1).max(256),
  number: z.int().positive().nullable(),
  url: z.url(),
  title: z.string().max(512).nullable(),
})
export type CodeReviewIntegrationPullRequest = z.infer<
  typeof CodeReviewIntegrationPullRequestSchema
>

export const CodeReviewIntegrationTargetSchema = z.strictObject({
  id: z.string().uuid(),
  projectID: z.string().min(1).max(256),
  taskIDs: z.array(z.string().uuid()),
  branch: z.string().min(1).max(512),
  baseRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  pullRequest: CodeReviewIntegrationPullRequestSchema.nullable(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
})
export type CodeReviewIntegrationTarget = z.infer<typeof CodeReviewIntegrationTargetSchema>

export const CodeReviewIntegrationSchema = z.strictObject({
  id: z.string().uuid(),
  target: CodeReviewIntegrationTargetSchema,
  taskID: z.string().uuid(),
  planID: z.string().uuid().nullable(),
  attemptID: z.string().uuid().nullable(),
  sourceBaseRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  sourceArtifactRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  sourceWorkspaceID: z.string().min(1).max(512),
  targetBeforeRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  targetAfterRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  landedCommits: z.array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  proofID: z.string().min(1).max(512).nullable(),
  lineage: z.enum(["proven", "uncertain"]),
  createdAt: z.int().nonnegative(),
})
export type CodeReviewIntegration = z.infer<typeof CodeReviewIntegrationSchema>

const CodeReviewIntegrationCursorSchema = z.strictObject({
  createdAt: z.int().nonnegative(),
  integrationID: z.string().uuid(),
})

export const CodeReviewIntegrationsListInputSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  taskID: z.string().uuid(),
  limit: z.int().min(1).max(100).optional(),
  cursor: CodeReviewIntegrationCursorSchema.optional(),
})

export const CodeReviewIntegrationsListOutputSchema = z.strictObject({
  integrations: z.array(CodeReviewIntegrationSchema),
  nextCursor: CodeReviewIntegrationCursorSchema.nullable(),
})

export const CodeReviewIntegratedComparisonSchema = z.strictObject({
  comparison: CodeReviewComparisonSchema,
  integration: CodeReviewIntegrationSchema,
})
export type CodeReviewIntegratedComparison = z.infer<typeof CodeReviewIntegratedComparisonSchema>

export const CodeReviewIntegrations = Rpc.define({
  id: "lazers.codeReviewIntegrations",
  events: {},
  methods: {
    list: {
      input: CodeReviewIntegrationsListInputSchema,
      output: CodeReviewIntegrationsListOutputSchema,
    },
    resolve: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(256),
        taskID: z.string().uuid(),
        integrationID: z.string().uuid(),
      }),
      output: CodeReviewIntegratedComparisonSchema,
    },
  },
})
