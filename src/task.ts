import { z } from "zod"
import { TaskClassification } from "./task-classification.ts"
import {
  DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
  DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
} from "./runner/verification-timeout.ts"

const text = z.string().min(1).max(8_000).regex(/\S/, "Must contain non-whitespace text")
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const texts = z.array(text).max(100)
// Relative paths/globs only. These describe scope; execution must enforce filesystem boundaries.
const writePath = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    // oxlint-disable-next-line no-control-regex -- JSON Schema cannot carry the Unicode flag required by property escapes.
    /^(?![/~!])(?![A-Za-z]:)(?!.*\\)(?!.*[\x00-\x1f\x7f-\x9f])(?!(?:.*\/)?\.{1,2}(?:\/|$)).+$/,
    "Use repository-relative paths/globs without dot segments, backslashes, or negation",
  )

export const TaskSourcePlanSchema = z.strictObject({
  path: writePath.describe("Repository-relative plan document path."),
  section: text
    .optional()
    .describe("Exact heading defining this task; resolved again when opened."),
  line: z
    .int()
    .positive()
    .optional()
    .describe("One-based source line, used when no matching heading is found."),
})

export const TaskProposalSchema = z
  .strictObject({
    sourcePlan: TaskSourcePlanSchema.optional().describe(
      "Originating plan document and section, when this task comes from a written plan. Omit for standalone requests; never invent a plan.",
    ),
    objective: text.describe("The observable change and its purpose, stated directly."),
    // Optional for compatible historical replay and reads. Fresh-key admission
    // requires this explicit, versioned value after checking the replay key.
    classification: TaskClassification.optional(),
    exclusions: texts.describe("Only material work excluded from this increment; may be empty."),
    constraints: texts.describe(
      "Necessary compatibility or design requirements. Do not repeat repository policy or prescribe routine implementation choices.",
    ),
    guidance: text
      .optional()
      .describe(
        "Optional implementation advice grounded in code: reuse points, pitfalls and best practices with source references. Advisory; required outcomes belong in acceptance or constraints.",
      ),
    assumptions: texts,
    writeScope: z.array(writePath).max(100),
    context: z.array(z.strictObject({ reference: text, revision: text.nullable() })).max(100),
    acceptance: z
      .array(
        z.strictObject({
          id: identifier,
          assertion: text.describe(
            "An observable done condition. State behavior, not implementation steps or reporting ceremony.",
          ),
          evidence: z
            .array(
              z.discriminatedUnion("kind", [
                z.strictObject({ kind: z.literal("verification"), verificationID: identifier }),
                z.strictObject({
                  kind: z.literal("artifact"),
                  reference: text.describe(
                    "One workspace-relative file or directory path, used verbatim. Put explanatory prose in the assertion.",
                  ),
                }),
                z.strictObject({
                  kind: z.literal("human"),
                  decision: text.describe(
                    "A decision or authorization explicitly requiring the user. Routine tests, product probes, code review and integration belong to workers/Architect, not a human or external driver.",
                  ),
                }),
              ]),
            )
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(100)
      .describe(
        "Done conditions with evidence links. Cover required behavior without repeating constraints or prescribing the implementation.",
      ),
    requirements: z.strictObject({
      capabilities: texts,
      skills: texts.describe(
        "Optional skill suggestions. Entries may use 'name — one-line description'; name-only legacy strings remain valid and do not become prerequisites.",
      ),
      risk: z.enum(["low", "medium", "high"]),
      policyReference: text
        .optional()
        .describe(
          "Optional legacy policy reference; omit when no task-specific reference is needed.",
        ),
    }),
    verification: z
      .array(
        z.strictObject({
          id: identifier,
          command: text.describe(
            "Executable verification. Run available formatter/linter automatic fixes before remaining checks; for LAZERS use bun run verify plus relevant tests.",
          ),
          timeoutMs: z
            .int()
            .positive()
            .describe(
              "Historical single wall-clock limit. Preserved on legacy tasks and receipts; current execution uses inactivityTimeoutMs and hardTimeoutMs or the project defaults.",
            ),
          inactivityTimeoutMs: z
            .int()
            .positive()
            .optional()
            .describe(
              "Optional per-check inactivity allowance in milliseconds; absent uses the project default of 15 minutes.",
            ),
          hardTimeoutMs: z
            .int()
            .positive()
            .optional()
            .describe(
              "Optional per-check total hard backstop in milliseconds; absent uses the project default of 60 minutes.",
            ),
        }),
      )
      .max(100),
    limits: z
      .strictObject({
        maxTokens: z.int().positive(),
        maxEstimatedCostUsd: z.number().nonnegative(),
        maxElapsedMs: z.int().positive(),
        maxToolCalls: z.int().positive(),
        maxProviderRetries: z.int().nonnegative(),
        maxRepairAttempts: z.int().min(0).max(1),
      })
      .optional()
      .describe(
        "Legacy compatibility metadata. Omit guessed token, cost, time and tool limits; runtime tracks actual usage.",
      ),
  })
  .superRefine((proposal, ctx) => {
    for (const key of ["acceptance", "verification"] as const) {
      const seen = new Set<string>()
      proposal[key].forEach((item, index) => {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            path: [key, index, "id"],
            message: "Duplicate identifier",
          })
        }
        seen.add(item.id)
      })
    }
    proposal.verification.forEach((item, index) => {
      if (
        (item.inactivityTimeoutMs ?? DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS) >
        (item.hardTimeoutMs ?? DEFAULT_VERIFICATION_HARD_TIMEOUT_MS)
      )
        ctx.addIssue({
          code: "custom",
          path: ["verification", index, "inactivityTimeoutMs"],
          message: "Inactivity allowance cannot exceed the total hard backstop",
        })
    })
    const verificationIDs = new Set(proposal.verification.map((item) => item.id))
    proposal.acceptance.forEach((item, index) => {
      item.evidence.forEach((evidence, evidenceIndex) => {
        if (evidence.kind === "verification" && !verificationIDs.has(evidence.verificationID)) {
          ctx.addIssue({
            code: "custom",
            path: ["acceptance", index, "evidence", evidenceIndex, "verificationID"],
            message: "Reference a declared verification ID",
          })
        }
      })
    })
  })

// JSON Schema represents structure. Zod also checks cross-field references at submission time.
export const taskProposalJSONSchema = z.toJSONSchema(TaskProposalSchema, { io: "input" })
// Transport identity only: never trim/normalize or add it to stored proposals.
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/\S/, "Key must contain non-whitespace text")
export const TaskReferenceSchema = z
  .string()
  .max(19)
  .regex(/^LZ-[1-9]\d{0,15}$/)
  .refine((reference) => Number.isSafeInteger(Number(reference.slice(3))))
export const TaskSubmissionSchema = TaskProposalSchema.safeExtend({
  idempotencyKey: IdempotencyKeySchema,
})

export const StartingRevisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  z.strictObject({ kind: z.literal("unborn") }),
])

export const TaskSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  revision: z.literal(1),
  status: z.literal("submitted"),
  createdAt: z.iso.datetime(),
  provenance: z.strictObject({
    projectID: text,
    projectDirectory: text,
    workspaceDirectory: text,
    sessionID: text,
    startingRevision: StartingRevisionSchema,
  }),
  proposal: TaskProposalSchema,
})

export type TaskProposal = z.infer<typeof TaskProposalSchema>
export type TaskSpec = z.infer<typeof TaskSpecSchema>
