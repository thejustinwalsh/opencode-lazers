import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
export const RETENTION_PRESET_DAYS = [7, 14, 30, 60, 90] as const
export const MAX_RETENTION_DAYS = 3650

const Days = z.int().min(1).max(MAX_RETENTION_DAYS)
const Kind = z.strictObject({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  rows: z.number(),
  bytes: z.number(),
})
const Worktree = z.strictObject({
  path: z.string(),
  bytes: z.number().nullable(),
  action: z.enum(["remove", "keep"]),
  reason: z.string(),
})
const Removed = z.record(z.string(), z.strictObject({ rows: z.number(), bytes: z.number() }))
const Run = z.strictObject({
  id: z.number(),
  at: z.number(),
  days: z.number(),
  trigger: z.enum(["manual", "auto"]),
  done: z.boolean(),
  removed: Removed,
  worktrees: z.array(z.strictObject({ path: z.string(), bytes: z.number().nullable() })),
})

const StatusOutput = z.strictObject({
  fileBytes: z.number(),
  freeBytes: z.number(),
  presets: z.array(z.strictObject({ days: z.number(), rows: z.number(), bytes: z.number() })),
  superseded: z.strictObject({ rows: z.number(), bytes: z.number() }),
  autoDays: Days.nullable(),
  lastRun: Run.nullable(),
})
const PreviewOutput = z.strictObject({
  days: z.number(),
  asOf: z.number(),
  cutoff: z.number(),
  kinds: z.array(Kind),
  rows: z.number(),
  bytes: z.number(),
  plans: z.strictObject({ retired: z.number(), kept: z.number() }),
  protected: z.array(z.strictObject({ reason: z.string(), count: z.number(), noun: z.string() })),
  worktrees: z.array(Worktree),
  worktreeBytes: z.number(),
})
const SliceOutput = z.strictObject({
  runID: z.number(),
  asOf: z.number(),
  done: z.boolean(),
  removed: Removed,
  rows: z.number(),
  bytes: z.number(),
  worktrees: z.array(z.strictObject({ path: z.string(), bytes: z.number().nullable() })),
  fileBytes: z.number(),
  freeBytes: z.number(),
})
export type RetentionStatusView = z.infer<typeof StatusOutput>
export type RetentionPreviewView = z.infer<typeof PreviewOutput>
export type RetentionSliceView = z.infer<typeof SliceOutput>

/**
 * Retention of recorded detail of finished work. `preview` is the dry run; `retire` performs one
 * time-boxed slice and is called again with its `runID` until `done`.
 * Call: `client.rpc(Retention).preview({ days: 30 }, { location: { directory } })`.
 */
export const Retention = Rpc.define({
  id: "lz.retention",
  events: {},
  methods: {
    status: { input: z.strictObject({}), output: StatusOutput },
    preview: {
      input: z.strictObject({ days: Days, asOf: z.number().optional() }),
      output: PreviewOutput,
    },
    retire: {
      input: z.strictObject({
        days: Days,
        asOf: z.number().optional(),
        runID: z.number().optional(),
        /** The caller showed the preview and the user confirmed that this cannot be undone. */
        confirmed: z.literal(true),
      }),
      output: SliceOutput,
    },
    setAuto: {
      input: z.strictObject({ days: Days.nullable() }),
      output: z.strictObject({ autoDays: Days.nullable() }),
    },
  },
})
