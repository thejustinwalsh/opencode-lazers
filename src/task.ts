import { z } from "zod"
import { TaskClassification } from "./task-classification.ts"
import { REFERENCE_EXACT } from "./projects/code.ts"

const text = z.string().min(1).max(8_000).regex(/\S/, "Must contain non-whitespace text")
/** Reserved for the runtime's own `fallow audit` receipt; authored checks cannot use it. */
export const FALLOW_CHECK_ID = "fallow-audit"
/** The name before the rename. Still reserved, and still recognised on history recorded under it. */
export const LEGACY_FALLOW_CHECK_ID = "lazers-fallow"
export const FALLOW_CHECK_IDS: readonly string[] = [FALLOW_CHECK_ID, LEGACY_FALLOW_CHECK_ID]
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
    writeScope: z
      .array(writePath)
      .max(100)
      .describe(
        "Existing files the worker may modify (the edit scope). Use exact file paths or Bun glob patterns. For a directory and its subtree, use dir/**; dir alone does not include its files. Prefer a module folder (dir/**) over one large file when the work is local to the module.",
      ),
    createScope: z
      .array(
        z.strictObject({
          path: writePath.describe(
            "A new file, or a folder ending in / for new files. Describes where new code belongs; creating it is expected, creating elsewhere is not forbidden.",
          ),
          purpose: text.describe("One short line: what belongs there."),
        }),
      )
      .max(50)
      .optional()
      .describe(
        "The expected structure: new files or folders the worker should create, each with its purpose. Additive only; new files beside edit-scoped files are allowed without listing them.",
      ),
    protectedScope: z
      .array(writePath)
      .max(100)
      .optional()
      .describe(
        "Exact paths or Bun glob patterns the worker must not touch. The only hard boundary: a change here holds the task until the Architect decides.",
      ),
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
              ]),
            )
            .max(20)
            .describe(
              "Mechanical evidence (a verification or an artifact). An assertion with no evidence is judged by the Architect's review and integrate decision.",
            ),
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
            "Executable verification. Run available formatter/linter automatic fixes before remaining checks; for LAZERS use bun run verify plus relevant tests. The runtime adds a 120 s per-test hang guard (`bun test --timeout 120000`) to a bun test command without its own --timeout.",
          ),
          timeoutMs: z
            .int()
            .positive()
            .optional()
            .describe(
              "Optional historical single wall-clock limit. Preserved on legacy tasks and receipts; current execution uses inactivityTimeoutMs and hardTimeoutMs or the project defaults.",
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
      if (FALLOW_CHECK_IDS.includes(item.id))
        ctx.addIssue({
          code: "custom",
          path: ["verification", index, "id"],
          message: `Verification ID ${item.id} is reserved for the runtime's Fallow audit`,
        })
      if (
        item.inactivityTimeoutMs !== undefined &&
        item.hardTimeoutMs !== undefined &&
        item.inactivityTimeoutMs > item.hardTimeoutMs
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
  .max(40)
  .regex(REFERENCE_EXACT)
  .refine((reference) =>
    Number.isSafeInteger(Number(reference.slice(reference.lastIndexOf("-") + 1))),
  )
export const TaskSubmissionSchema = TaskProposalSchema.safeExtend({
  idempotencyKey: IdempotencyKeySchema,
})

const StartingRevisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  z.strictObject({ kind: z.literal("unborn") }),
])

/**
 * Stored tasks may carry retired `kind: "human"` evidence. It is read and
 * dropped; it never gates acceptance.
 */
export function dropLegacyHumanEvidence(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("acceptance" in value)) return value
  const proposal = value as { acceptance?: unknown }
  if (!Array.isArray(proposal.acceptance)) return value
  return {
    ...proposal,
    acceptance: proposal.acceptance.map((assertion: unknown) => {
      if (typeof assertion !== "object" || assertion === null) return assertion
      const record = assertion as { evidence?: unknown }
      return Array.isArray(record.evidence)
        ? {
            ...record,
            evidence: record.evidence.filter(
              (item) =>
                !(
                  typeof item === "object" &&
                  item !== null &&
                  "kind" in item &&
                  item.kind === "human"
                ),
            ),
          }
        : assertion
    }),
  }
}

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
  proposal: z.preprocess(dropLegacyHumanEvidence, TaskProposalSchema),
})

export type TaskProposal = z.infer<typeof TaskProposalSchema>
export type TaskSpec = z.infer<typeof TaskSpecSchema>
