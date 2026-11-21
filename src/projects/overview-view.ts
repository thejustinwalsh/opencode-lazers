import type { ProfileRevisionView, ProjectsListing, ProjectView } from "./contract.ts"
import { credentialLikeEnv, parseProfile, type ProjectProfile } from "./profile.ts"

/** A `projects.list` or `projects.global` row; stream rows read their fields from the frame. */
type Row = { readonly [column: string]: unknown }

const text = (value: unknown) => (typeof value === "string" ? value : "")
const pauseOf = (row: Row) =>
  row.paused
    ? {
        reason: text(row.pause_reason),
        by: text(row.pause_by),
        at: typeof row.pause_at === "number" ? row.pause_at : 0,
      }
    : null

/** The project as the Projects section shows it: the shape the `list` read returned. */
export function projectViewOf(row: Row): ProjectView {
  const revision = row.profile_revision
  return {
    key: text(row.key),
    code: text(row.code),
    name: text(row.name),
    checkouts: row.checkouts as string[],
    loaded: Boolean(row.loaded),
    pause: pauseOf(row),
    architectContact: row.architect_contact ? { reason: text(row.architect_contact_reason) } : null,
    settings: row.settings as ProjectView["settings"],
    profile:
      row.profile_state === "active" && typeof revision === "number"
        ? { state: "active", revision }
        : { state: "none" },
  }
}

export function globalViewOf(row: Row): Pick<ProjectsListing, "globalPause" | "globalSettings"> {
  return {
    globalPause: pauseOf(row),
    globalSettings: row.settings as ProjectsListing["globalSettings"],
  }
}

type Proof = ProfileRevisionView["proofs"][number]

/** A `projects.proofs` row as the proof the old profile read returned. */
function proofViewOf(row: Row): Proof {
  const optional = (name: string, value: unknown) =>
    typeof value === "string" ? { [name]: value } : {}
  return {
    key: text(row.command_key),
    command: text(row.command),
    ...optional("effectiveCommand", row.effective_command),
    outcome: row.outcome as Proof["outcome"],
    exitCode: typeof row.exit_code === "number" ? row.exit_code : null,
    timedOut: Boolean(row.timed_out),
    durationMs: Number(row.duration_ms),
    ...optional("reason", row.reason),
    stdoutTail: text(row.stdout_tail),
    stderrTail: text(row.stderr_tail),
    ...optional("toolVersion", row.tool_version),
    ranAt: Number(row.ran_at),
  }
}

/**
 * A `projects.revisions` row (with its `payload` and `map_preview` when read at `window: 1`) and
 * its proofs as the revision the old profile read returned. A payload that no longer parses reads
 * as no revision, as the store reads it.
 */
export function revisionViewOf(row: Row, proofs: readonly Row[]): ProfileRevisionView | undefined {
  let profile: ProjectProfile | undefined
  if (row.payload !== undefined) {
    const parsed = parseProfile(row.payload)
    if (!parsed.ok) return undefined
    profile = parsed.profile
  }
  const map = row.map_preview
  return {
    revision: Number(row.revision),
    state: row.state === "active" ? "active" : "superseded",
    profile,
    author:
      row.author_kind === "owner"
        ? { kind: "owner" }
        : { kind: "architect", sessionID: text(row.session_id) },
    reason: text(row.reason),
    createdAt: Number(row.created_at),
    ...(row.state === "superseded" && typeof row.decided_at === "number"
      ? { supersededAt: row.decided_at }
      : {}),
    proofs: proofs.map(proofViewOf),
    ...(map && typeof map === "object"
      ? { mapPreview: map as ProfileRevisionView["mapPreview"] }
      : {}),
    credentialLikeEnv: profile ? profile.env.filter(credentialLikeEnv) : [],
  }
}
