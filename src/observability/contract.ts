import { Rpc } from "@opencode/plugin/rpc"
import { ProjectRef } from "../projects/scope.ts"
import { z } from "zod"

const ObservationScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project"), sessionID: z.string().min(1).max(200) }),
  /** Every project the caller may read, a page per checkout. `sessionID` is the caller. */
  z.strictObject({ kind: z.literal("all"), sessionID: z.string().min(1).max(200) }),
])

/** The all-projects additions every output carries: the page's project and the next cursor. */
const AllPage = {
  project: ProjectRef.optional(),
  nextCursor: z.string().nullable().optional(),
}
const PageCursor = z.string().min(1).max(2048).optional()
/** A cursor pages the all-projects scope; it means nothing in the others. */
function cursorOnlyForAll(
  input: { scope: { kind: string }; cursor?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (input.cursor && input.scope.kind !== "all")
    ctx.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "A cursor applies to the all-projects scope only",
    })
}

const ProgressDiagnosticsInput = z
  .strictObject({ scope: ObservationScope, cursor: PageCursor })
  .superRefine(cursorOnlyForAll)
const ProcessSchedulerTotals = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    scope: z.literal("process"),
    audience: z.literal("architect-only"),
    source: z.literal("sharedScheduler.snapshot"),
    implementation: z.literal("scheduler/v2"),
    generation: z.uuid(),
    timerCount: z.int().nonnegative(),
    groups: z.int().nonnegative(),
    participants: z.int().nonnegative(),
    running: z.int().nonnegative(),
    runs: z.int().nonnegative(),
    errors: z.int().nonnegative(),
    wakeups: z.int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("architect-only") }),
])
const ProgressDiagnosticsOutput = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.union([
    z.strictObject({ kind: z.literal("project") }),
    z.strictObject({ kind: z.literal("all") }),
  ]),
  ...AllPage,
  observedAt: z.number().finite(),
  implementationID: z.string().min(1).max(80),
  moduleGenerationID: z.uuid(),
  state: z.enum(["absent", "uninitialized", "initialized", "instrumentation-unavailable"]),
  coverage: z.enum(["not-started", "complete", "partial"]),
  coordinator: z.strictObject({
    participantCount: z.int().nonnegative(),
    participantGenerations: z
      .array(
        z.strictObject({
          generationID: z.uuid().nullable(),
          participantCount: z.int().positive(),
        }),
      )
      .max(32),
    participantGenerationsTruncated: z.boolean(),
    locationCount: z.int().nonnegative(),
    locationParticipantCounts: z.array(z.int().positive()).max(32),
    unknownLocationParticipantCount: z.int().nonnegative(),
    locationsTruncated: z.boolean(),
    assignments: z.strictObject({
      baselineCaptured: z.boolean(),
      cachedCount: z.int().nonnegative(),
      activeCount: z.int().nonnegative(),
      terminalCount: z.int().nonnegative(),
      asOf: z.number().finite().nullable(),
    }),
    work: z.strictObject({
      queuedCount: z.int().nonnegative(),
      delayedCount: z.int().nonnegative(),
      dirtyCount: z.int().nonnegative(),
      drainOwned: z.boolean(),
      reconstructionActive: z.boolean(),
      timerScheduled: z.boolean(),
      outstandingRetiredReads: z.int().nonnegative(),
    }),
    nativeReads: z
      .strictObject({
        startedAt: z.number().finite(),
        get: z.strictObject({
          invocations: z.int().nonnegative(),
          succeeded: z.int().nonnegative(),
          failed: z.int().nonnegative(),
          pending: z.int().nonnegative(),
        }),
        context: z.strictObject({
          invocations: z.int().nonnegative(),
          succeeded: z.int().nonnegative(),
          failed: z.int().nonnegative(),
          pending: z.int().nonnegative(),
        }),
      })
      .nullable(),
  }),
  processSchedulerTotals: ProcessSchedulerTotals,
})

export const Observability = Rpc.define({
  id: "lazers.observability",
  methods: {
    progressDiagnostics: {
      input: ProgressDiagnosticsInput,
      output: ProgressDiagnosticsOutput,
    },
  },
  events: {},
})

export type ObservationScope = z.infer<typeof ObservationScope>
