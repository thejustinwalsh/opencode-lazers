import type { Stats } from "node:fs"
import { stageCandidateDependencies } from "./dependency-staging.ts"
import type { RetainedCheckProfile, RetainedDependencyInstaller } from "./isolation.ts"

/** Run proven profile installs while journaling any private node_modules tree they create. */
export async function installProfileDependencies(input: {
  profile: RetainedCheckProfile
  candidateWorkspace: string
  candidateDependencies: string
  candidateManifest: boolean
  ownedDependencies: string
  environment: Record<string, string>
  signal: AbortSignal
  dependencyInstaller?: RetainedDependencyInstaller
  defaultInstaller: RetainedDependencyInstaller
  observeDependencyInstall: () => Stats | undefined
  assertNotCancelled: () => void
  onDependencyInstallReserved?: (path: string) => void
  onDependencyInstallCreated?: (resource: {
    path: string
    realPath: string
    device: number
    inode: number
  }) => void
  onDependencyInstallRemoved?: (path: string) => void
}): Promise<void> {
  const install = input.dependencyInstaller ?? input.defaultInstaller
  let reserved = false
  try {
    for (const entry of input.profile.installs) {
      if (entry.source === "none") continue
      if (input.candidateManifest && !reserved) {
        input.onDependencyInstallReserved?.(input.candidateDependencies)
        reserved = true
      }
      await install({
        candidateWorkspace: input.candidateWorkspace,
        environment: input.environment,
        signal: input.signal,
        command: entry.source === "profile" ? ["/bin/sh", "-c", entry.command] : entry.argv,
      })
    }
  } catch (error) {
    if (reserved) input.observeDependencyInstall()
    throw error
  }
  if (!reserved) return

  const written = input.observeDependencyInstall()
  input.assertNotCancelled()
  if (written) {
    if (written.isSymbolicLink() || !written.isDirectory())
      throw new Error("Candidate dependency install left an unexpected node_modules entry")
    stageCandidateDependencies(input.candidateDependencies, input.ownedDependencies)
  }
  input.onDependencyInstallRemoved?.(input.candidateDependencies)
  input.assertNotCancelled()
}
