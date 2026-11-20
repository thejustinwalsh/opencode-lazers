import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ProjectRef } from "./scope.ts"
import { GlobalSettingsView, ProjectSettingsView } from "./setting-schemas.ts"

const Scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), key: z.string().min(1) }),
])
const Pause = z.strictObject({ reason: z.string(), by: z.string(), at: z.number() })
const Project = z.strictObject({
  key: z.string(),
  code: z.string(),
  name: z.string(),
  checkouts: z.array(z.string()),
  /** A live OpenCode location of this project exists in the serving process. */
  loaded: z.boolean(),
  /** Present only while the project's own pause is set. */
  pause: Pause.nullable(),
  /** Present only while Architect contact is paused for the project (read-only here). */
  architectContact: z.strictObject({ reason: z.string() }).nullable(),
  settings: ProjectSettingsView,
})
const Listing = z.strictObject({
  projects: z.array(Project),
  globalPause: Pause.nullable(),
  globalSettings: GlobalSettingsView,
})
/** A refused write is data, so the form can show it beside the field and keep the old value. */
const Refusal = z.enum([
  "PROJECT_CODE_INVALID",
  "PROJECT_CODE_TAKEN",
  "PROJECT_MISSING",
  "SETTING_INVALID",
])
const Outcome = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), refusal: Refusal, message: z.string() }),
])

const NeedsYouItem = z.strictObject({
  project: ProjectRef,
  kind: z.enum(["owner-hold", "recovery-bundle", "architect-question"]),
  id: z.string().min(1),
  title: z.string(),
  reference: z.string().optional(),
  reason: z.string().optional(),
  since: z.number().optional(),
  count: z.number().int().nonnegative().optional(),
})
/** One checkout of one readable project per page; `project` is absent when none is readable. */
const NeedsYouPage = z.strictObject({
  project: ProjectRef.optional(),
  items: z.array(NeedsYouItem),
  /** False when native questions of this checkout were not readable, so none are listed. */
  questionsRead: z.boolean().optional(),
  nextCursor: z.string().nullable(),
})

export type NeedsYouPageView = z.infer<typeof NeedsYouPage>
export type ProjectsListing = z.infer<typeof Listing>
export type ProjectView = z.infer<typeof Project>
export type ProjectsOutcome = z.infer<typeof Outcome>
export type ProjectScope = z.infer<typeof Scope>

/**
 * Owner controls for the project registry: codes, dispatch pause and per-project limits.
 * Call: `client.rpc(Projects).list({})`, then re-read after every write.
 */
export const Projects = Rpc.define({
  id: "lz.projects",
  events: {},
  methods: {
    list: { input: z.strictObject({}), output: Listing },
    /**
     * Everything waiting on the owner in the projects the caller may read, a page per checkout.
     * `sessionID` is the calling session; continue with `nextCursor` until it is null.
     */
    needsYou: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(200),
        cursor: z.string().min(1).max(2048).optional(),
      }),
      output: NeedsYouPage,
    },
    setCode: {
      input: z.strictObject({ key: z.string().min(1), code: z.string() }),
      output: Outcome,
    },
    setPause: {
      input: z.strictObject({
        scope: Scope,
        paused: z.boolean(),
        reason: z.string().max(500).optional(),
      }),
      output: Outcome,
    },
    /** `value: null` clears the stored value, so the plugin option or built-in default applies. */
    setSetting: {
      input: z.strictObject({
        scope: Scope,
        name: z.string().min(1),
        value: z.json(),
      }),
      output: Outcome,
    },
  },
})
