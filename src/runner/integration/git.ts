import { execFile } from "node:child_process"

export const CHANGE_NOTES_REF = "refs/notes/lazers"
export const MAX_CHANGE_RANGE_COMMITS = 2_000
const NOTES_NAME = "lazers"

const objectID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
export const isObjectID = (value: unknown): value is string =>
  typeof value === "string" && objectID.test(value)

export type Run = { code: number; stdout: string; stderr: string }

/**
 * Run git without throwing on a non-zero exit; callers interpret exit codes.
 * Uses `execFile` so nothing blocks the event loop.
 */
export function gitRun(directory: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "git",
        args,
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 127) : 0
          resolve({
            code,
            stdout: stdout.trimEnd(),
            stderr: (stderr || (error ? error.message : "")).trimEnd(),
          })
        },
      )
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    } catch (error) {
      // An unavailable directory or git binary is an observation failure, not a crash.
      resolve({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : "spawn failed",
      })
    }
  })
}

const run = gitRun

async function must(directory: string, args: string[], input?: string): Promise<string> {
  const result = await run(directory, args, input)
  if (result.code !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 2000)}`)
  return result.stdout
}

/** Tree OID of a commit (or tree-ish); undefined when it does not resolve. */
export async function treeOf(directory: string, commit: string): Promise<string | undefined> {
  const result = await run(directory, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`])
  return result.code === 0 && isObjectID(result.stdout) ? result.stdout : undefined
}

export async function commitResolves(directory: string, commit: string): Promise<boolean> {
  const result = await run(directory, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  return result.code === 0 && isObjectID(result.stdout)
}

/** Normal non-ancestor is `false`; an unreadable repository throws. */
export async function isAncestorAsync(
  directory: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(directory, ["merge-base", "--is-ancestor", ancestor, descendant])
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.slice(0, 500)}`)
}

export function parsePatchIDs(output: string): Array<{ patchId: string; commit: string }> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && isObjectID(parts[1]))
    .map(([patchId, commit]) => ({ patchId: patchId!, commit: commit! }))
}

/** Stable patch-id of a diff, or undefined for an empty diff. */
export async function combinedPatchID(directory: string, from: string, to: string) {
  const diff = await run(directory, ["diff", "--no-color", "--no-ext-diff", `${from}..${to}`])
  if (diff.code !== 0 || !diff.stdout) return undefined
  const result = await run(directory, ["patch-id", "--stable"], `${diff.stdout}\n`)
  return result.code === 0 ? result.stdout.split(/\s+/)[0] || undefined : undefined
}

export type PatchIdentity = {
  /** `git diff base..head | git patch-id --stable`; undefined for an empty diff. */
  combined: string | undefined
  /** Per-commit patch-ids of the non-merge commits in `base..head`, oldest first. */
  commits: string[]
}

export async function patchIdOf(
  directory: string,
  base: string,
  head: string,
): Promise<PatchIdentity> {
  const combined = await combinedPatchID(directory, base, head)
  const log = await run(directory, [
    "log",
    "-p",
    "--no-merges",
    "--reverse",
    "--no-color",
    "--no-ext-diff",
    "-n",
    String(MAX_CHANGE_RANGE_COMMITS),
    `${base}..${head}`,
  ])
  const commits =
    log.code === 0 && log.stdout
      ? parsePatchIDs(
          (await run(directory, ["patch-id", "--stable"], `${log.stdout}\n`)).stdout,
        ).map((entry) => entry.patchId)
      : []
  return { combined, commits }
}

export type ChangeNote = { changeId: string; taskId?: string; attemptId?: string }

function formatChangeNote(note: ChangeNote): string {
  return [
    `change: ${note.changeId}`,
    ...(note.taskId ? [`task: ${note.taskId}`] : []),
    ...(note.attemptId ? [`attempt: ${note.attemptId}`] : []),
  ].join("\n")
}

function parseChangeNote(body: string): ChangeNote | undefined {
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, "m").exec(body)?.[1]
  const changeId = field("change")
  return changeId ? { changeId, taskId: field("task"), attemptId: field("attempt") } : undefined
}

/** Read a change id from a note body returned by `git log --notes`. */
export function changeIDFromNote(body: string): string | undefined {
  return parseChangeNote(body)?.changeId
}

/** Write the note on a commit. Returns false when the note could not be recorded; fallbacks still apply. */
export async function writeChangeNote(
  directory: string,
  commit: string,
  note: ChangeNote,
): Promise<boolean> {
  // Parallel worktrees share one notes ref, so a lock collision is retried.
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await run(directory, [
      "notes",
      `--ref=${NOTES_NAME}`,
      "add",
      "-f",
      "-m",
      formatChangeNote(note),
      commit,
    ])
    if (result.code === 0) return true
    if (!/lock|exist/i.test(result.stderr)) return false
    await Bun.sleep(25 * (attempt + 1))
  }
  return false
}

export async function readChangeNote(
  directory: string,
  commit: string,
): Promise<ChangeNote | undefined> {
  const result = await run(directory, ["notes", `--ref=${NOTES_NAME}`, "show", commit])
  return result.code === 0 ? parseChangeNote(result.stdout) : undefined
}

async function configValues(directory: string, key: string): Promise<string[]> {
  const result = await run(directory, ["config", "--local", "--get-all", key])
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : []
}

async function ensureConfigValue(directory: string, key: string, value: string) {
  if ((await configValues(directory, key)).includes(value)) return
  await must(directory, ["config", "--local", "--add", key, value])
}

/**
 * Idempotent repo-local notes plumbing: carry notes through amend and rebase,
 * and fetch them with the remote. Push behavior is never configured here: a bare
 * `git push` behaves as the user set it; use `pushChangeNotes` explicitly.
 */
export async function ensureNotesConfig(directory: string, remote = "origin"): Promise<void> {
  await ensureConfigValue(directory, "notes.rewriteRef", CHANGE_NOTES_REF)
  const remotes = (await run(directory, ["remote"])).stdout.split("\n").filter(Boolean)
  if (!remotes.includes(remote)) return
  await ensureConfigValue(directory, `remote.${remote}.fetch`, "+refs/notes/*:refs/notes/*")
}

/** Push the notes ref to `remote`. Never throws; false means the push did not happen. */
export async function pushChangeNotes(directory: string, remote = "origin"): Promise<boolean> {
  const result = await run(directory, ["push", remote, `${CHANGE_NOTES_REF}:${CHANGE_NOTES_REF}`])
  return result.code === 0
}
