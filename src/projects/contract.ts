import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ProjectRef } from "./scope.ts"
import { GlobalSettingsView, ProjectSettingsView } from "./setting-schemas.ts"

const Scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), key: z.string().min(1) }),
])
type Pause = { reason: string; by: string; at: number }
const ProofView = z.strictObject({
  key: z.string(),
  command: z.string(),
  effectiveCommand: z.string().optional(),
  outcome: z.enum(["proven", "failed", "not-run"]),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  reason: z.string().optional(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  toolVersion: z.string().optional(),
  ranAt: z.number(),
})
const MapPreviewView = z.strictObject({
  files: z.number(),
  names: z.number(),
  tokens: z.number(),
  largestFolders: z.array(z.strictObject({ folder: z.string(), files: z.number() })),
  currentFiles: z.number(),
  currentTokens: z.number(),
})
const ProfileChangeView = z.strictObject({
  field: z.enum([
    "toolchains",
    "verify",
    "fix",
    "install",
    "env",
    "audit",
    "source.include",
    "source.exclude",
  ]),
  kind: z.enum(["added", "removed", "changed"]),
  key: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
})
/** A refused write is data, so the form can show it beside the field and keep the old value. */
const Refusal = z.enum([
  "PROJECT_CODE_INVALID",
  "PROJECT_CODE_TAKEN",
  "PROJECT_MISSING",
  "SETTING_INVALID",
  "PROFILE_INVALID",
  "PROJECT_NOT_LOADED",
])
const Outcome = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), refusal: Refusal, message: z.string() }),
])

const NeedsYouItem = z.strictObject({
  project: ProjectRef,
  kind: z.enum(["owner-hold", "recovery-bundle", "architect-question", "project-setup"]),
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
  /** False when this checkout's task list is not indexed yet, so no owner hold is listed. */
  holdsRead: z.boolean().optional(),
  nextCursor: z.string().nullable(),
})

/** A profile that was proved and made active, or a refusal. */
const ProfileOutcome = z.union([
  z.strictObject({
    ok: z.literal(true),
    revision: z.int(),
    proofs: z.array(ProofView),
    mapPreview: MapPreviewView,
    changes: z.array(ProfileChangeView),
  }),
  z.strictObject({ ok: z.literal(false), refusal: Refusal, message: z.string() }),
])

/** The state of a project's profile as the notice needs it, or a refusal. */
const SetupStatus = z.union([
  z.strictObject({
    ok: z.literal(true),
    key: z.string(),
    code: z.string(),
    state: z.enum(["none", "active"]),
    dismissed: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), refusal: Refusal, message: z.string() }),
])
const SetupStarted = z.union([
  z.strictObject({ ok: z.literal(true), sessionID: z.string() }),
  z.strictObject({ ok: z.literal(false), refusal: Refusal, message: z.string() }),
])
export type SetupStatusView = z.infer<typeof SetupStatus>
export type SetupStartedView = z.infer<typeof SetupStarted>
/** One project's profile revisions: the server-side view the Architect's profile tool reads. */
export type ProfileView = {
  key: string
  active?: ProfileRevisionView
  /** Earlier revisions, newest first, so a change can be seen and set again. */
  history: ProfileRevisionView[]
  /** A stored repository-map source filter of one of its checkouts, kept until a profile is active. */
  legacySource?: { include: string[]; exclude: string[] }
  setupDismissedAt: number | null
}
/** A profile revision. `profile` is the stored profile JSON (`ProjectProfileSchema`'s document). */
export type ProfileRevisionView = {
  revision: number
  state: "active" | "superseded"
  profile: unknown
  author: { kind: "architect" | "owner"; sessionID?: string }
  reason: string
  createdAt: number
  /** When a later revision superseded this one. */
  supersededAt?: number
  proofs: z.infer<typeof ProofView>[]
  mapPreview?: z.infer<typeof MapPreviewView>
  /** Names in `profile.env` that look like credentials. */
  credentialLikeEnv: string[]
}
export type ProfileOutcomeView = z.infer<typeof ProfileOutcome>
/** What the Projects section shows: the `projects.list` and `projects.global` rows as views. */
export type ProjectsListing = {
  projects: ProjectView[]
  globalPause: Pause | null
  globalSettings: z.infer<typeof GlobalSettingsView>
}
/** A project as the Projects section shows it (a `projects.list` row, `overview-view.ts`). */
export type ProjectView = {
  key: string
  code: string
  name: string
  checkouts: string[]
  /** A live OpenCode location of this project exists in the serving process. */
  loaded: boolean
  /** Present only while the project's own pause is set. */
  pause: Pause | null
  /** Present only while Architect contact is paused for the project (read-only here). */
  architectContact: { reason: string } | null
  settings: z.infer<typeof ProjectSettingsView>
  /** `revision` is the active profile revision, if any. */
  profile: { state: "none" | "active"; revision?: number }
}
export type ProjectsOutcome = z.infer<typeof Outcome>
export type ProjectScope = z.infer<typeof Scope>

/**
 * Owner controls for the project registry: codes, dispatch pause and per-project limits. The
 * section reads the stored rows through the `projects.list` and `projects.global` streams.
 */
export const Projects = Rpc.define({
  id: "lz.projects",
  events: {},
  methods: {
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
    /**
     * The owner's edit: validates the profile JSON, proves each command once in a native worktree
     * (this can take minutes) and saves the result as the new active revision at once.
     */
    saveProfile: {
      input: z.strictObject({
        key: z.string().min(1),
        profile: z.unknown(),
        reason: z.string().min(1).max(2000),
        proofTargets: z.record(z.string(), z.array(z.string())).optional(),
      }),
      output: ProfileOutcome,
    },
    /** The profile state of the calling session's own project, for the setup notice. */
    setupStatus: {
      input: z.strictObject({ sessionID: z.string().min(1).max(200) }),
      output: SetupStatus,
    },
    /** Opens a prompted setup Architect session in the calling session's project; clears a dismissal. */
    startSetup: {
      input: z.strictObject({ sessionID: z.string().min(1).max(200) }),
      output: SetupStarted,
    },
    dismissSetup: { input: z.strictObject({ key: z.string().min(1) }), output: Outcome },
    resumeSetupNotice: { input: z.strictObject({ key: z.string().min(1) }), output: Outcome },
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
