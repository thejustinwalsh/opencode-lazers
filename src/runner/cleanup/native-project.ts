import type { NativeInboxClient } from "../native.ts"
import type { RunnerHost } from "../host.ts"
import { isWorkerAgent } from "../worker-agent.ts"
import { sameCanonicalProjectDirectory } from "./canonical-ownership.ts"

type NativeWorkerSession = Awaited<ReturnType<NativeInboxClient["session"]["get"]>>
type NativeWorkerLineage = {
  activeRoot: boolean
  activeDescendants: string[]
  activeAtWorkspace: string[]
}
type NativeWorkerActivity = {
  active: boolean
  pendingInput: boolean
  locationPendingForms: number
  locationPendingPermissions: number
  runningShells: number
}
type IntegratedWorkerRetirement = Parameters<NonNullable<RunnerHost["retireIntegratedWorker"]>>[0]

/** Resolve only a unique native project record, including archived identities. */
export async function projectCanonicalDirectory(client: NativeInboxClient, projectID: string) {
  if (typeof client.project?.list !== "function")
    throw new Error("Native project identity inventory is unavailable")
  const projects = await client.project.list({ archived: true })
  if (!Array.isArray(projects)) throw new Error("Native project identity inventory is unavailable")
  const matches = projects.filter((project) => project.id === projectID)
  if (matches.length !== 1 || typeof matches[0]?.canonical !== "string") return undefined
  return matches[0].canonical
}

/** Confirm a native session's project ID still resolves to this repository. */
export async function nativeProjectMatches(
  client: NativeInboxClient,
  expectedDirectory: string,
  expectedProjectID: string,
  observedProjectID: string,
) {
  if (expectedProjectID === observedProjectID) return true
  const observedDirectory = await projectCanonicalDirectory(client, observedProjectID)
  return sameCanonicalProjectDirectory(expectedDirectory, observedDirectory)
}

function nativeWorkerBindingMatches(
  session: NativeWorkerSession,
  input: IntegratedWorkerRetirement,
  projectMatches: boolean,
) {
  return (
    session.id === input.sessionID &&
    projectMatches &&
    session.location.directory === input.workspace &&
    session.metadata?.lazersAttemptID === input.attemptID
  )
}

function nativeWorkerIsIdle(session: NativeWorkerSession, after: NativeWorkerSession) {
  if (!session.outcome || !session.time.idle) return false
  return (
    isWorkerAgent(session.agent) &&
    (session.time.busy ?? 0) < session.time.idle &&
    JSON.stringify(session) === JSON.stringify(after)
  )
}

export function nativeWorkerIdentityMatches(
  session: NativeWorkerSession,
  input: IntegratedWorkerRetirement,
  after: NativeWorkerSession,
  projectMatches: boolean,
) {
  return (
    nativeWorkerBindingMatches(session, input, projectMatches) && nativeWorkerIsIdle(session, after)
  )
}

export function nativeWorkerHasUnsettledActivity(
  active: NativeWorkerLineage,
  inventory: NativeWorkerActivity,
) {
  return (
    active.activeRoot ||
    active.activeDescendants.length > 0 ||
    active.activeAtWorkspace.length > 0 ||
    inventory.active ||
    inventory.pendingInput ||
    inventory.locationPendingForms ||
    inventory.locationPendingPermissions ||
    inventory.runningShells
  )
}
