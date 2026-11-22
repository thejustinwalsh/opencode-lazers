/**
 * How a stream's `authorize` reaches the decision views of its project without importing the
 * Models server: `registerModelsServer` registers an opener per project directory, and the Models
 * sources (`src/streams/sources/models.ts`, also loaded in reader workers) call it. It holds
 * closures only, on globalThis because every plugin copy has its own module scope.
 */
type Opener = {
  open(request: unknown): number
  release(viewID: number): void
  /** Read the agents' host routes again and store what changed (asynchronous, never awaited). */
  refreshHostAgents?(): void
}
const key = Symbol.for("lazers.models.decisionViewOpeners.v1")
const host = globalThis as typeof globalThis & { [key]?: Map<string, Opener[]> }
const openers = () => (host[key] ??= new Map())

/** Register `open` for a project; the newest live registration answers. Returns the release. */
export function registerDecisionViewOpener(projectDirectory: string, open: Opener) {
  const list = openers().get(projectDirectory) ?? []
  list.push(open)
  openers().set(projectDirectory, list)
  return () => {
    const at = list.indexOf(open)
    if (at >= 0) list.splice(at, 1)
    if (!list.length && openers().get(projectDirectory) === list) openers().delete(projectDirectory)
  }
}

/**
 * The stored view of `request` in this project, created when missing and its read recorded: a
 * point write on the main thread. The opener validates the request and starts its build.
 */
export function openDecisionViewFor(projectDirectory: string, request: unknown): number {
  const opener = openers().get(projectDirectory)?.at(-1)
  if (!opener) throw new Error("Models scope is unavailable")
  return opener.open(request)
}

/** A stream that `openDecisionViewFor` admitted no longer holds the view. */
export function releaseDecisionViewFor(projectDirectory: string, viewID: number) {
  openers().get(projectDirectory)?.at(-1)?.release(viewID)
}

/**
 * An assignments stream opened: the host's agent routes are read again in the background, as the
 * replaced `settings` read did on every open, and a changed route reaches the stream as a write.
 */
export function refreshHostAgentsFor(projectDirectory: string) {
  openers().get(projectDirectory)?.at(-1)?.refreshHostAgents?.()
}
