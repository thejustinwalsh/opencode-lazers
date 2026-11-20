import type { Database } from "bun:sqlite"
import { fingerprint } from "../identity.ts"
import { schemaModules } from "../database-schema.ts"
import { lifecycleTransition } from "../runner/lifecycle-machines.ts"
import type { TaskRepository } from "../storage.ts"
import type { ProfileRevisionEvent, ProfileRevisionState } from "./profile-machine.ts"
import { parseProfile, type ProjectProfile } from "./profile.ts"
import { projectKeyOfDirectory } from "./settings.ts"

/**
 * Append-only profile revisions, following the Fallow config store (`src/audit/config.ts`).
 * A revision's payload and fingerprint never change; only its state and decision columns do,
 * and only through the `profileRevision` machine. The runtime reads only the latest confirmed
 * revision (`activeProfile`) or a pinned confirmed one (`profileRevisionByID`); a proposal, a
 * discarded revision or a payload that no longer parses reads as no profile.
 */
export type ProofOutcome = "proven" | "failed" | "not-run"
export type ProofRecord = {
  /** `install:<n>`, `verify:<id>`, `fix:<index>` or `tool:<toolchain>`. */
  key: string
  command: string
  effectiveCommand?: string
  outcome: ProofOutcome
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  reason?: string
  /** The last 4,096 bytes. */
  stdoutTail: string
  stderrTail: string
  toolVersion?: string
  ranAt: number
}
export type MapPreview = {
  files: number
  names: number
  tokens: number
  largestFolders: { folder: string; files: number }[]
  currentFiles: number
  currentTokens: number
}
export type RevisionAuthor =
  { kind: "architect"; sessionID: string; agent: string } | { kind: "owner" }
export type ProfileRevisionRow = {
  id: number
  projectKey: string
  revision: number
  state: ProfileRevisionState
  profile: ProjectProfile
  sha256: string
  author: RevisionAuthor
  reason: string
  proofs: ProofRecord[]
  mapPreview?: MapPreview
  createdAt: number
  decidedAt?: number
  decidedBy?: string
}
export type ActiveProfile = {
  revisionID: number
  revision: number
  projectKey: string
  profile: ProjectProfile
  confirmedAt: number
  proofs: ReadonlyMap<string, ProofRecord>
}

export class ProfileStoreError extends Error {
  constructor(
    readonly code: "PROFILE_REVISION_NOT_PENDING" | "PROFILE_REVISION_MISSING" | "PROFILE_INVALID",
    message: string,
  ) {
    super(message)
    this.name = "ProfileStoreError"
  }
}

type Reader = Pick<TaskRepository, "read">
const TAIL_BYTES = 4096

export function installProfileSchema(repository: TaskRepository): void {
  const module = schemaModules["project-profile"]
  repository.installSchema("project-profile", module.generation, module.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lazers_profile_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','discarded')),
        payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        author_kind TEXT NOT NULL CHECK(author_kind IN ('architect','owner')),
        session_id TEXT, agent TEXT, reason TEXT NOT NULL, map_preview TEXT,
        created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT,
        UNIQUE(project_key, revision));
      CREATE INDEX IF NOT EXISTS lazers_profile_revisions_key
        ON lazers_profile_revisions(project_key, state, revision);
      CREATE TABLE IF NOT EXISTS lazers_profile_proofs (
        revision_id INTEGER NOT NULL, command_key TEXT NOT NULL, command TEXT NOT NULL,
        effective_command TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('proven','failed','not-run')),
        exit_code INTEGER, timed_out INTEGER NOT NULL, duration_ms INTEGER NOT NULL, reason TEXT,
        stdout_tail TEXT NOT NULL, stderr_tail TEXT NOT NULL, tool_version TEXT, ran_at INTEGER NOT NULL,
        PRIMARY KEY(revision_id, command_key));
      CREATE TABLE IF NOT EXISTS lazers_profile_pins (
        scope TEXT PRIMARY KEY, revision_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `)
  })
}

type RevisionSql = {
  id: number
  project_key: string
  revision: number
  state: ProfileRevisionState
  payload: string
  sha256: string
  author_kind: "architect" | "owner"
  session_id: string | null
  agent: string | null
  reason: string
  map_preview: string | null
  created_at: number
  decided_at: number | null
  decided_by: string | null
}
type ProofSql = {
  command_key: string
  command: string
  effective_command: string | null
  outcome: ProofOutcome
  exit_code: number | null
  timed_out: number
  duration_ms: number
  reason: string | null
  stdout_tail: string
  stderr_tail: string
  tool_version: string | null
  ran_at: number
}

const tail = (text: string) => {
  const bytes = Buffer.from(text)
  return bytes.length <= TAIL_BYTES ? text : bytes.subarray(bytes.length - TAIL_BYTES).toString()
}

function proofsOf(db: Database, revisionID: number): ProofRecord[] {
  return db
    .query<ProofSql, [number]>(
      `SELECT command_key,command,effective_command,outcome,exit_code,timed_out,duration_ms,reason,
              stdout_tail,stderr_tail,tool_version,ran_at
       FROM lazers_profile_proofs WHERE revision_id=? ORDER BY rowid`,
    )
    .all(revisionID)
    .map((row) => ({
      key: row.command_key,
      command: row.command,
      ...(row.effective_command === null ? {} : { effectiveCommand: row.effective_command }),
      outcome: row.outcome,
      exitCode: row.exit_code,
      timedOut: row.timed_out === 1,
      durationMs: row.duration_ms,
      ...(row.reason === null ? {} : { reason: row.reason }),
      stdoutTail: row.stdout_tail,
      stderrTail: row.stderr_tail,
      ...(row.tool_version === null ? {} : { toolVersion: row.tool_version }),
      ranAt: row.ran_at,
    }))
}

/** A stored row as a revision; undefined when its payload no longer parses as a profile. */
function toRevision(db: Database, row: RevisionSql): ProfileRevisionRow | undefined {
  let parsed: ReturnType<typeof parseProfile>
  try {
    parsed = parseProfile(JSON.parse(row.payload))
  } catch {
    return undefined
  }
  if (!parsed.ok) return undefined
  let mapPreview: MapPreview | undefined
  if (row.map_preview !== null) {
    try {
      mapPreview = JSON.parse(row.map_preview) as MapPreview
    } catch {
      mapPreview = undefined
    }
  }
  return {
    id: row.id,
    projectKey: row.project_key,
    revision: row.revision,
    state: row.state,
    profile: parsed.profile,
    sha256: row.sha256,
    author:
      row.author_kind === "owner"
        ? { kind: "owner" }
        : { kind: "architect", sessionID: row.session_id ?? "", agent: row.agent ?? "" },
    reason: row.reason,
    proofs: proofsOf(db, row.id),
    ...(mapPreview ? { mapPreview } : {}),
    createdAt: row.created_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
  }
}

const COLUMNS = `id,project_key,revision,state,payload,sha256,author_kind,session_id,agent,reason,
  map_preview,created_at,decided_at,decided_by`

function transitionState(
  db: Database,
  row: Pick<RevisionSql, "id" | "state">,
  event: ProfileRevisionEvent,
  by: string,
): void {
  const next = lifecycleTransition("profile", row.state, event)
  db.query("UPDATE lazers_profile_revisions SET state=?,decided_at=?,decided_by=? WHERE id=?").run(
    next,
    Date.now(),
    by,
    row.id,
  )
}

/** Stores a new pending revision; a still-pending older proposal is replaced by it. */
export function proposeRevision(
  repository: TaskRepository,
  input: {
    projectKey: string
    profile: ProjectProfile
    author: RevisionAuthor
    reason: string
    proofs: ProofRecord[]
    mapPreview?: MapPreview
  },
): ProfileRevisionRow {
  const parsed = parseProfile(input.profile)
  if (!parsed.ok)
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    )
  const profile = parsed.profile
  return repository.atomic((db) => {
    for (const pending of db
      .query<RevisionSql, [string]>(
        `SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE project_key=? AND state='proposed'`,
      )
      .all(input.projectKey))
      transitionState(db, pending, "REPLACED", "replaced")
    const revision =
      (db
        .query<{ latest: number | null }, [string]>(
          "SELECT MAX(revision) AS latest FROM lazers_profile_revisions WHERE project_key=?",
        )
        .get(input.projectKey)?.latest ?? 0) + 1
    const now = Date.now()
    const architect = input.author.kind === "architect" ? input.author : undefined
    const id = Number(
      db
        .query(
          `INSERT INTO lazers_profile_revisions(project_key,revision,state,payload,sha256,author_kind,
             session_id,agent,reason,map_preview,created_at)
           VALUES(?,?,'proposed',?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.projectKey,
          revision,
          JSON.stringify(profile),
          fingerprint(profile),
          input.author.kind,
          architect?.sessionID ?? null,
          architect?.agent ?? null,
          input.reason,
          input.mapPreview ? JSON.stringify(input.mapPreview) : null,
          now,
        ).lastInsertRowid,
    )
    for (const proof of input.proofs)
      db.query(
        `INSERT INTO lazers_profile_proofs(revision_id,command_key,command,effective_command,outcome,
           exit_code,timed_out,duration_ms,reason,stdout_tail,stderr_tail,tool_version,ran_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        proof.key,
        proof.command,
        proof.effectiveCommand ?? null,
        proof.outcome,
        proof.exitCode,
        proof.timedOut ? 1 : 0,
        proof.durationMs,
        proof.reason ?? null,
        tail(proof.stdoutTail),
        tail(proof.stderrTail),
        proof.toolVersion ?? null,
        proof.ranAt,
      )
    const row = db
      .query<RevisionSql, [number]>(`SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE id=?`)
      .get(id)!
    return toRevision(db, row)!
  })
}

function decide(
  repository: TaskRepository,
  input: { projectKey: string; revision: number; by: string },
  event: "OWNER_CONFIRMED" | "OWNER_DISCARDED",
  onConfirmed?: (db: Database, row: ProfileRevisionRow) => void,
): ProfileRevisionRow {
  return repository.atomic((db) => {
    const row = db
      .query<RevisionSql, [string, number]>(
        `SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE project_key=? AND revision=?`,
      )
      .get(input.projectKey, input.revision)
    if (!row)
      throw new ProfileStoreError(
        "PROFILE_REVISION_MISSING",
        `No profile revision ${input.revision} for this project`,
      )
    if (row.state !== "proposed")
      throw new ProfileStoreError(
        "PROFILE_REVISION_NOT_PENDING",
        `Profile revision ${input.revision} is ${row.state}, not pending`,
      )
    transitionState(db, row, event, input.by)
    const decided = toRevision(
      db,
      db
        .query<RevisionSql, [number]>(`SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE id=?`)
        .get(row.id)!,
    )
    if (!decided)
      throw new ProfileStoreError("PROFILE_INVALID", "The stored revision no longer parses")
    onConfirmed?.(db, decided)
    return decided
  })
}

export function confirmRevision(
  repository: TaskRepository,
  input: {
    projectKey: string
    revision: number
    by: string
    /** Runs inside the confirming transaction (Task 5.1 drops the legacy source rows here). */
    onConfirmed?: (db: Database, row: ProfileRevisionRow) => void
  },
): ProfileRevisionRow {
  return decide(repository, input, "OWNER_CONFIRMED", input.onConfirmed)
}

export function discardRevision(
  repository: TaskRepository,
  input: { projectKey: string; revision: number; by: string },
): ProfileRevisionRow {
  return decide(repository, input, "OWNER_DISCARDED")
}

/** Every revision whose payload still parses, newest first. */
export function profileRevisions(repository: Reader, projectKey: string): ProfileRevisionRow[] {
  return repository.read((db) =>
    db
      .query<RevisionSql, [string]>(
        `SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE project_key=? ORDER BY revision DESC`,
      )
      .all(projectKey)
      .flatMap((row) => toRevision(db, row) ?? []),
  )
}

export function pendingRevision(
  repository: Reader,
  projectKey: string,
): ProfileRevisionRow | undefined {
  return repository.read((db) => {
    const row = db
      .query<RevisionSql, [string]>(
        `SELECT ${COLUMNS} FROM lazers_profile_revisions
         WHERE project_key=? AND state='proposed' ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectKey)
    return row ? toRevision(db, row) : undefined
  })
}

function activeOf(db: Database, row: RevisionSql | null | undefined): ActiveProfile | undefined {
  if (!row) return undefined
  const revision = toRevision(db, row)
  if (!revision) return undefined
  return {
    revisionID: revision.id,
    revision: revision.revision,
    projectKey: revision.projectKey,
    profile: revision.profile,
    confirmedAt: revision.decidedAt ?? revision.createdAt,
    proofs: new Map(revision.proofs.map((proof) => [proof.key, proof])),
  }
}

/** The latest confirmed revision of a project; a corrupt one reads as no profile. */
export function activeProfileForKey(
  repository: Reader,
  projectKey: string,
): ActiveProfile | undefined {
  return repository.read((db) =>
    activeOf(
      db,
      db
        .query<RevisionSql, [string]>(
          `SELECT ${COLUMNS} FROM lazers_profile_revisions
           WHERE project_key=? AND state='confirmed' ORDER BY revision DESC LIMIT 1`,
        )
        .get(projectKey),
    ),
  )
}

/** The latest confirmed revision of the project a checkout directory belongs to. */
export function activeProfile(
  repository: Reader,
  projectDirectory: string,
): ActiveProfile | undefined {
  const key = projectKeyOfDirectory(repository, projectDirectory)
  return key === undefined ? undefined : activeProfileForKey(repository, key)
}

/** A confirmed revision by id, so an unattended run keeps the revision it started with. */
export function profileRevisionByID(repository: Reader, id: number): ActiveProfile | undefined {
  return repository.read((db) =>
    activeOf(
      db,
      db
        .query<RevisionSql, [number]>(
          `SELECT ${COLUMNS} FROM lazers_profile_revisions WHERE id=? AND state='confirmed'`,
        )
        .get(id),
    ),
  )
}

/**
 * The revision an unattended run was started with, recorded once per scope (for example
 * `retained:<operation id>`) so a restart resumes with it and not with whatever is active then.
 * `0` records that the run started with no profile. Returns the recorded value, or undefined.
 */
export function pinnedProfileRevision(repository: Reader, scope: string): number | undefined {
  return repository.read(
    (db) =>
      db
        .query<{ revision_id: number }, [string]>(
          "SELECT revision_id FROM lazers_profile_pins WHERE scope=?",
        )
        .get(scope)?.revision_id,
  )
}

/** Records the pin; an earlier pin of the same scope is kept. */
export function pinProfileRevision(
  repository: Pick<TaskRepository, "atomic">,
  scope: string,
  revisionID: number,
): void {
  repository.atomic((db) =>
    db
      .query(
        "INSERT OR IGNORE INTO lazers_profile_pins(scope,revision_id,created_at) VALUES(?,?,?)",
      )
      .run(scope, revisionID, Date.now()),
  )
}
