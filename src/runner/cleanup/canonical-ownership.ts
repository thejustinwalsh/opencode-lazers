import { realpathSync } from "node:fs"
import { isAbsolute } from "node:path"

/** Compare existing canonical project roots; unavailable paths never establish ownership. */
export function sameCanonicalProjectDirectory(expected: string, observed: string | undefined) {
  if (!observed || !isAbsolute(expected) || !isAbsolute(observed)) return false
  try {
    return realpathSync(expected) === realpathSync(observed)
  } catch {
    return false
  }
}

export type CleanupWorkerOwnership = {
  expectedProjectID: string
  observedProjectID: string
  expectedProjectDirectory: string
  observedProjectDirectory: string | undefined
  attemptProjectDirectory: string | undefined
  expectedSessionID: string
  observedSessionID: string
  expectedAttemptID: string
  effectAttemptID: string | null
  observedAttemptID: unknown
  expectedWorkspace: string
  attemptWorkspace: string
  observedWorkspace: string
}

function workerBindingBlockers(input: CleanupWorkerOwnership) {
  const blockers: string[] = []
  if (input.expectedSessionID !== input.observedSessionID) blockers.push("session identity changed")
  if (
    input.expectedAttemptID !== input.observedAttemptID ||
    input.expectedAttemptID !== input.effectAttemptID
  )
    blockers.push("attempt ownership changed")
  if (
    input.expectedWorkspace !== input.attemptWorkspace ||
    input.expectedWorkspace !== input.observedWorkspace
  )
    blockers.push("worker location changed")
  return blockers
}

function canonicalProjectMatches(input: CleanupWorkerOwnership) {
  return (
    input.expectedProjectID === input.observedProjectID ||
    (sameCanonicalProjectDirectory(input.expectedProjectDirectory, input.attemptProjectDirectory) &&
      sameCanonicalProjectDirectory(input.expectedProjectDirectory, input.observedProjectDirectory))
  )
}

/** Explain which worker binding or canonical project proof prevents cleanup. */
export async function cleanupWorkerOwnershipBlockers(
  input: CleanupWorkerOwnership & {
    nativeProjectCanonicalDirectory?: (projectID: string) => Promise<string | undefined>
  },
) {
  const blockers = workerBindingBlockers(input)
  if (blockers.length) return blockers
  if (input.expectedProjectID === input.observedProjectID) return blockers
  const observedProjectDirectory = await input.nativeProjectCanonicalDirectory?.(
    input.observedProjectID,
  )
  if (
    !sameCanonicalProjectDirectory(input.expectedProjectDirectory, input.attemptProjectDirectory) ||
    !sameCanonicalProjectDirectory(input.expectedProjectDirectory, observedProjectDirectory)
  )
    blockers.push("project identity changed or could not be verified")
  return blockers
}

/**
 * A changed native project ID is acceptable only when exact durable worker
 * ownership and the native project's canonical repository all still agree.
 */
export function cleanupWorkerOwnershipMatches(input: CleanupWorkerOwnership) {
  return workerBindingBlockers(input).length === 0 && canonicalProjectMatches(input)
}
