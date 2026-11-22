/** Keep the host's canonical preference key separate from its native project identity. */
export function radarProjectIdentity(project: { id: string; canonical: string }) {
  return { project: project.canonical, projectID: project.id }
}

type ProjectRecord = { id: string; canonical: string; sandboxes?: readonly string[] }

/** Observation must never boot a worktree location: it is reachable only while loaded. */
export type LoadedLocations = {
  debug?: { location?: { list?: () => Promise<readonly { directory: string }[]> } }
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path)

/**
 * True only when the host reports the directory as a loaded location. A host
 * that cannot list loaded locations cannot prove it, so it is treated as not loaded.
 */
export async function isRadarLocationLoaded(
  client: LoadedLocations,
  directory: string,
): Promise<boolean> {
  const location = client.debug?.location
  if (typeof location?.list !== "function") return false
  const loaded = await location.list()
  return loaded.some((entry) => trimSlash(entry.directory) === trimSlash(directory))
}

/**
 * Identify the project of a session directory by path against the global project
 * list: the canonical checkout, a registered sandbox, or `<canonical>.worktrees/…`.
 * `project.list` is not location-scoped, so this cannot boot a location.
 */
export function matchRadarProject<T extends ProjectRecord>(
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

/** Resolve project identity without any location-scoped host call. */
export async function resolveRadarProject(
  client: {
    project: {
      list(input?: undefined, options?: { signal?: AbortSignal }): Promise<readonly ProjectRecord[]>
    }
  },
  directory: string,
  signal: AbortSignal,
) {
  const project = matchRadarProject(await client.project.list(undefined, { signal }), directory)
  if (!project) throw new Error(`No known OpenCode project owns ${directory}.`)
  return radarProjectIdentity(project)
}

/**
 * The location guard for a Radar transport. The directory of the session the
 * user is viewing is necessarily loaded, so it is never asked about (and a GUI
 * client without `debug` cannot block it). Any other directory must be proven
 * loaded; "cannot tell" or a failed listing fails closed so it is never booted.
 */
export function radarLocationGuard(
  client: LoadedLocations,
  directory: string,
  viewedDirectory: () => string | undefined,
): () => Promise<boolean> {
  return async () => {
    const viewed = viewedDirectory()
    if (viewed !== undefined && trimSlash(viewed) === trimSlash(directory)) return true
    try {
      return await isRadarLocationLoaded(client, directory)
    } catch {
      return false
    }
  }
}
