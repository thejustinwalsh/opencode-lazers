import { gitRun, isObjectID } from "./git.ts"

function sourceRef(integrationID: string, kind: "base" | "artifact"): string {
  return `refs/lazers/integration-sources/${integrationID}/${kind}`
}

async function retainCommit(directory: string, ref: string, commit: string): Promise<void> {
  if (!isObjectID(commit)) throw new Error("Integration source retention requires full commit IDs")
  const resolved = await gitRun(directory, ["rev-parse", "--verify", `${commit}^{commit}`])
  if (resolved.code !== 0 || resolved.stdout !== commit)
    throw new Error(`Integration source commit is unavailable: ${commit}`)

  const retained = await gitRun(directory, ["update-ref", ref, commit, ""])
  if (retained.code === 0) return
  const existing = await gitRun(directory, ["rev-parse", "--verify", `${ref}^{commit}`])
  if (existing.code !== 0 || existing.stdout !== commit)
    throw new Error(`Could not retain integration source ${commit}: ${retained.stderr}`)
}

/** Keep the original attempt comparison's Git objects reachable through cleanup and GC. */
export async function retainIntegrationSource(
  directory: string,
  integrationID: string,
  base: string,
  artifact: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(integrationID))
    throw new Error("Integration source retention requires a generated integration ID")
  await Promise.all([
    retainCommit(directory, sourceRef(integrationID, "base"), base),
    retainCommit(directory, sourceRef(integrationID, "artifact"), artifact),
  ])
}
