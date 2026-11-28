type ProjectRecord = { id: string; canonical: string; sandboxes?: readonly string[] }
const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path)

export function panelProjectIdentity(project: { id: string; canonical: string }) {
  return { project: project.canonical, projectID: project.id }
}

export function matchPanelProject<T extends ProjectRecord>(
  projects: readonly T[],
  directory: string,
): T | undefined {
  const target = trimSlash(directory)
  let best: { project: T; length: number } | undefined
  for (const project of projects) {
    const canonical = trimSlash(project.canonical)
    const owned =
      target === canonical ||
      target.startsWith(`${canonical}.worktrees/`) ||
      (project.sandboxes ?? []).some((sandbox) => trimSlash(sandbox) === target)
    if (owned && (!best || canonical.length > best.length))
      best = { project, length: canonical.length }
  }
  return best?.project
}

/** Durable project identity does not require the viewed worker's checkout to still exist. */
export async function resolvePanelProject(
  client: {
    project: {
      list(input?: undefined, options?: { signal?: AbortSignal }): Promise<readonly ProjectRecord[]>
    }
    session?: {
      get(
        input: { sessionID: string },
        options?: { signal?: AbortSignal },
      ): Promise<{ projectID: string }>
    }
  },
  directory: string,
  signal: AbortSignal,
  sessionID?: string,
) {
  const projects = await client.project.list(undefined, { signal })
  let project = matchPanelProject(projects, directory)
  if (!project && sessionID && client.session) {
    const session = await client.session.get({ sessionID }, { signal })
    project = projects.find((candidate) => candidate.id === session.projectID)
  }
  if (!project) throw new Error(`No known OpenCode project owns ${directory}.`)
  return panelProjectIdentity(project)
}
