import { gitRun, isObjectID } from "./git.ts"

export function localTargetRef(branch: string): string {
  return `refs/heads/${branch}`
}

export async function resolveLocalTargetHead(directory: string, branch: string): Promise<string> {
  const valid = await gitRun(directory, ["check-ref-format", "--branch", branch])
  if (valid.code !== 0) throw new Error(`Invalid integration target branch: ${branch}`)

  const result = await gitRun(directory, [
    "rev-parse",
    "--verify",
    `${localTargetRef(branch)}^{commit}`,
  ])
  if (result.code !== 0 || !isObjectID(result.stdout))
    throw new Error(`Integration target branch is unavailable: ${branch}`)
  return result.stdout
}
