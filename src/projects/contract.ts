import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ProjectRef } from "./scope.ts"
import { GlobalSettingsView, ProjectSettingsView } from "./setting-schemas.ts"

const Scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), key: z.string().min(1) }),
])
const Pause = z.strictObject({ reason: z.string(), by: z.string(), at: z.number() })
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
/** `profile` is the stored profile JSON, the one document `ProjectProfileSchema` validates. */
const RevisionView = z.strictObject({
  revision: z.int(),
  state: z.enum(["proposed", "confirmed", "discarded"]),
  profile: z.unknown(),
  author: z.strictObject({
    kind: z.enum(["architect", "owner"]),
    sessionID: z.string().optional(),
  }),
  reason: z.string(),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
  proofs: z.array(ProofView),
  mapPreview: MapPreviewView.optional(),
  /** Names in `profile.env` that look like credentials. */
  credentialLikeEnv: z.array(z.string()),
})
const ProfileView = z.strictObject({
  key: z.string(),
  active: RevisionView.optional(),
  pending: RevisionView.extend({ changes: z.array(ProfileChangeView) }).optional(),
  /** A stored repository-map source filter of one of its checkouts, kept until a profile is confirmed. */
  legacySource: z
    .strictObject({ include: z.array(z.string()), exclude: z.array(z.string()) })
    .optional(),
  setupDismissedAt: z.number().nullable(),
})
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
  /** `pending` while a proposal waits for the owner; `revision` is the active one, if any. */
  profile: z.strictObject({
    state: z.enum(["none", "pending", "active"]),
    revision: z.int().optional(),
    pendingRevision: z.int().optional(),
  }),
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
  "PROFILE_INVALID",
  "PROFILE_REVISION_NOT_PENDING",
  "PROJECT_NOT_LOADED",
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

/** A proposal that was proved and stored, or a refusal. */
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

export type ProfileView = z.infer<typeof ProfileView>
export type ProfileRevisionView = z.infer<typeof RevisionView>
export type ProfileOutcomeView = z.infer<typeof ProfileOutcome>
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
    profile: { input: z.strictObject({ key: z.string().min(1) }), output: ProfileView },
    /**
     * The owner's edit: validates the profile JSON, proves each command once in a native worktree
     * (this can take minutes) and stores the result as a pending revision. Confirm it to use it.
     */
    proposeProfile: {
      input: z.strictObject({
        key: z.string().min(1),
        profile: z.unknown(),
        reason: z.string().min(1).max(2000),
        proofTargets: z.record(z.string(), z.array(z.string())).optional(),
      }),
      output: ProfileOutcome,
    },
    confirmProfile: {
      input: z.strictObject({ key: z.string().min(1), revision: z.int().min(1) }),
      output: Outcome,
    },
    discardProfile: {
      input: z.strictObject({ key: z.string().min(1), revision: z.int().min(1) }),
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
